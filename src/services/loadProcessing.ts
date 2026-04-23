import countries from "i18n-iso-countries";
import { createRequire } from "module";

import type { MondayColumnValue } from "./mondayClient.js";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import {
  getDateISOFromDateColumn,
  getFirstPersonIdFromPeopleValue,
  normalizeRoLabel,
  parseNumberLoose,
  stripRightSideAfterSlash,
} from "../utils/mondayParsing.js";

const require = createRequire(import.meta.url);
const en = require("i18n-iso-countries/langs/en.json");
countries.registerLocale(en);

export type LoadFlags = {
  adr: boolean;
  frigo: boolean;
  agabarit: boolean;
  slidingFloor: boolean;
};

const UI_RO_TO_123CARGO_TRUCKTYPE: Record<string, { code: number; apiName: string } | null> = {
  duba: { code: 1, apiName: "Box" },
  box: { code: 1, apiName: "Box" },
  prelata: { code: 2, apiName: "Tilt" },
  tilt: { code: 2, apiName: "Tilt" },
  // Common English UI labels seen on boards
  "40t mega truck (curtain-sided)": { code: 2, apiName: "Tilt" },
  "mega truck (curtain-sided)": { code: 2, apiName: "Tilt" },
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
  "cap tractor": null,
};

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

export function parseFlagsFromText(raw: string): LoadFlags {
  const t = normalizeRoLabel(raw);
  const adr = /\badr\b/.test(t) || t.includes("hazard");
  const frigo =
    t.includes("frigo") ||
    t.includes("frig") ||
    t.includes("temperatura controlata") ||
    t.includes("temperature controlled") ||
    t.includes("reefer");
  const agabarit = t.includes("agabarit") || t.includes("oversize") || t.includes("oversized");
  const slidingFloor =
    t.includes("podea culisanta") || t.includes("sliding floor") || t.includes("walking floor");
  return { adr, frigo, agabarit, slidingFloor };
}

export function mapTruckTypeFromMondayUi(labelRaw: string) {
  const rightSide = stripRightSideAfterSlash(labelRaw);
  const key = normalizeRoLabel(rightSide);
  if (!key) return { ok: false as const, error: "Tip Mijloc Transport gol." };
  const mapped = UI_RO_TO_123CARGO_TRUCKTYPE[key];
  if (mapped === undefined) {
    // Heuristic fallback for English dropdown labels like "Mega Truck (Curtain-Sided)".
    if (key.includes("curtain") && (key.includes("truck") || key.includes("mega"))) {
      return { ok: true as const, code: 2, apiName: "Tilt" };
    }
    return { ok: false as const, error: `Tip Mijloc Transport necunoscut: '${labelRaw}'` };
  }
  if (mapped === null) {
    return {
      ok: false as const,
      error: `Tip Mijloc Transport '${labelRaw}' nu are corespondent valid în 123cargo.`,
    };
  }
  return { ok: true as const, code: mapped.code, apiName: mapped.apiName };
}

export function validateBusinessRules(cols: Record<string, MondayColumnValue>): string[] {
  const errors: string[] = [];
  const modTransportPrincipal = (cols["color_mkx12a19"]?.text ?? "").trim();
  if (modTransportPrincipal) {
    const normalized = modTransportPrincipal.toLowerCase();
    const isValid =
      normalized === "rutier / road" ||
      normalized === "rutier" ||
      normalized === "road" ||
      normalized === "alege!" ||
      normalized === "alege";
    if (!isValid) {
      errors.push(
        `Modul de transport principal trebuie să fie «Rutier / Road» sau «Alege!», nu «${modTransportPrincipal}»`
      );
    }
  }
  const tipMarfa = (cols["dropdown_mkx1s5nv"]?.text ?? "").trim();
  if (tipMarfa) {
    const normalized = normalizeRoLabel(tipMarfa);
    if (normalized.includes("deseuri") || normalized.includes("waste")) {
      errors.push(`Tip Marfa nu poate fi «Deșeuri / Waste». Valoare curentă: «${tipMarfa}»`);
    }
  }
  return errors;
}

export function validateRequired(cols: Record<string, MondayColumnValue>): string[] {
  const errors: string[] = [];
  const cfg = getConfig();
  const isNonEmptyText = (id: string) => (cols[id]?.text ?? "").trim().length > 0;

  const principalId = getFirstPersonIdFromPeopleValue(cols[cfg.mondayColumns.dealOwner]?.value ?? null);
  if (!principalId) {
    errors.push("Coloana Principal nu este completată.");
  }

  const bugetTxt = (cols["numeric_mkr4e4qc"]?.text ?? "").trim();
  const buget = parseNumberLoose(bugetTxt);
  if (!bugetTxt || !Number.isFinite(buget) || buget <= 0) {
    errors.push("Buget Client trebuie sa fie un numar > 0.");
  }

  if (!isNonEmptyText("color_mksh2abx")) errors.push("Moneda este obligatorie.");

  const loadingAddrOk = cfg.mondayColumns.loadingAddress ? isNonEmptyText(cfg.mondayColumns.loadingAddress) : false;
  const unloadingAddrOk = cfg.mondayColumns.unloadingAddress ? isNonEmptyText(cfg.mondayColumns.unloadingAddress) : false;

  if (!isNonEmptyText("dropdown_mkx6jyjf") && !loadingAddrOk) {
    errors.push("Tara Incarcare este obligatorie (sau completează «Adresa Incarcare» dacă e configurată în integrare).");
  }
  if (!isNonEmptyText("text_mkypcczr") && !loadingAddrOk) {
    errors.push("Localitate Incarcare este obligatorie (sau completează «Adresa Incarcare» dacă e configurată în integrare).");
  }
  if (!isNonEmptyText("dropdown_mkx687jv") && !unloadingAddrOk) {
    errors.push("Tara Descarcare este obligatorie (sau completează «Adresa Descarcare» dacă e configurată în integrare).");
  }
  if (!isNonEmptyText("text_mkypxb8h") && !unloadingAddrOk) {
    errors.push("Localitate Descarcare este obligatorie (sau completează «Adresa Descarcare» dacă e configurată în integrare).");
  }

  const greutateTxt = (cols["text_mkt9nr81"]?.text ?? "").trim();
  const greutate = parseNumberLoose(greutateTxt);
  if (!greutateTxt || !Number.isFinite(greutate) || greutate <= 0) {
    errors.push("Greutate (KG) trebuie sa fie un numar > 0.");
  }

  if (!isNonEmptyText("date_mkx77z0m")) errors.push("Data Inc. este obligatorie.");

  // Default to 1 day if missing/0/invalid in Monday.
  const zileTxt = (cols["numeric_mm2m66q1"]?.text ?? "").trim();
  const zile = parseNumberLoose(zileTxt);
  void zile; // value is used in payload build (defaults to 1); no hard validation here.

  if (!isNonEmptyText("dropdown_mkx1s5nv")) errors.push("Tip Mijloc Transport este obligatoriu.");

  return errors;
}

export function buildLoadPayload(cols: Record<string, MondayColumnValue>, itemId: number) {
  const cfg = getConfig();
  const errors: string[] = [];

  const srcCountryRaw = (cols["dropdown_mkx6jyjf"]?.text ?? "").trim();
  const srcLocalityRaw = (cols["text_mkypcczr"]?.text ?? "").trim();
  const dstCountryRaw = (cols["dropdown_mkx687jv"]?.text ?? "").trim();
  const dstLocalityRaw = (cols["text_mkypxb8h"]?.text ?? "").trim();
  const srcAddrRaw = cfg.mondayColumns.loadingAddress ? (cols[cfg.mondayColumns.loadingAddress]?.text ?? "").trim() : "";
  const dstAddrRaw = cfg.mondayColumns.unloadingAddress ? (cols[cfg.mondayColumns.unloadingAddress]?.text ?? "").trim() : "";
  const weightTxt = (cols["text_mkt9nr81"]?.text ?? "").trim();
  const LOADING_DATE_COLUMN_ID = "date_mkx77z0m";
  const loadingCol = cols[LOADING_DATE_COLUMN_ID];
  const loadingDate = getDateISOFromDateColumn(loadingCol);
  const loadingIntervalTxt = (cols["numeric_mm2m66q1"]?.text ?? "").trim();
  const transportLabel = (cols["dropdown_mkx1s5nv"]?.text ?? "").trim();
  const budgetTxt = (cols["numeric_mkr4e4qc"]?.text ?? "").trim();
  const currencyTxt = (cols["color_mksh2abx"]?.text ?? "").trim();

  const flagsRaw = cfg.flagsColumnId ? (cols[cfg.flagsColumnId]?.text ?? "").trim() : "";
  const flags = parseFlagsFromText(flagsRaw);

  if (!loadingDate) errors.push("Data Inc. invalidă (loadingDate).");

  // Bursa commonly enforces: loading date must be within ~30 days from "today".
  // We validate using Europe/Bucharest calendar day boundaries (closer to how ops think about dates).
  if (loadingDate) {
    // Empirically, Bursa can reject *same-day* loading with the same error text as "outside 30 days".
    // Default: treat the allowed window as tomorrow (RO) .. today+30 (RO), inclusive.
    // Override with `BURSA_ALLOW_SAME_DAY_LOADING_DATE=1` if your Bursa tenant accepts same-day loading.
    const allowSameDay = (process.env.BURSA_ALLOW_SAME_DAY_LOADING_DATE || "").trim() === "1";
    const minOffsetDaysFromToday = allowSameDay ? 0 : 1;
    const cmp = compareYmdToBucharestWindow(loadingDate, { minOffsetDaysFromToday, maxFutureDaysFromToday: 30 });
    if (!cmp.ok) {
      errors.push(
        `Data Încărcare invalidă pentru Bursa: ${cmp.reason} (trimis: '${loadingDate}', azi RO: '${cmp.todayRo}', min: '${cmp.minRo}', max: '${cmp.maxRo}')`
      );
    }
  }

  const allowSameDayForLog = (process.env.BURSA_ALLOW_SAME_DAY_LOADING_DATE || "").trim() === "1";
  const apiLoadingDate = loadingDate ? tryFormatYmdToRoDmy(loadingDate) : null;
  if (loadingDate && !apiLoadingDate) {
    errors.push(`Data Încărcare invalidă (nu poate fi formatată pentru Bursa): '${loadingDate}'`);
  }
  logger.info("Bursa payload debug: loadingDate", {
    loadingDateColumnId: LOADING_DATE_COLUMN_ID,
    mondayDateColumn: loadingCol
      ? { id: loadingCol.id, text: loadingCol.text ?? null, value: loadingCol.value ?? null }
      : null,
    parsedLoadingDate: loadingDate,
    apiLoadingDate,
    bucharestTodayYmd: ymdTodayEuropeBucharest(),
    bucharestMinYmd: addDaysYmd(ymdTodayEuropeBucharest(), allowSameDayForLog ? 0 : 1),
    bucharestMaxYmd: addDaysYmd(ymdTodayEuropeBucharest(), 30),
    allowSameDayLoadingDate: allowSameDayForLog,
    itemId,
  });

  const loadingIntervalRaw = parseNumberLoose(loadingIntervalTxt);
  const loadingInterval = Number.isFinite(loadingIntervalRaw) && loadingIntervalRaw > 0 ? loadingIntervalRaw : 1;

  const weight = parseNumberLoose(weightTxt);
  if (!Number.isFinite(weight) || weight <= 0) errors.push("Greutate invalidă (weight).");

  const srcResolved = resolveBursaPlace({
    role: "source",
    localityRaw: srcLocalityRaw,
    countryRaw: srcCountryRaw,
    addressRaw: srcAddrRaw,
    addressColumnId: cfg.mondayColumns.loadingAddress,
  });
  if (!srcResolved.ok) errors.push(srcResolved.error);
  const dstResolved = resolveBursaPlace({
    role: "destination",
    localityRaw: dstLocalityRaw,
    countryRaw: dstCountryRaw,
    addressRaw: dstAddrRaw,
    addressColumnId: cfg.mondayColumns.unloadingAddress,
  });
  if (!dstResolved.ok) errors.push(dstResolved.error);

  const srcCountry = srcResolved.ok ? srcResolved.countryIso2 : null;
  const dstCountry = dstResolved.ok ? dstResolved.countryIso2 : null;
  const srcCity = srcResolved.ok ? srcResolved.city : "";
  const dstCity = dstResolved.ok ? dstResolved.city : "";

  logger.info("Bursa payload debug: places", {
    srcLocalityRaw,
    srcCountryRaw,
    srcAddressRaw: srcAddrRaw,
    srcAddressColumnId: cfg.mondayColumns.loadingAddress || null,
    srcResolved: srcResolved.ok ? { countryIso2: srcResolved.countryIso2, city: srcResolved.city, fromAddress: srcResolved.fromAddress } : null,
    dstLocalityRaw,
    dstCountryRaw,
    dstAddressRaw: dstAddrRaw,
    dstAddressColumnId: cfg.mondayColumns.unloadingAddress || null,
    dstResolved: dstResolved.ok ? { countryIso2: dstResolved.countryIso2, city: dstResolved.city, fromAddress: dstResolved.fromAddress } : null,
    itemId,
  });

  const tt = mapTruckTypeFromMondayUi(transportLabel);
  if (!tt.ok) errors.push(tt.error);

  const budget = parseNumberLoose(budgetTxt);
  if (!Number.isFinite(budget) || budget <= 0) errors.push("Buget Client invalid (offeredPrice.price).");

  const currency = normalizeCurrency3(currencyTxt);
  if (!currency) errors.push("Moneda invalidă (folosește RON/EUR/USD sau label mapabil).");

  const requiredTruck: number[] = [];
  if (tt.ok) requiredTruck.push(tt.code);
  if (flags.agabarit) requiredTruck.push(9);
  const uniqueRequiredTruck = Array.from(new Set(requiredTruck));
  if (uniqueRequiredTruck.length === 0) errors.push("requiredTruck invalid (gol).");

  const notes: string[] = [];
  if (srcAddrRaw) notes.push(`Adresa încărcare: ${srcAddrRaw}`);
  if (dstAddrRaw) notes.push(`Adresa descărcare: ${dstAddrRaw}`);
  if (looksLikeFullAddress(srcLocalityRaw) && srcLocalityRaw !== srcCity) {
    notes.push(`Localitate încărcare (raw): ${srcLocalityRaw}`);
  }
  if (looksLikeFullAddress(dstLocalityRaw) && dstLocalityRaw !== dstCity) {
    notes.push(`Localitate descărcare (raw): ${dstLocalityRaw}`);
  }
  if (flagsRaw) notes.push(`Cerințe: ${flagsRaw}`);
  else {
    if (flags.slidingFloor) notes.push("Necesar: podea culisantă (sliding floor).");
    if (flags.agabarit) notes.push("Marfă agabaritică / oversized.");
    if (flags.adr) notes.push("ADR (hazardous).");
    if (flags.frigo) notes.push("Frigo / temperatură controlată.");
  }
  const description = notes.length ? notes.join(" ") : "";

  const payload: Record<string, unknown> = {
    externalReference: Number(itemId),
    loadingInterval: Math.trunc(loadingInterval),
    requiredTruck: uniqueRequiredTruck,
    weight,
    source: srcCountry && srcCity ? { name: srcCity, country: srcCountry } : undefined,
    destination: dstCountry && dstCity ? { name: dstCity, country: dstCountry } : undefined,
    hazardous: flags.adr ? true : undefined,
    temperatureControlled: flags.frigo ? true : undefined,
    offeredPrice: { price: budget, currency, vat: true },
    description: description || undefined,
    privateNotice: undefined as string | undefined,
  };

  // Bursa / 123cargo API expects Romanian date format (DD-MM-YYYY), not ISO YYYY-MM-DD.
  if (apiLoadingDate) payload.loadingDate = apiLoadingDate;

  logger.info("Bursa payload debug: places(final)", {
    source: payload.source,
    destination: payload.destination,
    itemId,
  });

  if (cfg.privateNoticeColumnId) {
    const pn = (cols[cfg.privateNoticeColumnId]?.text ?? "").trim();
    payload.privateNotice = pn || (description ? description : undefined);
  }

  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k];
  }

  return { payload, errors };
}

function looksLikeFullAddress(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return false;
  if (t.includes("str.")) return true;
  if (t.includes("strada")) return true;
  if (/\bnr\.?\b/.test(t)) return true;
  if (/\bsector\b/.test(t)) return true;
  if (/\bvia\b/.test(t)) return true;
  if (t.includes("/")) return true;
  if ((raw.match(/,/g) || []).length >= 3) return true;
  return false;
}

type ResolveBursaPlaceInput = {
  role: "source" | "destination";
  localityRaw: string;
  countryRaw: string;
  addressRaw: string;
  addressColumnId: string;
};

type ResolveBursaPlaceOk = {
  ok: true;
  countryIso2: string;
  city: string;
  fromAddress: boolean;
};

type ResolveBursaPlaceErr = { ok: false; error: string };

function resolveBursaPlace(input: ResolveBursaPlaceInput): ResolveBursaPlaceOk | ResolveBursaPlaceErr {
  const locality = input.localityRaw.trim();
  const countryRaw = input.countryRaw.trim();
  const addr = input.addressRaw.trim();

  const countryFromDedicated = countryRaw ? normalizeCountry2LetterEnglish(countryRaw) : null;
  if (countryRaw && !countryFromDedicated) {
    return {
      ok: false,
      error: `[MAPPING] Țara (${input.role}) nu se poate mapa la ISO2 din '${countryRaw}'.`,
    };
  }

  // Preferred: locality + country
  if (locality && countryFromDedicated) {
    const city = bursaPlaceNameFromLocality(locality, countryFromDedicated);
    if (!city) {
      return { ok: false, error: `[MAPPING] Localitatea (${input.role}) nu a putut fi normalizată pentru Bursa.` };
    }
    return { ok: true, countryIso2: countryFromDedicated, city, fromAddress: false };
  }

  // Locality present, country missing: try to infer country from address (if present), otherwise fail clearly.
  if (locality && !countryFromDedicated) {
    if (!addr) {
      return {
        ok: false,
        error: `[MAPPING] Lipsește Țara pentru ${input.role}. Completează coloana «Tara …» sau completează «Adresa …» pentru inferență.`,
      };
    }
    const parsed = parseBursaPlaceFromFullAddress(addr, null);
    if (!parsed.ok) {
      return { ok: false, error: `[MAPPING] Lipsește Țara pentru ${input.role} și nu pot infera țara din adresă: ${parsed.reason}` };
    }
    if (!cityLooksLikeStreet(locality)) {
      const city = normalizeCityCasing(locality);
      return { ok: true, countryIso2: parsed.countryIso2, city, fromAddress: true };
    }
    // Locality looks like an address too; treat address as authoritative.
    return { ok: true, countryIso2: parsed.countryIso2, city: parsed.city, fromAddress: true };
  }

  // Country present, locality missing: derive city from address using country as a hint.
  if (!locality && countryFromDedicated) {
    if (!addr) {
      return { ok: false, error: `[MAPPING] Lipsește Localitatea pentru ${input.role}. Completează coloana «Localitate …» sau «Adresa …» (cu env pentru id-ul coloanei).` };
    }
    const parsed = parseBursaPlaceFromFullAddress(addr, countryFromDedicated);
    if (!parsed.ok) {
      return { ok: false, error: `[MAPPING] Lipsește Localitatea pentru ${input.role} și nu pot deriva orașul din adresă: ${parsed.reason}` };
    }
    return { ok: true, countryIso2: parsed.countryIso2, city: parsed.city, fromAddress: true };
  }

  // Fallback: parse address (requires configured column id + non-empty address)
  if (!addr) {
    if (!input.addressColumnId) {
      return {
        ok: false,
        error: `[MAPPING] Lipsesc localitatea/țara pentru ${input.role}. Configurează coloanele «Adresa Incarcare/Descarcare» (env LOADING_ADDRESS_COLUMN_ID / UNLOADING_ADDRESS_COLUMN_ID) pentru fallback.`,
      };
    }
    return {
      ok: false,
      error: `[MAPPING] Lipsesc localitatea/țara pentru ${input.role}, iar «Adresa» (${input.addressColumnId}) este goală.`,
    };
  }

  const parsed = parseBursaPlaceFromFullAddress(addr, countryFromDedicated);
  if (!parsed.ok) {
    return { ok: false, error: `[MAPPING] Nu pot deriva oraș/țară pentru ${input.role} din adresă: ${parsed.reason}` };
  }

  return { ok: true, countryIso2: parsed.countryIso2, city: parsed.city, fromAddress: true };
}

function parseBursaPlaceFromFullAddress(
  raw: string,
  countryHintIso2: string | null
): { ok: true; countryIso2: string; city: string } | { ok: false; reason: string } {
  const addr = raw.trim();
  if (!addr) return { ok: false, reason: "adresa este goală" };

  // If we already have a reliable country hint, derive city using the same locality normalizer on the whole string.
  if (countryHintIso2) {
    const city = bursaPlaceNameFromLocality(addr, countryHintIso2);
    if (!city || cityLooksLikeStreet(city)) {
      return { ok: false, reason: "nu am putut extrage un oraș clar din adresă (încă pare stradă/adresă)." };
    }
    return { ok: true, countryIso2: countryHintIso2, city };
  }

  const extractedCountryRaw = extractCountryTokenFromAddress(addr);
  const iso = extractedCountryRaw ? normalizeCountry2LetterEnglish(extractedCountryRaw) : null;
  if (!iso) {
    return { ok: false, reason: "nu am putut detecta țara în adresă (adaugă țara explicit sau completează coloana «Tara …»)." };
  }

  const city = bursaPlaceNameFromLocality(addr, iso);
  if (!city || cityLooksLikeStreet(city)) {
    return { ok: false, reason: "nu am putut extrage un oraș clar din adresă." };
  }
  return { ok: true, countryIso2: iso, city };
}

function extractCountryTokenFromAddress(addr: string): string | null {
  const parts = addr
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  // Prefer last segment as country name (common in EU addresses)
  const tail = parts[parts.length - 1];
  if (tail) {
    const iso = normalizeCountry2LetterEnglish(tail);
    if (iso) return tail;
    if (/^[A-Z]{2}$/i.test(tail)) return tail.toUpperCase();
  }

  // Also handle "... / BZ, Italy" patterns
  if (/\bItaly\b/i.test(addr)) return "Italy";
  if (/\bRomania\b/i.test(addr)) return "Romania";

  // ISO2 at end
  const iso2 = addr.match(/\b([A-Z]{2})\b\s*$/);
  if (iso2?.[1]) return iso2[1];

  return null;
}

function cityLooksLikeStreet(city: string): boolean {
  const t = city.trim().toLowerCase();
  if (!t) return true;
  if (/\d/.test(t)) return true;
  if (t.startsWith("str.") || t.includes("strada")) return true;
  if (/\bvia\b/.test(t)) return true;
  if (t.includes("sector")) return true;
  if (t.includes("/")) return true;
  return false;
}

/**
 * Bursa `/loads` expects `place.name` to be a city/locality, not a full street address.
 * We still read Monday's locality columns, but normalize common "address-in-locality-field" shapes.
 */
function bursaPlaceNameFromLocality(rawLocality: string, countryIso2: string | null): string {
  const raw = rawLocality.trim();
  if (!raw) return "";

  const c = (countryIso2 || "").toUpperCase();

  // Romania: pick the segment that contains a major city token (esp. Bucuresti) if present.
  if (c === "RO") {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.some((p) => normalizeRoLabel(p).includes("bucuresti"))) {
      return "Bucuresti";
    }
    // Fallback: last comma-separated chunk is often "City, Romania" or "Sector X, Bucuresti"
    const last = parts[parts.length - 1] || raw;
    return normalizeCityCasing(last.replace(/\bRomania\b/gi, "").trim());
  }

  // Italy / generic EU-ish: "..., Naturno 39025 / BZ, Italy" → "Naturno"
  if (c === "IT" || /\bItaly\b/i.test(raw)) {
    const italyIdx = raw.toLowerCase().lastIndexOf("italy");
    const head = (italyIdx >= 0 ? raw.slice(0, italyIdx) : raw).trim();
    const slashParts = head
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    const tail = slashParts[slashParts.length - 1] || head;
    const m = tail.match(/^(.+?)\s+\d{3,6}\b/); // "Naturno 39025" (+ optional "BZ")
    const city = (m?.[1] ? m[1] : tail).trim();
    return normalizeCityCasing(city.replace(/\bBZ\b/gi, "").trim());
  }

  // Generic: if it's comma-heavy, use the last segment as a best-effort city.
  if ((raw.match(/,/g) || []).length >= 2) {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return normalizeCityCasing(parts[parts.length - 1] || raw);
  }

  return normalizeCityCasing(raw);
}

function normalizeCityCasing(city: string): string {
  const t = city.trim();
  if (!t) return "";
  // Keep diacritics as provided by Monday; only normalize whitespace.
  return t.replace(/\s+/g, " ");
}

function tryFormatYmdToRoDmy(ymd: string): string | null {
  const { y, m, d } = parseYmd(ymd);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}-${String(y).padStart(4, "0")}`;
}

function ymdTodayEuropeBucharest(now: Date = new Date()): string {
  // en-CA yields YYYY-MM-DD in most runtimes for calendar dates.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    now
  );
}

function addDaysYmd(ymd: string, days: number): string {
  const { y, m, d } = parseYmd(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${String(dt.getUTCFullYear()).padStart(4, "0")}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate()
  ).padStart(2, "0")}`;
}

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { y: NaN, m: NaN, d: NaN };
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function ymdToUtcDate(ymd: string): Date | null {
  const { y, m, d } = parseYmd(ymd);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function compareYmdToBucharestWindow(
  loadingYmd: string,
  opts: { minOffsetDaysFromToday: number; maxFutureDaysFromToday: number }
): { ok: true } | { ok: false; reason: string; todayRo: string; minRo: string; maxRo: string } {
  const todayRo = ymdTodayEuropeBucharest();
  const minRo = addDaysYmd(todayRo, opts.minOffsetDaysFromToday);
  const maxRo = addDaysYmd(todayRo, opts.maxFutureDaysFromToday);

  const a = ymdToUtcDate(loadingYmd);
  const tMin = ymdToUtcDate(minRo);
  const tMax = ymdToUtcDate(maxRo);
  if (!a || !tMin || !tMax) return { ok: false, reason: "format invalid", todayRo, minRo, maxRo };

  if (a < tMin) return { ok: false, reason: "prea devreme pentru Bursa (minim mâine în RO)", todayRo, minRo, maxRo };
  if (a > tMax) return { ok: false, reason: "peste fereastra permisă (+30 zile față de azi RO)", todayRo, minRo, maxRo };
  return { ok: true };
}
