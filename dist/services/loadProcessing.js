import countries from "i18n-iso-countries";
import { createRequire } from "module";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { getDateISOFromDateColumn, getFirstPersonIdFromPeopleValue, normalizeRoLabel, parseNumberLoose, stripRightSideAfterSlash, } from "../utils/mondayParsing.js";
const require = createRequire(import.meta.url);
const en = require("i18n-iso-countries/langs/en.json");
countries.registerLocale(en);
const UI_RO_TO_123CARGO_TRUCKTYPE = {
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
function normalizeCountry2LetterEnglish(input) {
    const t = (input ?? "").trim();
    if (!t)
        return null;
    if (/^[A-Za-z]{2}$/.test(t))
        return t.toUpperCase();
    const iso2 = countries.getAlpha2Code(t, "en");
    return iso2 ? iso2.toUpperCase() : null;
}
function normalizeCurrency3(input) {
    const raw = (input ?? "").trim();
    if (!raw)
        return null;
    const upper = raw.toUpperCase();
    if (/^[A-Z]{3}$/.test(upper))
        return upper;
    const norm = normalizeRoLabel(raw);
    const map = {
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
export function parseFlagsFromText(raw) {
    const t = normalizeRoLabel(raw);
    const adr = /\badr\b/.test(t) || t.includes("hazard");
    const frigo = t.includes("frigo") ||
        t.includes("frig") ||
        t.includes("temperatura controlata") ||
        t.includes("temperature controlled") ||
        t.includes("reefer");
    const agabarit = t.includes("agabarit") || t.includes("oversize") || t.includes("oversized");
    const slidingFloor = t.includes("podea culisanta") || t.includes("sliding floor") || t.includes("walking floor");
    return { adr, frigo, agabarit, slidingFloor };
}
export function mapTruckTypeFromMondayUi(labelRaw) {
    const rightSide = stripRightSideAfterSlash(labelRaw);
    const key = normalizeRoLabel(rightSide);
    if (!key)
        return { ok: false, error: "Tip Mijloc Transport gol." };
    const mapped = UI_RO_TO_123CARGO_TRUCKTYPE[key];
    if (mapped === undefined) {
        // Heuristic fallback for English dropdown labels like "Mega Truck (Curtain-Sided)".
        if (key.includes("curtain") && (key.includes("truck") || key.includes("mega"))) {
            return { ok: true, code: 2, apiName: "Tilt" };
        }
        return { ok: false, error: `Tip Mijloc Transport necunoscut: '${labelRaw}'` };
    }
    if (mapped === null) {
        return {
            ok: false,
            error: `Tip Mijloc Transport '${labelRaw}' nu are corespondent valid în 123cargo.`,
        };
    }
    return { ok: true, code: mapped.code, apiName: mapped.apiName };
}
export function validateBusinessRules(cols) {
    const errors = [];
    const modTransportPrincipal = (cols["color_mkx12a19"]?.text ?? "").trim();
    if (modTransportPrincipal) {
        const normalized = modTransportPrincipal.toLowerCase();
        const isValid = normalized === "rutier / road" ||
            normalized === "rutier" ||
            normalized === "road" ||
            normalized === "alege!" ||
            normalized === "alege";
        if (!isValid) {
            errors.push(`Modul de transport principal trebuie să fie «Rutier / Road» sau «Alege!», nu «${modTransportPrincipal}»`);
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
export function validateRequired(cols) {
    const errors = [];
    const cfg = getConfig();
    const isNonEmptyText = (id) => (cols[id]?.text ?? "").trim().length > 0;
    const principalId = getFirstPersonIdFromPeopleValue(cols[cfg.mondayColumns.dealOwner]?.value ?? null);
    if (!principalId) {
        errors.push("Coloana Principal nu este completată.");
    }
    const bugetTxt = (cols["numeric_mkr4e4qc"]?.text ?? "").trim();
    const buget = parseNumberLoose(bugetTxt);
    if (!bugetTxt || !Number.isFinite(buget) || buget <= 0) {
        errors.push("Buget Client trebuie sa fie un numar > 0.");
    }
    if (!isNonEmptyText("color_mksh2abx"))
        errors.push("Moneda este obligatorie.");
    if (!isNonEmptyText("dropdown_mkx6jyjf"))
        errors.push("Tara Incarcare este obligatorie.");
    if (!isNonEmptyText("text_mkypcczr"))
        errors.push("Localitate Incarcare este obligatorie.");
    if (!isNonEmptyText("dropdown_mkx687jv"))
        errors.push("Tara Descarcare este obligatorie.");
    if (!isNonEmptyText("text_mkypxb8h"))
        errors.push("Localitate Descarcare este obligatorie.");
    const greutateTxt = (cols["text_mkt9nr81"]?.text ?? "").trim();
    const greutate = parseNumberLoose(greutateTxt);
    if (!greutateTxt || !Number.isFinite(greutate) || greutate <= 0) {
        errors.push("Greutate (KG) trebuie sa fie un numar > 0.");
    }
    if (!isNonEmptyText("date_mkx77z0m"))
        errors.push("Data Inc. este obligatorie.");
    // Default to 1 day if missing/0/invalid in Monday.
    const zileTxt = (cols["numeric_mm2m66q1"]?.text ?? "").trim();
    const zile = parseNumberLoose(zileTxt);
    void zile; // value is used in payload build (defaults to 1); no hard validation here.
    if (!isNonEmptyText("dropdown_mkx1s5nv"))
        errors.push("Tip Mijloc Transport este obligatoriu.");
    return errors;
}
export function buildLoadPayload(cols, itemId) {
    const cfg = getConfig();
    const errors = [];
    const srcCountryRaw = (cols["dropdown_mkx6jyjf"]?.text ?? "").trim();
    const srcCity = (cols["text_mkypcczr"]?.text ?? "").trim();
    const dstCountryRaw = (cols["dropdown_mkx687jv"]?.text ?? "").trim();
    const dstCity = (cols["text_mkypxb8h"]?.text ?? "").trim();
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
    if (!loadingDate)
        errors.push("Data Inc. invalidă (loadingDate).");
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
            errors.push(`Data Încărcare invalidă pentru Bursa: ${cmp.reason} (trimis: '${loadingDate}', azi RO: '${cmp.todayRo}', min: '${cmp.minRo}', max: '${cmp.maxRo}')`);
        }
    }
    const allowSameDayForLog = (process.env.BURSA_ALLOW_SAME_DAY_LOADING_DATE || "").trim() === "1";
    logger.info("Bursa payload debug: loadingDate", {
        loadingDateColumnId: LOADING_DATE_COLUMN_ID,
        mondayDateColumn: loadingCol
            ? { id: loadingCol.id, text: loadingCol.text ?? null, value: loadingCol.value ?? null }
            : null,
        parsedLoadingDate: loadingDate,
        bucharestTodayYmd: ymdTodayEuropeBucharest(),
        bucharestMinYmd: addDaysYmd(ymdTodayEuropeBucharest(), allowSameDayForLog ? 0 : 1),
        bucharestMaxYmd: addDaysYmd(ymdTodayEuropeBucharest(), 30),
        allowSameDayLoadingDate: allowSameDayForLog,
        itemId,
    });
    const loadingIntervalRaw = parseNumberLoose(loadingIntervalTxt);
    const loadingInterval = Number.isFinite(loadingIntervalRaw) && loadingIntervalRaw > 0 ? loadingIntervalRaw : 1;
    const weight = parseNumberLoose(weightTxt);
    if (!Number.isFinite(weight) || weight <= 0)
        errors.push("Greutate invalidă (weight).");
    const srcCountry = normalizeCountry2LetterEnglish(srcCountryRaw);
    if (!srcCountry)
        errors.push(`Țara Încărcare nu se poate mapa la ISO2: '${srcCountryRaw}'`);
    if (!srcCity)
        errors.push("Localitate Încărcare lipsă (source.name).");
    const dstCountry = normalizeCountry2LetterEnglish(dstCountryRaw);
    if (!dstCountry)
        errors.push(`Țara Descărcare nu se poate mapa la ISO2: '${dstCountryRaw}'`);
    if (!dstCity)
        errors.push("Localitate Descărcare lipsă (destination.name).");
    const tt = mapTruckTypeFromMondayUi(transportLabel);
    if (!tt.ok)
        errors.push(tt.error);
    const budget = parseNumberLoose(budgetTxt);
    if (!Number.isFinite(budget) || budget <= 0)
        errors.push("Buget Client invalid (offeredPrice.price).");
    const currency = normalizeCurrency3(currencyTxt);
    if (!currency)
        errors.push("Moneda invalidă (folosește RON/EUR/USD sau label mapabil).");
    const requiredTruck = [];
    if (tt.ok)
        requiredTruck.push(tt.code);
    if (flags.agabarit)
        requiredTruck.push(9);
    const uniqueRequiredTruck = Array.from(new Set(requiredTruck));
    if (uniqueRequiredTruck.length === 0)
        errors.push("requiredTruck invalid (gol).");
    const notes = [];
    if (flagsRaw)
        notes.push(`Cerințe: ${flagsRaw}`);
    else {
        if (flags.slidingFloor)
            notes.push("Necesar: podea culisantă (sliding floor).");
        if (flags.agabarit)
            notes.push("Marfă agabaritică / oversized.");
        if (flags.adr)
            notes.push("ADR (hazardous).");
        if (flags.frigo)
            notes.push("Frigo / temperatură controlată.");
    }
    const description = notes.length ? notes.join(" ") : "";
    const payload = {
        externalReference: Number(itemId),
        loadingDate,
        loadingInterval: Math.trunc(loadingInterval),
        requiredTruck: uniqueRequiredTruck,
        weight,
        source: srcCountry && srcCity ? { name: srcCity, country: srcCountry } : undefined,
        destination: dstCountry && dstCity ? { name: dstCity, country: dstCountry } : undefined,
        hazardous: flags.adr ? true : undefined,
        temperatureControlled: flags.frigo ? true : undefined,
        offeredPrice: { price: budget, currency, vat: true },
        description: description || undefined,
        privateNotice: undefined,
    };
    if (cfg.privateNoticeColumnId) {
        const pn = (cols[cfg.privateNoticeColumnId]?.text ?? "").trim();
        payload.privateNotice = pn || (description ? description : undefined);
    }
    for (const k of Object.keys(payload)) {
        if (payload[k] === undefined)
            delete payload[k];
    }
    return { payload, errors };
}
function ymdTodayEuropeBucharest(now = new Date()) {
    // en-CA yields YYYY-MM-DD in most runtimes for calendar dates.
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function addDaysYmd(ymd, days) {
    const { y, m, d } = parseYmd(ymd);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return `${String(dt.getUTCFullYear()).padStart(4, "0")}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
function parseYmd(ymd) {
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m)
        return { y: NaN, m: NaN, d: NaN };
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}
function ymdToUtcDate(ymd) {
    const { y, m, d } = parseYmd(ymd);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d))
        return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
        return null;
    return dt;
}
function compareYmdToBucharestWindow(loadingYmd, opts) {
    const todayRo = ymdTodayEuropeBucharest();
    const minRo = addDaysYmd(todayRo, opts.minOffsetDaysFromToday);
    const maxRo = addDaysYmd(todayRo, opts.maxFutureDaysFromToday);
    const a = ymdToUtcDate(loadingYmd);
    const tMin = ymdToUtcDate(minRo);
    const tMax = ymdToUtcDate(maxRo);
    if (!a || !tMin || !tMax)
        return { ok: false, reason: "format invalid", todayRo, minRo, maxRo };
    if (a < tMin)
        return { ok: false, reason: "prea devreme pentru Bursa (minim mâine în RO)", todayRo, minRo, maxRo };
    if (a > tMax)
        return { ok: false, reason: "peste fereastra permisă (+30 zile față de azi RO)", todayRo, minRo, maxRo };
    return { ok: true };
}
