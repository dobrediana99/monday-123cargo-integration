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
      const v = JSON.parse(col.value);
      if (v?.date) return String(v.date);
    } catch {
      /* ignore */
    }
  }
  const t = (col.text ?? "").trim();
  return t || null;
}
