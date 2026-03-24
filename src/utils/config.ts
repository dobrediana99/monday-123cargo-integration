import dotenv from "dotenv";

dotenv.config();

type IntegrationAction = "publishLoad" | "removeLoad";

type RoutedActionConfig = {
  integration: string;
  action: IntegrationAction;
};

type UserMapEntry = { basicB64: string };

const DEFAULT_USER_MAP: Record<number, UserMapEntry> = {
  96280246: {
    basicB64: "cmFmYWVsLm9AY3J5c3RhbC1sb2dpc3RpY3Mtc2VydmljZXMuY29tOlRyYW5zcG9ydC4yMDI0",
  },
};

function reqEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function parseNumberEnv(name: string, defaultValue: number): number {
  const raw = (process.env[name] || "").trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env '${name}': '${raw}'`);
  }
  return parsed;
}

function parseCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseUserMap(): Record<number, UserMapEntry> {
  const raw = (process.env.USER_MAP_JSON || "").trim();
  if (!raw) return DEFAULT_USER_MAP;

  const parsed = parseJson<Record<string, UserMapEntry>>(raw, {});
  const mapped: Record<number, UserMapEntry> = {};
  for (const [k, v] of Object.entries(parsed)) {
    const id = Number(k);
    if (!Number.isFinite(id) || !v?.basicB64) continue;
    mapped[id] = { basicB64: String(v.basicB64).trim() };
  }
  return Object.keys(mapped).length ? mapped : DEFAULT_USER_MAP;
}

function parseStatusActions(triggerStatusLabel: string): Record<string, RoutedActionConfig[]> {
  const defaultMap: Record<string, RoutedActionConfig[]> = {
    [triggerStatusLabel]: [{ integration: "123cargo", action: "publishLoad" }],
    "Post to 123Cargo": [{ integration: "123cargo", action: "publishLoad" }],
    "Post to Cargopedia": [{ integration: "cargopedia", action: "publishLoad" }],
    "Remove listing": [
      { integration: "123cargo", action: "removeLoad" },
      { integration: "cargopedia", action: "removeLoad" },
    ],
  };

  const raw = (process.env.STATUS_ACTIONS_JSON || "").trim();
  if (!raw) return defaultMap;
  const parsed = parseJson<Record<string, RoutedActionConfig[] | RoutedActionConfig>>(raw, {});
  const normalized: Record<string, RoutedActionConfig[]> = {};

  for (const [status, value] of Object.entries(parsed)) {
    const arr = Array.isArray(value) ? value : [value];
    const valid = arr.filter((x) => x?.integration && (x.action === "publishLoad" || x.action === "removeLoad"));
    if (!valid.length) continue;
    normalized[status] = valid.map((x) => ({ integration: x.integration.trim(), action: x.action }));
  }

  return Object.keys(normalized).length ? normalized : defaultMap;
}

const triggerStatusLabel = (process.env.TRIGGER_STATUS_ONLY_LABEL || "De publicat").trim();

export const config = {
  nodeEnv: (process.env.NODE_ENV || "development").trim(),
  port: parseNumberEnv("PORT", 8080),
  mondayApiToken: reqEnv("MONDAY_TOKEN"),
  mondayApiUrl: (process.env.MONDAY_API_URL || "https://api.monday.com/v2").trim(),
  enabledIntegrations: parseCsv((process.env.ENABLED_INTEGRATIONS || "123cargo,cargopedia").trim()),
  statusActions: parseStatusActions(triggerStatusLabel),
  labels: {
    triggerOnly: triggerStatusLabel,
    success: reqEnv("TRIGGER_STATUS_SUCCESS_LABEL"),
    error: reqEnv("TRIGGER_STATUS_ERROR_LABEL"),
    processing: (process.env.TRIGGER_STATUS_PROCESSING_LABEL || "Procesare").trim(),
  },
  mondayColumns: {
    dealOwner: reqEnv("DEAL_OWNER_COLUMN_ID"),
    preluatDe: (process.env.PRELUAT_DE_COLUMN_ID || "multiple_person_mkybbcca").trim(),
    error: reqEnv("ERROR_COLUMN_ID"),
    site: (process.env.SITE_COLUMN_ID || "color_mm1r535n").trim(),
    tipMarfa: (process.env.TIP_MARFA_COLUMN_ID || "color_mksemxby").trim(),
    ocupareCamion: (process.env.OCUPARE_CAMION_COLUMN_ID || "color_mkrb3hhk").trim(),
    twoStepLink: (process.env.TWO_STEP_LINK_COLUMN_ID || "").trim(),
    flags: (process.env.FLAGS_COLUMN_ID || "").trim(),
    privateNotice: (process.env.PRIVATE_NOTICE_COLUMN_ID || "").trim(),
    externalLoadId: (process.env.EXTERNAL_LOAD_ID_COLUMN_ID || "").trim(),
  },
  // Legacy status routing config kept for backwards compatibility only.
  // Main publish flow no longer relies on STATUS_ACTIONS_JSON.
  integrations: {
    cargo123: {
      baseUrl: reqEnv("BURSA_BASE").replace(/\/+$/, ""),
      defaultLoadingIntervalDays: parseNumberEnv("DEFAULT_LOADING_INTERVAL_DAYS", 1),
    },
    cargopedia: {
      baseUrl: (process.env.CARGOPEDIA_BASE_URL || "").trim(),
      apiKey: (process.env.CARGOPEDIA_API_KEY || "").trim(),
      apiKeySecret: (process.env.CARGOPEDIA_API_KEY_SECRET || "").trim(),
      userId: (process.env.CARGOPEDIA_USER_ID || "").trim(),
      userIdSecret: (process.env.CARGOPEDIA_USER_ID_SECRET || "").trim(),
    },
  },
  auth: {
    forceTestMode: (process.env.FORCE_TEST_AUTH_MODE || "").trim() === "1",
    testUsername: (process.env.TEST_BURSA_USERNAME || "").trim(),
    testPassword: (process.env.TEST_BURSA_PASSWORD || "").trim(),
    userMap: parseUserMap(),
  },
  twoStep: {
    appBaseUrl: (process.env.APP_BASE_URL || "").trim(),
    tokenTtlSeconds: parseNumberEnv("TWO_STEP_TOKEN_TTL_SECONDS", parseNumberEnv("TWO_STEP_TICKET_TTL_SECONDS", 900)),
    tokenSecret: (process.env.TWO_STEP_TOKEN_SECRET || reqEnv("MONDAY_TOKEN")).trim(),
  },
} as const;

export type AppConfig = typeof config;
export type { IntegrationAction, RoutedActionConfig, UserMapEntry };
