import axios from "axios";
import countries from "i18n-iso-countries";
import { createRequire } from "module";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import type { FreightIntegration, IntegrationContext, IntegrationResult } from "./types.js";
import type { MondayColumnValue } from "../services/mondayClient.js";

const require = createRequire(import.meta.url);
const en = require("i18n-iso-countries/langs/en.json");
countries.registerLocale(en);

type UserPick =
  | { ok: true; authHeader: string; ownerId: number }
  | { ok: false; error: string };

type LoadFlags = {
  adr: boolean;
  frigo: boolean;
  agabarit: boolean;
  slidingFloor: boolean;
};

type CargoTypeFlags = {
  hazardous: boolean;
  temperatureControlled: boolean;
  oversized: boolean;
  carTransport: boolean;
};

function normalizeRoLabel(s: string): string {
  return (s ?? "")
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

function parseNumberLoose(s: string): number {
  const n = Number(String(s ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : NaN;
}

function getFirstPersonIdFromPeopleValue(valueJson: string | null): number | null {
  if (!valueJson) return null;
  try {
    const parsed = JSON.parse(valueJson);
    const persons = parsed?.personsAndTeams;
    if (!Array.isArray(persons) || !persons.length) return null;
    return persons[0]?.id ?? null;
  } catch {
    return null;
  }
}

function buildBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function pickBasicAuthHeaderFromOwner(cols: Record<string, MondayColumnValue>): UserPick {
  if (config.auth.forceTestMode) {
    if (!config.auth.testUsername || !config.auth.testPassword) {
      return {
        ok: false,
        error: "FORCE_TEST_AUTH_MODE activ, dar lipsesc TEST_BURSA_USERNAME / TEST_BURSA_PASSWORD.",
      };
    }
    return {
      ok: true,
      ownerId: -1,
      authHeader: buildBasicAuthHeader(config.auth.testUsername, config.auth.testPassword),
    };
  }

  const principalId = getFirstPersonIdFromPeopleValue(cols[config.mondayColumns.dealOwner]?.value ?? null);
  const preluatDeId = getFirstPersonIdFromPeopleValue(cols[config.mondayColumns.preluatDe]?.value ?? null);
  const ownerId = principalId ?? preluatDeId;
  if (!ownerId) {
    return {
      ok: false,
      error: `Trebuie completat '${config.mondayColumns.dealOwner}' sau '${config.mondayColumns.preluatDe}'.`,
    };
  }

  const entry = config.auth.userMap[ownerId];
  if (!entry?.basicB64) {
    return { ok: false, error: `Owner userId not mapped: ${ownerId}` };
  }
  return { ok: true, ownerId, authHeader: `Basic ${entry.basicB64}` };
}

function getDateISOFromDateColumn(col: MondayColumnValue | undefined): string | null {
  if (!col) return null;
  if (col.value) {
    try {
      const parsed = JSON.parse(col.value);
      if (parsed?.date) return String(parsed.date);
    } catch {
      // ignore
    }
  }
  return (col.text ?? "").trim() || null;
}

function parseDateFlexible(raw: string): Date | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  let y = 0;
  let m = 0;
  let d = 0;

  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    const ro = t.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!ro) return null;
    d = Number(ro[1]);
    m = Number(ro[2]);
    y = Number(ro[3]);
  }

  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

function formatDateDdMmYyyy(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getUTCFullYear());
  return `${dd}-${mm}-${yyyy}`;
}

function toBursaDate(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = parseDateFlexible(raw);
  if (!parsed) return null;
  return formatDateDdMmYyyy(parsed);
}

function isWithin30DaysOfToday(rawDate: string): boolean {
  const date = parseDateFlexible(rawDate);
  if (!date) return false;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffDays = Math.abs((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays <= 30;
}

function normalizeCountry2LetterEnglish(input: string): string | null {
  const t = (input ?? "").trim();
  if (!t) return null;
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  const iso2 = countries.getAlpha2Code(t, "en");
  return iso2 ? iso2.toUpperCase() : null;
}

function normalizeCurrency3(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  const norm = normalizeRoLabel(raw);
  const map: Record<string, string> = {
    euro: "EUR",
    eur: "EUR",
    lei: "RON",
    ron: "RON",
    usd: "USD",
    dollar: "USD",
    dollars: "USD",
  };
  return map[norm] ?? null;
}

function stripRightSideAfterSlash(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t.includes("/")) return t;
  return t.split("/").pop()!.trim();
}

const TRUCK_TYPE_MAP: Record<string, { code: number; apiName: string }> = {
  duba: { code: 1, apiName: "Box" },
  box: { code: 1, apiName: "Box" },
  prelata: { code: 2, apiName: "Tilt" },
  tilt: { code: 2, apiName: "Tilt" },
  platforma: { code: 3, apiName: "Flat" },
  flat: { code: 3, apiName: "Flat" },
  basculanta: { code: 5, apiName: "Tipper" },
  tipper: { code: 5, apiName: "Tipper" },
  cisterna: { code: 6, apiName: "Tank" },
  tank: { code: 6, apiName: "Tank" },
  container: { code: 7, apiName: "Container" },
  "cisterna alimentara": { code: 8, apiName: "Liquid food container" },
  "liquid food container": { code: 8, apiName: "Liquid food container" },
  agabaritic: { code: 9, apiName: "Oversized" },
  oversized: { code: 9, apiName: "Oversized" },
  oversize: { code: 9, apiName: "Oversized" },
  "transport autoturisme": { code: 10, apiName: "Car transporter" },
  "car transporter": { code: 10, apiName: "Car transporter" },
  "cap tractor": { code: 11, apiName: "Tractor Unit" },
  "tractor unit": { code: 11, apiName: "Tractor Unit" },
  "van 3.5t prelata": { code: 2, apiName: "Tilt" },
  "3.5t curtain-sided van": { code: 2, apiName: "Tilt" },
  "camion 7.5t prelata": { code: 2, apiName: "Tilt" },
  "7.5t curtain-sided truck": { code: 2, apiName: "Tilt" },
  "camion 40t prelata": { code: 2, apiName: "Tilt" },
  "40t curtain-sided truck": { code: 2, apiName: "Tilt" },
  "12t curtain-sided truck": { code: 2, apiName: "Tilt" },
  "18t curtain-sided truck": { code: 2, apiName: "Tilt" },
  "40t mega truck (curtain-sided)": { code: 2, apiName: "Tilt" },
  "40t curtain-sided truck and trailer (120cbm)": { code: 2, apiName: "Tilt" },
  "van 3.5t box": { code: 1, apiName: "Box" },
  "3.5t box van": { code: 1, apiName: "Box" },
  "3.5t rigid van": { code: 1, apiName: "Box" },
  "7.5t rigid truck": { code: 1, apiName: "Box" },
  "12t rigid truck": { code: 1, apiName: "Box" },
  "18t rigid truck": { code: 1, apiName: "Box" },
  "40t rigid truck": { code: 1, apiName: "Box" },
  "tipper truck gmp certified": { code: 5, apiName: "Tipper" },
  "tipper truck": { code: 5, apiName: "Tipper" },
  "cisterna adr": { code: 6, apiName: "Tank" },
  "adr tanker": { code: 6, apiName: "Tank" },
  "food-grade tanker": { code: 8, apiName: "Liquid food container" },
  "sasiu container": { code: 7, apiName: "Container" },
  "container chassis": { code: 7, apiName: "Container" },
  "trailer agabaritic": { code: 9, apiName: "Oversized" },
  "oversized trailer": { code: 9, apiName: "Oversized" },
  "platforma auto deschisa": { code: 10, apiName: "Car transporter" },
  "open car transporter": { code: 10, apiName: "Car transporter" },
  "platforma auto inchisa": { code: 10, apiName: "Car transporter" },
  "enclosed car transporter": { code: 10, apiName: "Car transporter" },
  "camion 40t platforma deschisa": { code: 3, apiName: "Flat" },
  "flatbed 40t truck": { code: 3, apiName: "Flat" },
};

function mapTruckType(labelRaw: string) {
  const keys = Array.from(new Set([normalizeRoLabel(stripRightSideAfterSlash(labelRaw)), normalizeRoLabel(labelRaw)])).filter(
    Boolean
  );
  if (!keys.length) return { ok: false as const, error: "Tip Mijloc Transport gol." };
  for (const key of keys) {
    const mapped = TRUCK_TYPE_MAP[key];
    if (!mapped) continue;
    return { ok: true as const, code: mapped.code, apiName: mapped.apiName };
  }
  return { ok: false as const, error: `Tip Mijloc Transport necunoscut: '${labelRaw}'` };
}

function parseFlagsFromText(raw: string): LoadFlags {
  const t = normalizeRoLabel(raw);
  return {
    adr: /\badr\b/.test(t) || t.includes("hazard"),
    frigo:
      t.includes("frigo") ||
      t.includes("frig") ||
      t.includes("temperatura controlata") ||
      t.includes("temperature controlled") ||
      t.includes("reefer"),
    agabarit: t.includes("agabarit") || t.includes("oversize") || t.includes("oversized"),
    slidingFloor: t.includes("podea culisanta") || t.includes("sliding floor") || t.includes("walking floor"),
  };
}

function parseCargoTypeFromStatus(labelRaw: string) {
  const key = normalizeRoLabel(labelRaw);
  if (!key || key === "alege!" || key === "alege") {
    return {
      ok: true as const,
      flags: { hazardous: false, temperatureControlled: false, oversized: false, carTransport: false } as CargoTypeFlags,
    };
  }
  const map: Record<string, CargoTypeFlags | null> = {
    frigo: { hazardous: false, temperatureControlled: true, oversized: false, carTransport: false },
    oversized: { hazardous: false, temperatureControlled: false, oversized: true, carTransport: false },
    adr: { hazardous: true, temperatureControlled: false, oversized: false, carTransport: false },
    "general goods": { hazardous: false, temperatureControlled: false, oversized: false, carTransport: false },
    car: { hazardous: false, temperatureControlled: false, oversized: false, carTransport: true },
    waste: null,
  };
  const mapped = map[key];
  if (mapped === undefined) return { ok: false as const, error: `Tip Marfa necunoscut: '${labelRaw}'` };
  if (mapped === null) return { ok: false as const, error: `Tip Marfa '${labelRaw}' nu este permis pentru publicare.` };
  return { ok: true as const, flags: mapped };
}

function mapGroupageFromOcupareCamion(labelRaw: string) {
  const key = normalizeRoLabel(labelRaw);
  if (!key || key === "alege!" || key === "alege") return { ok: true as const, value: undefined as boolean | undefined };
  if (key === "groupage ltl") return { ok: true as const, value: true };
  if (key === "complete ftl") return { ok: true as const, value: false };
  return { ok: false as const, error: `Ocupare Camion necunoscută: '${labelRaw}'` };
}

function validateBusinessRules(cols: Record<string, MondayColumnValue>): string[] {
  const errors: string[] = [];
  const modTransport = (cols["color_mkx12a19"]?.text ?? "").trim();
  if (modTransport) {
    const normalized = normalizeRoLabel(modTransport);
    const isValid = ["rutier / road", "rutier", "road", "alege!", "alege"].includes(normalized);
    if (!isValid) {
      errors.push(`Modul de transport principal trebuie să fie «Rutier / Road» sau «Alege!», nu «${modTransport}»`);
    }
  }

  const tipMarfa = (cols[config.mondayColumns.tipMarfa]?.text ?? "").trim();
  if (tipMarfa) {
    const normalized = normalizeRoLabel(tipMarfa);
    if (normalized.includes("waste") || normalized.includes("deseuri")) {
      errors.push(`Tip Marfa nu poate fi «Waste». Valoare curentă: «${tipMarfa}»`);
    }
  }
  return errors;
}

function validateRequired(cols: Record<string, MondayColumnValue>): string[] {
  const errors: string[] = [];
  const requiredText = (id: string) => (cols[id]?.text ?? "").trim().length > 0;

  if (!config.auth.forceTestMode) {
    const principalId = getFirstPersonIdFromPeopleValue(cols[config.mondayColumns.dealOwner]?.value ?? null);
    const preluatId = getFirstPersonIdFromPeopleValue(cols[config.mondayColumns.preluatDe]?.value ?? null);
    if (!principalId && !preluatId) errors.push("Trebuie completat fie 'Principal', fie 'Preluat de'.");
  }

  const budget = parseNumberLoose((cols["numeric_mkr4e4qc"]?.text ?? "").trim());
  if (!Number.isFinite(budget) || budget <= 0) errors.push("Buget Client trebuie sa fie un numar > 0.");

  if (!requiredText("color_mksh2abx")) errors.push("Moneda este obligatorie.");
  if (!requiredText("dropdown_mkx6jyjf")) errors.push("Tara Incarcare este obligatorie.");
  if (!requiredText("text_mkypcczr")) errors.push("Localitate Incarcare este obligatorie.");
  if (!requiredText("dropdown_mkx687jv")) errors.push("Tara Descarcare este obligatorie.");
  if (!requiredText("text_mkypxb8h")) errors.push("Localitate Descarcare este obligatorie.");

  const weight = parseNumberLoose((cols["text_mkt9nr81"]?.text ?? "").trim());
  if (!Number.isFinite(weight) || weight <= 0) errors.push("Greutate (KG) trebuie sa fie un numar > 0.");
  if (!requiredText("date_mkx77z0m")) errors.push("Data Inc. este obligatorie.");

  const intervalCol = cols["numeric_mkypzwfe"];
  if (intervalCol) {
    const interval = parseNumberLoose((intervalCol.text ?? "").trim());
    if (!Number.isFinite(interval) || interval <= 0) errors.push("Nr. zile valabile Incarcare trebuie sa fie un numar > 0.");
  }

  if (!requiredText("dropdown_mkx1s5nv")) errors.push("Tip Mijloc Transport este obligatoriu.");
  return errors;
}

function buildLoadPayload(cols: Record<string, MondayColumnValue>, itemId: string) {
  const errors: string[] = [];

  const srcCountryRaw = (cols["dropdown_mkx6jyjf"]?.text ?? "").trim();
  const srcCity = (cols["text_mkypcczr"]?.text ?? "").trim();
  const dstCountryRaw = (cols["dropdown_mkx687jv"]?.text ?? "").trim();
  const dstCity = (cols["text_mkypxb8h"]?.text ?? "").trim();
  const weightTxt = (cols["text_mkt9nr81"]?.text ?? "").trim();
  const loadingDateRaw = getDateISOFromDateColumn(cols["date_mkx77z0m"]);
  const loadingDate = toBursaDate(loadingDateRaw);
  const loadingIntervalCol = cols["numeric_mkypzwfe"];
  const loadingIntervalTxt = (loadingIntervalCol?.text ?? "").trim();
  const transportLabel = (cols["dropdown_mkx1s5nv"]?.text ?? "").trim();
  const tipMarfaLabel = (cols[config.mondayColumns.tipMarfa]?.text ?? "").trim();
  const ocupareCamionLabel = (cols[config.mondayColumns.ocupareCamion]?.text ?? "").trim();
  const budgetTxt = (cols["numeric_mkr4e4qc"]?.text ?? "").trim();
  const currencyTxt = (cols["color_mksh2abx"]?.text ?? "").trim();
  const flagsRaw = config.mondayColumns.flags ? (cols[config.mondayColumns.flags]?.text ?? "").trim() : "";

  const flags = parseFlagsFromText(flagsRaw);
  if (!loadingDate) {
    errors.push("Data Inc. invalidă (format acceptat YYYY-MM-DD sau DD-MM-YYYY).");
  } else if (!isWithin30DaysOfToday(loadingDate)) {
    errors.push("Data Inc. trebuie să fie în intervalul de 30 zile față de data curentă.");
  }

  let loadingInterval = config.integrations.cargo123.defaultLoadingIntervalDays;
  if (loadingIntervalCol) {
    loadingInterval = parseNumberLoose(loadingIntervalTxt);
    if (!Number.isFinite(loadingInterval) || loadingInterval <= 0) {
      errors.push("Nr. zile valabile Incarcare invalid (loadingInterval).");
    }
  }

  const weight = parseNumberLoose(weightTxt);
  if (!Number.isFinite(weight) || weight <= 0) errors.push("Greutate invalidă.");

  const srcCountry = normalizeCountry2LetterEnglish(srcCountryRaw);
  if (!srcCountry) errors.push(`Țara Încărcare nu se poate mapa la ISO2: '${srcCountryRaw}'`);
  if (!srcCity) errors.push("Localitate Încărcare lipsă.");

  const dstCountry = normalizeCountry2LetterEnglish(dstCountryRaw);
  if (!dstCountry) errors.push(`Țara Descărcare nu se poate mapa la ISO2: '${dstCountryRaw}'`);
  if (!dstCity) errors.push("Localitate Descărcare lipsă.");

  const truckType = mapTruckType(transportLabel);
  if (!truckType.ok) errors.push(truckType.error);

  const tipMarfa = parseCargoTypeFromStatus(tipMarfaLabel);
  if (!tipMarfa.ok) errors.push(tipMarfa.error);

  const ocupare = mapGroupageFromOcupareCamion(ocupareCamionLabel);
  if (!ocupare.ok) errors.push(ocupare.error);

  const budget = parseNumberLoose(budgetTxt);
  if (!Number.isFinite(budget) || budget <= 0) errors.push("Buget Client invalid.");

  const currency = normalizeCurrency3(currencyTxt);
  if (!currency) errors.push("Moneda invalidă (RON/EUR/USD).");

  const requiredTruck: number[] = [];
  if (truckType.ok) requiredTruck.push(truckType.code);
  if (flags.agabarit) requiredTruck.push(9);
  if (tipMarfa.ok && tipMarfa.flags.oversized) requiredTruck.push(9);
  if (tipMarfa.ok && tipMarfa.flags.carTransport) requiredTruck.push(10);
  const uniqueRequiredTruck = Array.from(new Set(requiredTruck));
  if (!uniqueRequiredTruck.length) errors.push("requiredTruck invalid (gol).");

  const notes: string[] = [];
  if (flagsRaw) notes.push(`Cerințe: ${flagsRaw}`);
  if (flags.slidingFloor) notes.push("Necesar: podea culisantă.");
  const description = notes.join(" ").trim();
  const externalReference = Number.parseInt(itemId, 10);

  const payload: any = {
    externalReference: Number.isFinite(externalReference) ? externalReference : undefined,
    loadingDate,
    loadingInterval: Math.trunc(loadingInterval),
    requiredTruck: uniqueRequiredTruck,
    weight,
    source: srcCountry && srcCity ? { name: srcCity, country: srcCountry } : undefined,
    destination: dstCountry && dstCity ? { name: dstCity, country: dstCountry } : undefined,
    hazardous: flags.adr || (tipMarfa.ok && tipMarfa.flags.hazardous) ? true : undefined,
    temperatureControlled: flags.frigo || (tipMarfa.ok && tipMarfa.flags.temperatureControlled) ? true : undefined,
    groupage: ocupare.ok ? ocupare.value : undefined,
    offeredPrice: {
      price: budget,
      currency,
      vat: true,
    },
    description: description || undefined,
    privateNotice: undefined as string | undefined,
  };

  if (config.mondayColumns.privateNotice) {
    const privateNotice = (cols[config.mondayColumns.privateNotice]?.text ?? "").trim();
    payload.privateNotice = privateNotice || description || undefined;
  }

  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }
  return { payload, errors };
}

function toResultError(prefix: string, errors: string[]): IntegrationResult {
  return { status: "error", message: `[${prefix}] ${errors.join("; ")}` };
}

function isTwoStepRequiredResponse(status: number, data: any): boolean {
  if (status === 409) return true;
  return String(data?.response || "").toLowerCase().includes("2 step authentication required");
}

function normalizeTwoStepCookieValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^"+|"+$/g, "").trim();
  const named = s.match(/Bursa-2step-authentication\s*=\s*([^;,\s]+)/i);
  if (named?.[1]) return named[1].trim();
  const firstPart = s.split(";")[0]?.trim() || "";
  const eqIndex = firstPart.indexOf("=");
  if (eqIndex > 0) {
    const key = firstPart.slice(0, eqIndex).trim();
    const value = firstPart.slice(eqIndex + 1).trim();
    if (/bursa-2step-authentication/i.test(key) && value) return value;
  }
  if (/^[^\s;]+$/.test(s)) return s;
  return null;
}

function extractTwoStepCookie(data: any, setCookieHeader: unknown): string | null {
  const candidates: unknown[] = [
    data?.response,
    data?.response?.cookie,
    data?.response?.value,
    data?.response?.["Bursa-2step-authentication"],
    data?.["Bursa-2step-authentication"],
    data?.cookie,
  ];
  for (const candidate of candidates) {
    const val = normalizeTwoStepCookieValue(candidate);
    if (val) return val;
  }

  const setCookie = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : typeof setCookieHeader === "string"
      ? [setCookieHeader]
      : [];
  for (const line of setCookie) {
    const val = normalizeTwoStepCookieValue(String(line));
    if (val) return val;
  }
  return null;
}

async function postLoad(authHeader: string, payload: any, twoStepCookie?: string) {
  return axios.post(`${config.integrations.cargo123.baseUrl}/loads`, payload, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: authHeader,
      ...(twoStepCookie ? { Cookie: `Bursa-2step-authentication=${twoStepCookie}` } : {}),
    },
    validateStatus: () => true,
  });
}

async function submitTwoStepCode(authHeader: string, code: string) {
  const form = new URLSearchParams({ code });
  const formRes = await axios.post(`${config.integrations.cargo123.baseUrl}/login/login`, form.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: authHeader,
    },
    validateStatus: () => true,
  });
  if (formRes.status !== 409) return formRes;
  return axios.post(
    `${config.integrations.cargo123.baseUrl}/login/login`,
    { code },
    {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: authHeader,
      },
      validateStatus: () => true,
    }
  );
}

async function deleteLoad(authHeader: string, loadId: string) {
  return axios.delete(`${config.integrations.cargo123.baseUrl}/loads/${encodeURIComponent(loadId)}`, {
    headers: {
      Accept: "application/json",
      Authorization: authHeader,
    },
    validateStatus: () => true,
  });
}

function prepareContext(context: IntegrationContext) {
  const cols = Object.fromEntries(context.item.column_values.map((c) => [c.id, c])) as Record<string, MondayColumnValue>;
  return { cols };
}

async function publishLoad(context: IntegrationContext): Promise<IntegrationResult> {
  const { cols } = prepareContext(context);
  const businessErrors = validateBusinessRules(cols);
  if (businessErrors.length) return toResultError("BUSINESS RULES", businessErrors);

  const auth = pickBasicAuthHeaderFromOwner(cols);
  if (!auth.ok) return { status: "error", message: `[USER] ${auth.error}` };

  const validationErrors = validateRequired(cols);
  if (validationErrors.length) return toResultError("VALIDATION", validationErrors);

  const { payload, errors: mapErrors } = buildLoadPayload(cols, context.itemId);
  if (mapErrors.length) return toResultError("MAPPING", mapErrors);

  const response = await postLoad(auth.authHeader, payload);
  if (isTwoStepRequiredResponse(response.status, response.data)) {
    return { status: "requires_two_step", message: "[2STEP] Bursa solicită cod de autentificare." };
  }

  const ok = response.status === 200 && response.data?.resultCode === 0;
  if (ok) return { status: "success" };

  const contentType = String(response.headers?.["content-type"] || "unknown");
  const body = JSON.stringify(response.data)?.slice(0, 900);
  return { status: "error", message: `[123CARGO] HTTP ${response.status} (${contentType}) - ${body}` };
}

async function completeTwoStepPublish(context: IntegrationContext, code: string): Promise<IntegrationResult> {
  const { cols } = prepareContext(context);
  const auth = pickBasicAuthHeaderFromOwner(cols);
  if (!auth.ok) return { status: "error", message: `[USER] ${auth.error}` };
  const validationErrors = validateRequired(cols);
  if (validationErrors.length) return toResultError("VALIDATION", validationErrors);
  const { payload, errors: mapErrors } = buildLoadPayload(cols, context.itemId);
  if (mapErrors.length) return toResultError("MAPPING", mapErrors);

  const authRes = await submitTwoStepCode(auth.authHeader, code.trim());
  const authOk = authRes.status === 200 && authRes.data?.resultCode === 0;
  if (!authOk) {
    return {
      status: "error",
      message: `Cod invalid sau autentificare 2-step eșuată: HTTP ${authRes.status} - ${JSON.stringify(authRes.data)}`,
    };
  }

  const cookie = extractTwoStepCookie(authRes.data, authRes.headers?.["set-cookie"]);
  if (!cookie) {
    const headerKeys = Object.keys(authRes.headers || {});
    logger.warn("2-step cookie missing", { headerKeys, status: authRes.status });
    return {
      status: "error",
      message: "2-step validat, dar nu am primit cookie Bursa-2step-authentication.",
    };
  }

  const publishRes = await postLoad(auth.authHeader, payload, cookie);
  const ok = publishRes.status === 200 && publishRes.data?.resultCode === 0;
  if (ok) return { status: "success" };

  const contentType = String(publishRes.headers?.["content-type"] || "unknown");
  const body = JSON.stringify(publishRes.data)?.slice(0, 900);
  return { status: "error", message: `[123CARGO] HTTP ${publishRes.status} (${contentType}) - ${body}` };
}

async function removeLoad(context: IntegrationContext): Promise<IntegrationResult> {
  const { cols } = prepareContext(context);
  const loadId = (cols[config.mondayColumns.externalLoadId]?.text ?? "").trim();
  if (!config.mondayColumns.externalLoadId) {
    return { status: "error", message: "[123CARGO] EXTERNAL_LOAD_ID_COLUMN_ID is not configured." };
  }
  if (!loadId) {
    return { status: "error", message: "[123CARGO] Missing external load id on item." };
  }

  const auth = pickBasicAuthHeaderFromOwner(cols);
  if (!auth.ok) return { status: "error", message: `[USER] ${auth.error}` };
  const response = await deleteLoad(auth.authHeader, loadId);
  const ok = response.status === 200 && response.data?.resultCode === 0;
  if (ok) return { status: "success" };
  return { status: "error", message: `[123CARGO] DELETE failed: HTTP ${response.status} - ${JSON.stringify(response.data)}` };
}

export const cargo123Integration: FreightIntegration = {
  name: "123cargo",
  publishLoad,
  removeLoad,
  completeTwoStepPublish,
};
