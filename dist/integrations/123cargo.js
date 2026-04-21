import axios from "axios";
import { getConfig } from "../utils/config.js";
import { getFirstPersonIdFromPeopleValue } from "../utils/mondayParsing.js";
function normalizeEmailKey(email) {
    return email.trim().toLowerCase();
}
function encodeBasicAuth(username, password) {
    const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    return `Basic ${token}`;
}
/**
 * Builds Basic Auth for 123cargo from Principal → Monday user email → configured username map.
 * No fallback to "Preluat de".
 */
export async function resolveBasicAuthForBursa(monday, cols) {
    const cfg = getConfig();
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
    if (!mapped?.username) {
        return { ok: false, error: `Userul din Principal nu este configurat pentru Bursa: ${rawEmail}` };
    }
    return { ok: true, authHeader: encodeBasicAuth(mapped.username, cfg.bursaPassword) };
}
export async function postLoadTo123Cargo(authHeader, payload) {
    const cfg = getConfig();
    return axios.post(`${cfg.bursaBase}/loads`, payload, {
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        validateStatus: () => true,
    });
}
