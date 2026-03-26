import axios from "axios";
import countries from "i18n-iso-countries";
import { createRequire } from "module";
import { config } from "../utils/config.js";
import { resolveSecretOrEnv } from "../utils/secretManager.js";
import type { MondayColumnValue } from "../services/mondayClient.js";
import type { FreightIntegration, IntegrationContext, IntegrationResult } from "./types.js";

const require = createRequire(import.meta.url);
const en = require("i18n-iso-countries/langs/en.json");
countries.registerLocale(en);

const COUNTRY_ALIASES: Record<string, string> = {
  romania: "RO",
  romaniaa: "RO",
  germania: "DE",
  germany: "DE",
  france: "FR",
  franta: "FR",
  italia: "IT",
  italy: "IT",
  spania: "ES",
  spain: "ES",
  bulgaria: "BG",
  hungary: "HU",
  ungaria: "HU",
  austria: "AT",
  poland: "PL",
  polonia: "PL",
  czechia: "CZ",
  "czech republic": "CZ",
  slovakia: "SK",
  slovenia: "SI",
  netherlands: "NL",
  olanda: "NL",
  belgium: "BE",
  belgia: "BE",
};

function normalize(input: string): string {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/ă/g, "a")
    .replace(/â/g, "a")
    .replace(/î/g, "i")
    .replace(/ș/g, "s")
    .replace(/ş/g, "s")
    .replace(/ț/g, "t")
    .replace(/ţ/g, "t");
}

function parseNumberLoose(value: string): number {
  const normalized = String(value ?? "").replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseDateFlexible(raw: string): Date | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) return date;
    return null;
  }

  const ro = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ro) {
    const d = Number(ro[1]);
    const m = Number(ro[2]);
    const y = Number(ro[3]);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) return date;
    return null;
  }

  return null;
}

function formatIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function todayIsoDate(): string {
  const now = new Date();
  return formatIsoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
}

function addDays(isoDate: string, days: number): string {
  const parsed = parseDateFlexible(isoDate);
  if (!parsed) return isoDate;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return formatIsoDate(parsed);
}

function extractIsoDateFromColumn(column: MondayColumnValue | undefined): string | null {
  if (!column) return null;

  if (column.value) {
    try {
      const parsed = JSON.parse(column.value);
      if (parsed?.date) {
        const date = parseDateFlexible(String(parsed.date));
        if (date) return formatIsoDate(date);
      }
    } catch {
      // ignore parse errors and fallback to text
    }
  }

  const text = String(column.text ?? "").trim();
  if (!text) return null;
  const date = parseDateFlexible(text);
  return date ? formatIsoDate(date) : null;
}

function getCountryCode(countryName: string): string {
  const raw = String(countryName ?? "").trim();
  if (!raw) {
    throw new Error("Țara este obligatorie pentru TIMOCOM.");
  }

  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();

  const normalized = normalize(raw);
  if (COUNTRY_ALIASES[normalized]) {
    return COUNTRY_ALIASES[normalized];
  }

  const fromLibrary = countries.getAlpha2Code(raw, "en");
  if (fromLibrary) return fromLibrary.toUpperCase();

  throw new Error(`Nu am putut mapa țara '${countryName}' la cod ISO-2.`);
}

function mapTruckBodyTypes(truckType: string): string[] {
  const value = normalize(truckType);
  if (!value) return ["CURTAIN_SIDER"];

  if (value.includes("prelata") || value.includes("curtain") || value.includes("tautliner")) {
    return ["CURTAIN_SIDER", "TAUTLINER"];
  }
  if (value.includes("box") || value.includes("duba") || value.includes("rigid")) return ["BOX"];
  if (value.includes("thermo")) return ["THERMO"];
  if (value.includes("frigo") || value.includes("reefer") || value.includes("refrigerator")) return ["REFRIGERATOR"];
  if (value.includes("basculanta") || value.includes("tipper") || value.includes("dump")) return ["DUMP_TRAILER"];
  if (value.includes("cisterna") || value.includes("tank")) return ["TANK"];
  if (value.includes("platforma") || value.includes("flatbed")) return ["FLATBED"];
  if (value.includes("autoturisme") || value.includes("car transporter") || value.includes("auto")) {
    return ["CAR_TRANSPORTER"];
  }

  return ["CURTAIN_SIDER"];
}

function colsMap(context: IntegrationContext): Record<string, MondayColumnValue> {
  return Object.fromEntries(context.item.column_values.map((column) => [column.id, column])) as Record<
    string,
    MondayColumnValue
  >;
}

function buildFreightDescription(itemName: string, occupancy: string): string {
  const parts = [itemName.trim() || "Oferta transport"];
  const occupancyLabel = normalize(occupancy);
  if (occupancyLabel === "complete ftl") {
    parts.push("Doresc transport dedicat (camion complet)");
  } else if (occupancyLabel === "groupage ltl") {
    parts.push("Grupaj (LTL)");
  }
  parts.push("La termen (60 zile)");
  return parts.join(" - ");
}

function buildPayload(context: IntegrationContext) {
  const cols = colsMap(context);

  const loadingCity = String(cols["text_mkypcczr"]?.text ?? "").trim();
  const loadingCountry = String(cols["dropdown_mkx6jyjf"]?.text ?? "").trim();
  const unloadingCity = String(cols["text_mkypxb8h"]?.text ?? "").trim();
  const unloadingCountry = String(cols["dropdown_mkx687jv"]?.text ?? "").trim();
  if (!loadingCity || !unloadingCity) {
    throw new Error("Localitățile de încărcare/descărcare sunt obligatorii.");
  }

  const loadingCountryCode = getCountryCode(loadingCountry);
  const unloadingCountryCode = getCountryCode(unloadingCountry);

  const loadingDate = extractIsoDateFromColumn(cols["date_mkx77z0m"]) || todayIsoDate();
  const unloadingDate = extractIsoDateFromColumn(cols["date_mkx74vt4"]) || addDays(loadingDate, 1);

  const weightKg = parseNumberLoose(String(cols["text_mkt9nr81"]?.text ?? "").trim());
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new Error("Greutatea (KG) este invalidă.");
  }
  const weight_t = Number((weightKg / 1000).toFixed(3));

  const truckType = String(cols["dropdown_mkx1s5nv"]?.text ?? "").trim();
  const body = mapTruckBodyTypes(truckType);

  const occupancy = String(cols["color_mkrb3hhk"]?.text ?? "").trim();
  const freightDescription = buildFreightDescription(context.item.name, occupancy);

  return {
    loading: {
      city: loadingCity,
      countryCode: loadingCountryCode,
    },
    unloading: {
      city: unloadingCity,
      countryCode: unloadingCountryCode,
    },
    earliestLoadingDate: loadingDate,
    latestLoadingDate: unloadingDate,
    weight_t,
    vehicleProperties: {
      body,
    },
    freightDescription,
    paymentDueWithinDays: 60,
    trackable: true,
  };
}

async function publishLoad(context: IntegrationContext): Promise<IntegrationResult> {
  const baseUrl = config.integrations.timocom.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    return { status: "error", message: "[TIMOCOM] TIMOCOM_BASE_URL nu este configurat." };
  }

  try {
    const token = await resolveSecretOrEnv({
      logicalName: "TIMOCOM_API_TOKEN",
      envValue: config.integrations.timocom.apiToken,
      secretRef: config.integrations.timocom.apiTokenSecret,
    });

    const payload = buildPayload(context);
    const url = `${baseUrl}/freight-exchange/3/freight-offers`;
    const response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/vnd.freight-exchange.v3+json",
        Accept: "application/vnd.freight-exchange.v3+json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.status === 200 || response.status === 201) {
      return { status: "success", message: "[TIMOCOM] Cursă publicată cu succes." };
    }

    return {
      status: "error",
      message: `[TIMOCOM] Publicarea a eșuat (HTTP ${response.status}).`,
    };
  } catch (error) {
    const err = error as {
      response?: { data?: { problem?: { detail?: string } } };
      message?: string;
    };
    const errorMessage = err.response?.data?.problem?.detail || err.message || "Eroare necunoscută";
    return { status: "error", message: `[TIMOCOM] ${errorMessage}` };
  }
}

async function removeLoad(_context: IntegrationContext): Promise<IntegrationResult> {
  return {
    status: "error",
    message: "[TIMOCOM] Funcția de stergere a ofertelor nu este încă implementată în API.",
  };
}

export const timocomIntegration: FreightIntegration = {
  name: "timocom",
  publishLoad,
  removeLoad,
};
