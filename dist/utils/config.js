import dotenv from "dotenv";
dotenv.config();
const DEFAULT_BURSA_USER_MAP_BY_EMAIL = {
    "alexandru.n@crystal-logistics-services.com": { username: "Transport.202501" },
    "andrei.p@crystal-logistics-services.com": { username: "Transport.5253" },
    "denisa.i@crystal-logistics-services.com": { username: "Transport.2601" },
};
function reqEnv(name) {
    const v = process.env[name];
    if (!v)
        throw new Error(`Missing env var: ${name}`);
    return v;
}
function normalizeEmailKey(email) {
    return email.trim().toLowerCase();
}
function parseBursaUserMapFromJson(raw) {
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [email, entry] of Object.entries(parsed)) {
        const key = normalizeEmailKey(email);
        if (!key)
            continue;
        if (!entry || typeof entry !== "object")
            throw new Error(`Invalid map entry for "${email}"`);
        const username = entry.username;
        if (typeof username !== "string" || !username.trim()) {
            throw new Error(`Invalid username for "${email}"`);
        }
        out[key] = { username: username.trim() };
    }
    return out;
}
function loadBursaUserMapByEmail() {
    const raw = process.env.BURSA_USER_MAP_BY_EMAIL_JSON?.trim();
    if (!raw) {
        return { ...DEFAULT_BURSA_USER_MAP_BY_EMAIL };
    }
    return parseBursaUserMapFromJson(raw);
}
let cached = null;
export function getConfig() {
    if (cached)
        return cached;
    cached = {
        port: Number(process.env.PORT || 3000),
        mondayToken: reqEnv("MONDAY_TOKEN"),
        bursaBase: reqEnv("BURSA_BASE"),
        bursaPassword: reqEnv("BURSA_PASSWORD"),
        mondayColumns: {
            dealOwner: reqEnv("DEAL_OWNER_COLUMN_ID"),
            error: reqEnv("ERROR_COLUMN_ID"),
            publicationBursa: process.env.PUBLICARE_BURSA_COLUMN_ID?.trim() || "color_mkyp8xqz",
        },
        publicationBursa: {
            triggerLabel: process.env.PUBLICARE_BURSA_TRIGGER_LABEL?.trim() || "Publica pe bursa",
            processingLabel: process.env.PUBLICARE_BURSA_PROCESSING_LABEL?.trim() || "Procesare",
            successLabel: reqEnv("TRIGGER_STATUS_SUCCESS_LABEL"),
            errorLabel: reqEnv("TRIGGER_STATUS_ERROR_LABEL"),
        },
        flagsColumnId: process.env.FLAGS_COLUMN_ID?.trim() || "",
        privateNoticeColumnId: process.env.PRIVATE_NOTICE_COLUMN_ID?.trim() || "",
        auth: {
            bursaUserMapByEmail: loadBursaUserMapByEmail(),
        },
    };
    return cached;
}
