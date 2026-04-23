import type { MondayColumnValue } from "../services/mondayClient.js";

export function colsToMap(columnValues: MondayColumnValue[]) {
  return Object.fromEntries(columnValues.map((c) => [c.id, c])) as Record<string, MondayColumnValue>;
}

export function getStatusLabel(col: MondayColumnValue | undefined): string {
  const text = (col?.text ?? "").trim();
  // Monday status columns typically expose the selected label via `text`.
  if (text) return text;
  if (!col?.value) return "";
  try {
    const v = JSON.parse(col.value);
    return String(v?.label || "");
  } catch {
    return "";
  }
}

export function getFirstPersonIdFromPeopleValue(valueJson: string | null): number | null {
  if (!valueJson) return null;
  try {
    const v = JSON.parse(valueJson);
    const persons = v?.personsAndTeams;
    if (!Array.isArray(persons) || persons.length === 0) return null;
    const id = persons[0]?.id;
    if (id == null) return null;
    const n = typeof id === "string" ? Number(id) : id;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function normalizeRoLabel(s: string): string {
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

export function stripRightSideAfterSlash(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t) return "";
  if (!t.includes("/")) return t;
  return t.split("/").pop()!.trim();
}

export function parseNumberLoose(s: string): number {
  const n = Number(String(s ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : NaN;
}

export function getDateISOFromDateColumn(col: MondayColumnValue | undefined): string | null {
  if (!col) return null;
  if (col.value) {
    try {
      const v = JSON.parse(col.value) as { date?: unknown; time?: unknown; changed_at?: unknown };
      if (typeof v?.date === "string" && v.date.trim()) {
        const normalized = normalizeYyyyMmDd(v.date.trim());
        if (normalized) return normalized;
      }
    } catch {
      /* ignore */
    }
  }
  const t = (col.text ?? "").trim();
  return normalizeYyyyMmDd(t) || null;
}

function normalizeYyyyMmDd(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // Already ISO date (optionally with time suffix)
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // DD-MM-YYYY (common Monday display formats)
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const y = Number(dmy[3]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // DD/MM/YYYY
  const dmySlash = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmySlash) {
    const d = Number(dmySlash[1]);
    const m = Number(dmySlash[2]);
    const y = Number(dmySlash[3]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return null;
}
