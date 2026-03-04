import express from "express";
import axios from "axios";
import dotenv from "dotenv";

import countries from "i18n-iso-countries";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const en = require("i18n-iso-countries/langs/en.json");

dotenv.config();
countries.registerLocale(en);

// =====================
// CONFIG
// =====================
function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const PORT = Number(process.env.PORT || 3000);

const MONDAY_TOKEN = reqEnv("MONDAY_TOKEN");
const BURSA_BASE = reqEnv("BURSA_BASE");

// Monday column IDs (set these in env)
const DEAL_OWNER_COLUMN_ID = reqEnv("DEAL_OWNER_COLUMN_ID"); // People column: Principal
const ERROR_COLUMN_ID = reqEnv("ERROR_COLUMN_ID");           // Text column to write errors

const SUCCESS_LABEL = reqEnv("TRIGGER_STATUS_SUCCESS_LABEL");
const ERROR_LABEL = reqEnv("TRIGGER_STATUS_ERROR_LABEL");

// Optional: process webhook only when status becomes this label
const TRIGGER_ONLY_LABEL = process.env.TRIGGER_STATUS_ONLY_LABEL || "";

// Optional: where you store "FRIGO / ADR / AGABARIT / PODEA CULISANTA" text/tags
// Can be dropdown/multi-select/tags/status — we just parse .text
const FLAGS_COLUMN_ID = process.env.FLAGS_COLUMN_ID || ""; // e.g. "dropdown_xxx" or "tags_xxx"

// Optional: private notes column (if you want to include flags there too)
const PRIVATE_NOTICE_COLUMN_ID = process.env.PRIVATE_NOTICE_COLUMN_ID || "";

// Optional: second people column used in your logic ("Preluat de")
const PRELUAT_DE_COLUMN_ID = process.env.PRELUAT_DE_COLUMN_ID || "multiple_person_mkybbcca";

// Optional: test override mode. When enabled, posts always use this fixed Bursa account
// and user columns (Principal / Preluat de) are ignored for auth checks.
const FORCE_TEST_AUTH_MODE = process.env.FORCE_TEST_AUTH_MODE === "1";
const TEST_BURSA_USERNAME = process.env.TEST_BURSA_USERNAME || "";
const TEST_BURSA_PASSWORD = process.env.TEST_BURSA_PASSWORD || "";
const DEFAULT_LOADING_INTERVAL_DAYS_RAW = process.env.DEFAULT_LOADING_INTERVAL_DAYS || "1";
const DEFAULT_LOADING_INTERVAL_DAYS = Number(DEFAULT_LOADING_INTERVAL_DAYS_RAW);
if (!Number.isFinite(DEFAULT_LOADING_INTERVAL_DAYS) || DEFAULT_LOADING_INTERVAL_DAYS <= 0) {
  throw new Error(
    `DEFAULT_LOADING_INTERVAL_DAYS invalid: '${DEFAULT_LOADING_INTERVAL_DAYS_RAW}'. Expected number > 0.`
  );
}

// =====================
// USER_MAP (Base64("user:pass"))
// =====================
// IMPORTANT: keep credentials in env/secret manager if possible
const USER_MAP: Record<number, { basicB64: string }> = {
  96280246: {
    basicB64:
      "cmFmYWVsLm9AY3J5c3RhbC1sb2dpc3RpY3Mtc2VydmljZXMuY29tOlRyYW5zcG9ydC4yMDI0",
  },
  // add rest of monday userIds here...
};

// =====================
// TYPES
// =====================
type MondayColumnValue = { id: string; text: string | null; value: string | null };
type MondayItem = { id: string; name: string; column_values: MondayColumnValue[] };
type MondayGraphQLError = { message?: string };
type MondayGraphQLResponse<T> = { data?: T; errors?: MondayGraphQLError[] };
type MondayWebhookBody = {
  challenge?: string;
  event?: {
    boardId: number | string;
    pulseId?: number | string;
    itemId?: number | string;
    columnId: string;
    value?: any;
    previousValue?: any;
  };
};

// =====================
// MONDAY HELPERS
// =====================
const MONDAY_URL = "https://api.monday.com/v2";

async function mondayGql<T>(query: string, variables: any): Promise<T> {
  const res = await axios.post(
    MONDAY_URL,
    { query, variables },
    { headers: { Authorization: MONDAY_TOKEN } }
  );

  const body = res.data as MondayGraphQLResponse<T>;
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    const messages = body.errors.map((e) => e?.message || "Unknown Monday error").join(" | ");
    throw new Error(`Monday GraphQL error: ${messages}`);
  }
  if (!body?.data) {
    throw new Error("Monday GraphQL error: missing data");
  }
  return body.data;
}

function colsToMap(columnValues: MondayColumnValue[]) {
  return Object.fromEntries(columnValues.map((c) => [c.id, c])) as Record<string, MondayColumnValue>;
}

async function fetchItem(boardId: string, itemId: string): Promise<MondayItem> {
  const q = `
    query ($boardId:[ID!], $itemId:[ID!]) {
      boards(ids:$boardId) {
        items_page(limit:1, query_params:{ ids:$itemId }) {
          items { id name column_values { id text value } }
        }
      }
    }`;
  const data: any = await mondayGql(q, { boardId: [boardId], itemId: [itemId] });
  const item = data?.boards?.[0]?.items_page?.items?.[0];
  if (!item) throw new Error("Item not found in monday");
  return item as MondayItem;
}

async function changeTextColumn(boardId: string, itemId: string, columnId: string, text: string) {
  const m = `
    mutation ($boardId:ID!, $itemId:ID!, $colId:String!, $val:JSON!) {
      change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
    }`;
  return mondayGql(m, { boardId, itemId, colId: columnId, val: JSON.stringify({ text }) });
}

async function changeStatusLabel(boardId: string, itemId: string, statusColId: string, label: string) {
  const m = `
    mutation ($boardId:ID!, $itemId:ID!, $colId:String!, $val:JSON!) {
      change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
    }`;
  return mondayGql(m, { boardId, itemId, colId: statusColId, val: JSON.stringify({ label }) });
}

function getStatusLabel(col: MondayColumnValue | undefined): string {
  if (!col?.value) return "";
  try {
    const v = JSON.parse(col.value);
    return String(v?.label || "");
  } catch {
    return "";
  }
}

// =====================
// PEOPLE COLUMN PARSING
// =====================
function getFirstPersonIdFromPeopleValue(valueJson: string | null): number | null {
  if (!valueJson) return null;
  try {
    const v = JSON.parse(valueJson);
    const persons = v?.personsAndTeams;
    if (!Array.isArray(persons) || persons.length === 0) return null;
    return persons[0]?.id ?? null;
  } catch {
    return null;
  }
}

function buildBasicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function pickBasicAuthHeaderFromOwner(cols: Record<string, MondayColumnValue>) {
  if (FORCE_TEST_AUTH_MODE) {
    if (!TEST_BURSA_USERNAME || !TEST_BURSA_PASSWORD) {
      return {
        ok: false as const,
        error:
          "FORCE_TEST_AUTH_MODE este activ, dar lipsesc TEST_BURSA_USERNAME / TEST_BURSA_PASSWORD din env.",
      };
    }

    return {
      ok: true as const,
      ownerId: -1,
      authHeader: buildBasicAuthHeader(TEST_BURSA_USERNAME, TEST_BURSA_PASSWORD),
    };
  }

  const principalId = getFirstPersonIdFromPeopleValue(cols[DEAL_OWNER_COLUMN_ID]?.value ?? null);
  const preluatDeId = getFirstPersonIdFromPeopleValue(cols[PRELUAT_DE_COLUMN_ID]?.value ?? null);

  const ownerId = principalId ?? preluatDeId;
  if (!ownerId) {
    return {
      ok: false as const,
      error: `Trebuie completat fie 'Principal' (${DEAL_OWNER_COLUMN_ID}), fie 'Preluat de' (${PRELUAT_DE_COLUMN_ID}).`,
    };
  }

  const entry = USER_MAP[ownerId];
  if (!entry?.basicB64) return { ok: false as const, error: `Owner userId not mapped: ${ownerId}` };

  return { ok: true as const, ownerId, authHeader: `Basic ${entry.basicB64}` };
}

// =====================
// NORMALIZATION HELPERS
// =====================
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

function stripRightSideAfterSlash(raw: string): string {
  // Handles labels like "Box / duba", "Tilt / prelata"
  const t = (raw ?? "").trim();
  if (!t) return "";
  if (!t.includes("/")) return t;
  return t.split("/").pop()!.trim();
}

function parseNumberLoose(s: string): number {
  const n = Number(String(s ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : NaN;
}

function getDateISOFromDateColumn(col: MondayColumnValue | undefined): string | null {
  if (!col) return null;
  if (col.value) {
    try {
      const v = JSON.parse(col.value);
      if (v?.date) return String(v.date);
    } catch {}
  }
  const t = (col.text ?? "").trim();
  return t || null;
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

// =====================
// FLAGS: FRIGO / ADR / AGABARIT / PODEA CULISANTA
// =====================
type LoadFlags = {
  adr: boolean;
  frigo: boolean;
  agabarit: boolean;
  slidingFloor: boolean;
};

function parseFlagsFromText(raw: string): LoadFlags {
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

// =====================
// TRUCKTYPE MAPPING
// =====================
// 123cargo truckType codes (spec v0.55):
// 1 Box, 2 Tilt, 3 Flat, 9 Oversized, 10 Car transporter, 5 Tipper, 6 Tank, 8 Liquid food container, 7 Container
const UI_RO_TO_123CARGO_TRUCKTYPE: Record<string, { code: number; apiName: string } | null> = {
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

  // Not a 123cargo truckType
  "cap tractor": null,
};

function mapTruckTypeFromMondayUi(labelRaw: string) {
  const rightSide = stripRightSideAfterSlash(labelRaw); // handles "Box / duba" -> "duba"
  const key = normalizeRoLabel(rightSide);
  if (!key) return { ok: false as const, error: "Tip Mijloc Transport gol." };

  const mapped = UI_RO_TO_123CARGO_TRUCKTYPE[key];
  if (mapped === undefined) {
    return { ok: false as const, error: `Tip Mijloc Transport necunoscut: '${labelRaw}'` };
  }
  if (mapped === null) {
    return { ok: false as const, error: `Tip Mijloc Transport '${labelRaw}' nu are corespondent valid în 123cargo.` };
  }
  return { ok: true as const, code: mapped.code, apiName: mapped.apiName };
}

// =====================
// BUSINESS RULES VALIDATION (your custom rules)
// =====================
function validateBusinessRules(cols: Record<string, MondayColumnValue>): string[] {
  const errors: string[] = [];

  // 1) Mod Transport Principal (color_mkx12a19) must be "Rutier / Road" or "Alege!"
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

  // 2) Tip Marfa must NOT be "Deșeuri / Waste"
  const tipMarfa = (cols["dropdown_mkx1s5nv"]?.text ?? "").trim();
  if (tipMarfa) {
    const normalized = normalizeRoLabel(tipMarfa);
    if (normalized.includes("deseuri") || normalized.includes("waste")) {
      errors.push(`Tip Marfa nu poate fi «Deșeuri / Waste». Valoare curentă: «${tipMarfa}»`);
    }
  }

  return errors;
}

// =====================
// REQUIRED FIELDS VALIDATION
// =====================
function validateRequired(cols: Record<string, MondayColumnValue>): string[] {
  const errors: string[] = [];

  const isNonEmptyText = (id: string) => (cols[id]?.text ?? "").trim().length > 0;

  // People check is skipped only in explicit test override mode.
  if (!FORCE_TEST_AUTH_MODE) {
    const principalId = getFirstPersonIdFromPeopleValue(cols[DEAL_OWNER_COLUMN_ID]?.value ?? null);
    const preluatDeId = getFirstPersonIdFromPeopleValue(cols[PRELUAT_DE_COLUMN_ID]?.value ?? null);
    if (!principalId && !preluatDeId) {
      errors.push("Trebuie completat fie 'Principal', fie 'Preluat de'.");
    }
  }

  // Buget Client (numbers) > 0
  const bugetTxt = (cols["numeric_mkr4e4qc"]?.text ?? "").trim();
  const buget = parseNumberLoose(bugetTxt);
  if (!bugetTxt || !Number.isFinite(buget) || buget <= 0) {
    errors.push("Buget Client trebuie sa fie un numar > 0.");
  }

  // Moneda (status) required
  if (!isNonEmptyText("color_mksh2abx")) errors.push("Moneda este obligatorie.");

  // Tara/Localitate incarcare
  if (!isNonEmptyText("dropdown_mkx6jyjf")) errors.push("Tara Incarcare este obligatorie.");
  if (!isNonEmptyText("text_mkypcczr")) errors.push("Localitate Incarcare este obligatorie.");

  // Tara/Localitate descarcare
  if (!isNonEmptyText("dropdown_mkx687jv")) errors.push("Tara Descarcare este obligatorie.");
  if (!isNonEmptyText("text_mkypxb8h")) errors.push("Localitate Descarcare este obligatorie.");

  // Greutate > 0
  const greutateTxt = (cols["text_mkt9nr81"]?.text ?? "").trim();
  const greutate = parseNumberLoose(greutateTxt);
  if (!greutateTxt || !Number.isFinite(greutate) || greutate <= 0) {
    errors.push("Greutate (KG) trebuie sa fie un numar > 0.");
  }

  // Data Inc required
  if (!isNonEmptyText("date_mkx77z0m")) errors.push("Data Inc. este obligatorie.");

  // Nr zile valabile > 0 (if column exists). If the column is missing on board,
  // payload builder will use DEFAULT_LOADING_INTERVAL_DAYS.
  const zileCol = cols["numeric_mkypzwfe"];
  if (zileCol) {
    const zileTxt = (zileCol.text ?? "").trim();
    const zile = parseNumberLoose(zileTxt);
    if (!zileTxt || !Number.isFinite(zile) || zile <= 0) {
      errors.push("Nr. zile valabile Incarcare trebuie sa fie un numar > 0.");
    }
  }

  // Tip Mijloc Transport required
  if (!isNonEmptyText("dropdown_mkx1s5nv")) errors.push("Tip Mijloc Transport este obligatoriu.");

  return errors;
}

// =====================
// BUILD payload for 123cargo /loads
// =====================
function buildLoadPayload(cols: Record<string, MondayColumnValue>, itemId: string) {
  const errors: string[] = [];

  const srcCountryRaw = (cols["dropdown_mkx6jyjf"]?.text ?? "").trim(); // Tara Incarcare
  const srcCity = (cols["text_mkypcczr"]?.text ?? "").trim();          // Localitate Incarcare

  const dstCountryRaw = (cols["dropdown_mkx687jv"]?.text ?? "").trim(); // Tara Descarcare
  const dstCity = (cols["text_mkypxb8h"]?.text ?? "").trim();           // Localitate Descarcare

  const weightTxt = (cols["text_mkt9nr81"]?.text ?? "").trim();         // Greutate (KG)
  const loadingDate = getDateISOFromDateColumn(cols["date_mkx77z0m"]);  // Data Inc.
  const loadingIntervalCol = cols["numeric_mkypzwfe"];
  const loadingIntervalTxt = (loadingIntervalCol?.text ?? "").trim(); // Nr zile valabile

  const transportLabel = (cols["dropdown_mkx1s5nv"]?.text ?? "").trim(); // Tip mijloc transport

  const budgetTxt = (cols["numeric_mkr4e4qc"]?.text ?? "").trim(); // Buget client
  const currencyTxt = (cols["color_mksh2abx"]?.text ?? "").trim();  // Moneda

  // Flags from optional column
  const flagsRaw = FLAGS_COLUMN_ID ? (cols[FLAGS_COLUMN_ID]?.text ?? "").trim() : "";
  const flags = parseFlagsFromText(flagsRaw);

  // required: loadingDate
  if (!loadingDate) errors.push("Data Inc. invalidă (loadingDate).");

  // required: loadingInterval
  let loadingInterval = DEFAULT_LOADING_INTERVAL_DAYS;
  if (loadingIntervalCol) {
    loadingInterval = parseNumberLoose(loadingIntervalTxt);
    if (!Number.isFinite(loadingInterval) || loadingInterval <= 0) {
      errors.push("Nr. zile valabile Incarcare invalid (loadingInterval).");
    }
  } else {
    console.warn(
      `[FALLBACK] item ${itemId}: coloana numeric_mkypzwfe lipseste. Folosesc DEFAULT_LOADING_INTERVAL_DAYS=${DEFAULT_LOADING_INTERVAL_DAYS}.`
    );
  }

  // required: weight
  const weight = parseNumberLoose(weightTxt);
  if (!Number.isFinite(weight) || weight <= 0) errors.push("Greutate invalidă (weight).");

  // required: place city: {name, country ISO2}
  const srcCountry = normalizeCountry2LetterEnglish(srcCountryRaw);
  if (!srcCountry) errors.push(`Țara Încărcare nu se poate mapa la ISO2: '${srcCountryRaw}'`);
  if (!srcCity) errors.push("Localitate Încărcare lipsă (source.name).");

  const dstCountry = normalizeCountry2LetterEnglish(dstCountryRaw);
  if (!dstCountry) errors.push(`Țara Descărcare nu se poate mapa la ISO2: '${dstCountryRaw}'`);
  if (!dstCity) errors.push("Localitate Descărcare lipsă (destination.name).");

  // required: truck type
  const tt = mapTruckTypeFromMondayUi(transportLabel);
  if (!tt.ok) errors.push(tt.error);

  // price + currency
  const budget = parseNumberLoose(budgetTxt);
  if (!Number.isFinite(budget) || budget <= 0) errors.push("Buget Client invalid (offeredPrice.price).");

  const currency = normalizeCurrency3(currencyTxt);
  if (!currency) errors.push("Moneda invalidă (folosește RON/EUR/USD sau label mapabil).");

  // requiredTruck[] (support combos + agabarit)
  const requiredTruck: number[] = [];
  if (tt.ok) requiredTruck.push(tt.code);
  if (flags.agabarit) requiredTruck.push(9); // Oversized

  const uniqueRequiredTruck = Array.from(new Set(requiredTruck));
  if (uniqueRequiredTruck.length === 0) errors.push("requiredTruck invalid (gol).");

  // Compose notes (including sliding floor)
  const notes: string[] = [];
  if (flagsRaw) notes.push(`Cerințe: ${flagsRaw}`);
  else {
    if (flags.slidingFloor) notes.push("Necesar: podea culisantă (sliding floor).");
    if (flags.agabarit) notes.push("Marfă agabaritică / oversized.");
    if (flags.adr) notes.push("ADR (hazardous).");
    if (flags.frigo) notes.push("Frigo / temperatură controlată.");
  }

  const description = notes.length ? notes.join(" ") : "";

  const externalReference = Number.parseInt(itemId, 10);

  const payload: any = {
    externalReference: Number.isFinite(externalReference) ? externalReference : undefined,

    loadingDate,
    loadingInterval: Math.trunc(loadingInterval),

    requiredTruck: uniqueRequiredTruck,

    weight,

    source: srcCountry && srcCity ? { name: srcCity, country: srcCountry } : undefined,
    destination: dstCountry && dstCity ? { name: dstCity, country: dstCountry } : undefined,

    // Flags that are truly supported by API
    hazardous: flags.adr ? true : undefined,
    temperatureControlled: flags.frigo ? true : undefined,

    offeredPrice: {
      price: budget,
      currency,
      vat: true,
    },

    // Text for things not supported as dedicated fields (e.g., sliding floor)
    description: description || undefined,
    privateNotice: undefined as string | undefined,
  };

  // Optionally also put notes in privateNotice (or from a monday column)
  if (PRIVATE_NOTICE_COLUMN_ID) {
    const pn = (cols[PRIVATE_NOTICE_COLUMN_ID]?.text ?? "").trim();
    payload.privateNotice = pn || (description ? description : undefined);
  }

  // clean undefined
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k];
  }

  return { payload, errors };
}

// =====================
// 123CARGO CALL (POST /loads)
// =====================
async function postLoad(authHeader: string, payload: any) {
  const res = await axios.post(`${BURSA_BASE}/loads`, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    validateStatus: () => true,
  });
  return res;
}

// =====================
// EXPRESS
// =====================
const app = express();
app.use(express.json());

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/webhooks/monday", async (req, res) => {
  const body = req.body as MondayWebhookBody;

  if (body?.challenge) return res.status(200).json({ challenge: body.challenge });

  try {
    const event = body?.event;
    if (!event) return res.status(200).json({ ok: true });

    const boardIdRaw = event.boardId;
    const itemIdRaw = event.pulseId ?? event.itemId;
    const triggerStatusColId = String(event.columnId ?? "");
    if (boardIdRaw === undefined || boardIdRaw === null || itemIdRaw === undefined || itemIdRaw === null) {
      console.warn("[WEBHOOK] missing boardId/itemId in event payload");
      return res.status(200).json({ ok: true, skipped: true });
    }
    if (!triggerStatusColId) {
      console.warn("[WEBHOOK] missing columnId in event payload");
      return res.status(200).json({ ok: true, skipped: true });
    }
    const boardId = String(boardIdRaw);
    const itemId = String(itemIdRaw);
    const scope = `[WEBHOOK board=${boardId} item=${itemId}]`;

    console.log(`${scope} received for column=${triggerStatusColId}`);

    const item = await fetchItem(boardId, itemId);
    const cols = colsToMap(item.column_values);

    // Optional: only process when status equals TRIGGER_ONLY_LABEL
    if (TRIGGER_ONLY_LABEL) {
      const currentLabel = getStatusLabel(cols[triggerStatusColId]);
      if (currentLabel && currentLabel !== TRIGGER_ONLY_LABEL) {
        console.log(
          `${scope} skipped: trigger label mismatch (current='${currentLabel}', expected='${TRIGGER_ONLY_LABEL}')`
        );
        return res.status(200).json({ ok: true, skipped: true });
      }
    }

    // 1) Business rules first
    const businessErrors = validateBusinessRules(cols);
    if (businessErrors.length) {
      console.warn(`${scope} business validation failed: ${businessErrors.join("; ")}`);
      await changeTextColumn(boardId, itemId, ERROR_COLUMN_ID, `[BUSINESS RULES] ${businessErrors.join("; ")}`);
      await changeStatusLabel(boardId, itemId, triggerStatusColId, ERROR_LABEL);
      return res.status(200).json({ ok: true });
    }

    // 2) pick user for 123cargo (Principal > Preluat de)
    const authPick = pickBasicAuthHeaderFromOwner(cols);
    if (!authPick.ok) {
      console.warn(`${scope} auth pick failed: ${authPick.error}`);
      await changeTextColumn(boardId, itemId, ERROR_COLUMN_ID, `[USER] ${authPick.error}`);
      await changeStatusLabel(boardId, itemId, triggerStatusColId, ERROR_LABEL);
      return res.status(200).json({ ok: true });
    }

    // 3) validate required
    const validationErrors = validateRequired(cols);
    if (validationErrors.length) {
      console.warn(`${scope} required validation failed: ${validationErrors.join("; ")}`);
      await changeTextColumn(boardId, itemId, ERROR_COLUMN_ID, `[VALIDATION] ${validationErrors.join("; ")}`);
      await changeStatusLabel(boardId, itemId, triggerStatusColId, ERROR_LABEL);
      return res.status(200).json({ ok: true });
    }

    // 4) mapping to 123cargo (/loads)
    const { payload, errors: mapErrors } = buildLoadPayload(cols, itemId);
    if (mapErrors.length) {
      console.warn(`${scope} mapping failed: ${mapErrors.join("; ")}`);
      await changeTextColumn(boardId, itemId, ERROR_COLUMN_ID, `[MAPPING] ${mapErrors.join("; ")}`);
      await changeStatusLabel(boardId, itemId, triggerStatusColId, ERROR_LABEL);
      return res.status(200).json({ ok: true });
    }

    // 5) call 123cargo
    const bursaRes = await postLoad(authPick.authHeader, payload);
    const ok = bursaRes.status === 200 && bursaRes.data?.resultCode === 0;

    if (ok) {
      console.log(`${scope} 123cargo success`);
      await changeStatusLabel(boardId, itemId, triggerStatusColId, SUCCESS_LABEL);
      await changeTextColumn(boardId, itemId, ERROR_COLUMN_ID, "");
    } else {
      console.warn(
        `${scope} 123cargo failed: HTTP ${bursaRes.status} body=${JSON.stringify(bursaRes.data)?.slice(0, 800)}`
      );
      const msg = `[123CARGO] HTTP ${bursaRes.status} - ${JSON.stringify(bursaRes.data)?.slice(0, 800)}`;
      await changeTextColumn(boardId, itemId, ERROR_COLUMN_ID, msg);
      await changeStatusLabel(boardId, itemId, triggerStatusColId, ERROR_LABEL);
    }

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    // Return 200 to avoid monday retries
    console.error(`[WEBHOOK] internal error: ${String(e?.message ?? "")}`);
    return res.status(200).json({ ok: true, error: "internal", detail: String(e?.message ?? "") });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
