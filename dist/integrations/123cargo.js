import axios from "axios";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { buildLoadPayload, validateBusinessRules, validateRequired } from "../services/loadProcessing.js";
import { getFirstPersonIdFromPeopleValue } from "../utils/mondayParsing.js";
function buildBasicAuthHeader(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
function normalizeEmailKey(email) {
    return email.trim().toLowerCase();
}
/**
 * Principal → Monday user → email → `bursaUserMapByEmail` → Basic Auth.
 * No "Preluat de" fallback.
 */
export async function resolveBasicAuthForBursa(monday, cols) {
    const cfg = getConfig();
    if (cfg.auth.forceTestMode) {
        if (!cfg.auth.testUsername || !cfg.auth.testPassword) {
            return {
                ok: false,
                error: "FORCE_TEST_AUTH_MODE activ, dar lipsesc TEST_BURSA_USERNAME / TEST_BURSA_PASSWORD.",
            };
        }
        return { ok: true, authHeader: buildBasicAuthHeader(cfg.auth.testUsername, cfg.auth.testPassword) };
    }
    const principalId = getFirstPersonIdFromPeopleValue(cols[cfg.mondayColumns.dealOwner]?.value ?? null);
    if (principalId == null) {
        return { ok: false, error: "Coloana Principal nu este completată." };
    }
    const user = await monday.fetchUserById(principalId);
    if (!user) {
        return { ok: false, error: "Nu s-a putut determina emailul userului din Principal." };
    }
    const rawEmail = user.email?.trim();
    if (!rawEmail) {
        return { ok: false, error: "Nu s-a putut determina emailul userului din Principal." };
    }
    const key = normalizeEmailKey(rawEmail);
    const mapped = cfg.auth.bursaUserMapByEmail[key];
    if (!mapped) {
        return { ok: false, error: `Userul din Principal nu este configurat pentru Bursa: ${rawEmail}` };
    }
    if (!mapped.password) {
        return { ok: false, error: `Userul din Principal nu are parola Bursa configurată: ${rawEmail}` };
    }
    return { ok: true, authHeader: buildBasicAuthHeader(key, mapped.password) };
}
function colsFromContext(context) {
    return Object.fromEntries(context.item.column_values.map((c) => [c.id, c]));
}
function toResultError(prefix, errors) {
    return { status: "error", message: `[${prefix}] ${errors.join("; ")}` };
}
export function bursaResponseRequiresTwoStep(status, data) {
    if (status === 409)
        return true;
    return String(data?.response || "").toLowerCase().includes("2 step authentication required");
}
function normalizeTwoStepCookieValue(raw) {
    if (typeof raw !== "string")
        return null;
    let s = raw.trim();
    if (!s)
        return null;
    s = s.replace(/^"+|"+$/g, "").trim();
    const named = s.match(/Bursa-2step-authentication\s*=\s*([^;,\s]+)/i);
    if (named?.[1])
        return named[1].trim();
    const firstPart = s.split(";")[0]?.trim() || "";
    const eqIndex = firstPart.indexOf("=");
    if (eqIndex > 0) {
        const key = firstPart.slice(0, eqIndex).trim();
        const value = firstPart.slice(eqIndex + 1).trim();
        if (/bursa-2step-authentication/i.test(key) && value)
            return value;
    }
    if (/^[^\s;]+$/.test(s))
        return s;
    return null;
}
function extractTwoStepCookie(data, setCookieHeader) {
    const d = data;
    const candidates = [
        d?.response,
        d?.response?.cookie,
        d?.response?.value,
        d?.response?.["Bursa-2step-authentication"],
        d?.["Bursa-2step-authentication"],
        d?.cookie,
    ];
    for (const candidate of candidates) {
        const val = normalizeTwoStepCookieValue(candidate);
        if (val)
            return val;
    }
    const setCookie = Array.isArray(setCookieHeader)
        ? setCookieHeader
        : typeof setCookieHeader === "string"
            ? [setCookieHeader]
            : [];
    for (const line of setCookie) {
        const val = normalizeTwoStepCookieValue(String(line));
        if (val)
            return val;
    }
    return null;
}
async function postLoad(authHeader, payload, twoStepCookie) {
    const base = getConfig().bursaBase;
    logger.info("Bursa /loads outgoing payload (redacted)", { payload: redactBursaLoadsPayload(payload) });
    return axios.post(`${base}/loads`, payload, {
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: authHeader,
            ...(twoStepCookie ? { Cookie: `Bursa-2step-authentication=${twoStepCookie}` } : {}),
        },
        validateStatus: () => true,
    });
}
function redactBursaLoadsPayload(payload) {
    if (!payload || typeof payload !== "object")
        return { _rawType: typeof payload };
    const p = payload;
    const out = { ...p };
    const redactString = (key, max = 240) => {
        const v = out[key];
        if (typeof v !== "string")
            return;
        if (v.length <= max)
            return;
        out[key] = `${v.slice(0, max)}…[redacted:${v.length}chars]`;
    };
    redactString("description", 240);
    redactString("privateNotice", 240);
    // Avoid logging full nested objects verbatim if they grow; shallow copy is enough for diagnostics.
    return out;
}
export async function postBursaLoad(authHeader, payload) {
    return postLoad(authHeader, payload);
}
async function submitTwoStepCode(authHeader, code) {
    const base = getConfig().bursaBase;
    const form = new URLSearchParams({ code });
    const formRes = await axios.post(`${base}/login/login`, form.toString(), {
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            Authorization: authHeader,
        },
        validateStatus: () => true,
    });
    if (formRes.status !== 409)
        return formRes;
    return axios.post(`${base}/login/login`, { code }, {
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: authHeader,
        },
        validateStatus: () => true,
    });
}
async function deleteLoad(authHeader, loadId) {
    const base = getConfig().bursaBase;
    return axios.delete(`${base}/loads/${encodeURIComponent(loadId)}`, {
        headers: { Accept: "application/json", Authorization: authHeader },
        validateStatus: () => true,
    });
}
async function publishLoad(context) {
    const monday = context.mondayClient;
    if (!monday) {
        return { status: "error", message: "[USER] Monday client lipsește din context (necesar pentru autentificare)." };
    }
    const cols = colsFromContext(context);
    const businessErrors = validateBusinessRules(cols);
    if (businessErrors.length)
        return toResultError("BUSINESS RULES", businessErrors);
    const auth = await resolveBasicAuthForBursa(monday, cols);
    if (!auth.ok)
        return { status: "error", message: `[USER] ${auth.error}` };
    const validationErrors = validateRequired(cols);
    if (validationErrors.length)
        return toResultError("VALIDATION", validationErrors);
    const { payload, errors: mapErrors } = buildLoadPayload(cols, Number(context.itemId));
    if (mapErrors.length)
        return toResultError("MAPPING", mapErrors);
    logger.info("Bursa publish debug: outgoing payload snapshot", {
        loadingDateApi: payload.loadingDate,
        loadingInterval: payload.loadingInterval,
        externalReference: payload.externalReference,
    });
    const response = await postLoad(auth.authHeader, payload);
    if (bursaResponseRequiresTwoStep(response.status, response.data)) {
        return { status: "requires_two_step", message: "[2STEP] Bursa solicită cod de autentificare." };
    }
    const ok = response.status === 200 && response.data?.resultCode === 0;
    if (ok)
        return { status: "success" };
    const contentType = String(response.headers?.["content-type"] || "unknown");
    const body = JSON.stringify(response.data)?.slice(0, 900);
    return { status: "error", message: `[123CARGO] HTTP ${response.status} (${contentType}) - ${body}` };
}
async function completeTwoStepPublish(context, code) {
    const monday = context.mondayClient;
    if (!monday) {
        return { status: "error", message: "[USER] Monday client lipsește din context (necesar pentru autentificare)." };
    }
    const cols = colsFromContext(context);
    const auth = await resolveBasicAuthForBursa(monday, cols);
    if (!auth.ok)
        return { status: "error", message: `[USER] ${auth.error}` };
    const validationErrors = validateRequired(cols);
    if (validationErrors.length)
        return toResultError("VALIDATION", validationErrors);
    const { payload, errors: mapErrors } = buildLoadPayload(cols, Number(context.itemId));
    if (mapErrors.length)
        return toResultError("MAPPING", mapErrors);
    logger.info("Bursa publish debug: outgoing payload snapshot (2-step)", {
        loadingDateApi: payload.loadingDate,
        loadingInterval: payload.loadingInterval,
        externalReference: payload.externalReference,
    });
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
    if (ok)
        return { status: "success" };
    const contentType = String(publishRes.headers?.["content-type"] || "unknown");
    const body = JSON.stringify(publishRes.data)?.slice(0, 900);
    return { status: "error", message: `[123CARGO] HTTP ${publishRes.status} (${contentType}) - ${body}` };
}
async function removeLoad(context) {
    const monday = context.mondayClient;
    if (!monday) {
        return { status: "error", message: "[USER] Monday client lipsește din context (necesar pentru autentificare)." };
    }
    const cols = colsFromContext(context);
    const extCol = getConfig().mondayColumns.externalLoadId;
    const loadId = extCol ? (cols[extCol]?.text ?? "").trim() : "";
    if (!extCol) {
        return { status: "error", message: "[123CARGO] EXTERNAL_LOAD_ID_COLUMN_ID is not configured." };
    }
    if (!loadId) {
        return { status: "error", message: "[123CARGO] Missing external load id on item." };
    }
    const auth = await resolveBasicAuthForBursa(monday, cols);
    if (!auth.ok)
        return { status: "error", message: `[USER] ${auth.error}` };
    const response = await deleteLoad(auth.authHeader, loadId);
    const ok = response.status === 200 && response.data?.resultCode === 0;
    if (ok)
        return { status: "success" };
    return { status: "error", message: `[123CARGO] DELETE failed: HTTP ${response.status} - ${JSON.stringify(response.data)}` };
}
export const cargo123Integration = {
    name: "123cargo",
    publishLoad,
    removeLoad,
    completeTwoStepPublish,
};
