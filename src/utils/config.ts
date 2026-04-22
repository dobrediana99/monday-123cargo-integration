import dotenv from "dotenv";

dotenv.config();

export type BursaEmailMapEntry = { username: string };

export type AppConfig = {
  nodeEnv: string;
  port: number;
  mondayToken: string;
  mondayApiUrl: string;
  bursaBase: string;
  bursaPassword: string;
  mondayColumns: {
    dealOwner: string;
    error: string;
    publicationBursa: string;
    tipMarfa: string;
    ocupareCamion: string;
    flags: string;
    privateNotice: string;
    externalLoadId: string;
    twoStepLink: string;
  };
  publicationBursa: {
    triggerLabel: string;
    processingLabel: string;
    successLabel: string;
    errorLabel: string;
  };
  /** Mirrors flags column id for loadProcessing helpers. */
  flagsColumnId: string;
  privateNoticeColumnId: string;
  auth: {
    bursaUserMapByEmail: Record<string, BursaEmailMapEntry>;
    forceTestMode: boolean;
    testUsername: string;
    testPassword: string;
  };
  integrations: {
    cargo123: { defaultLoadingIntervalDays: number };
    cargopedia: {
      baseUrl: string;
      apiKey: string;
      apiKeySecret: string;
      userId: string;
      userIdSecret: string;
    };
    timocom: { baseUrl: string; apiToken: string; apiTokenSecret: string };
    transeu: {
      baseUrl: string;
      clientId: string;
      clientSecret: string;
      apiKey: string;
      accessToken: string;
      refreshToken: string;
      authCode: string;
      redirectUri: string;
    };
  };
  enabledIntegrations: string[];
  twoStep: {
    appBaseUrl: string;
    tokenSecret: string;
    tokenTtlSeconds: number;
  };
};

const DEFAULT_BURSA_USER_MAP_BY_EMAIL: Record<string, BursaEmailMapEntry> = {
  "alexandru.n@crystal-logistics-services.com": { username: "Transport.202501" },
  "andrei.p@crystal-logistics-services.com": { username: "Transport.5253" },
  "denisa.i@crystal-logistics-services.com": { username: "Transport.2601" },
  "diana.d@crystal-logistics-services.com": { username: "Transport.2026" },
};

function reqEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function reqEnvWhen(name: string, condition: boolean): string {
  if (!condition) return (process.env[name] || "").trim();
  return reqEnv(name);
}

function parseNumberEnv(name: string, defaultValue: number): number {
  const raw = (process.env[name] || "").trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env '${name}': '${raw}'`);
  return parsed;
}

function parseCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

function parseBursaUserMapFromJson(raw: string): Record<string, BursaEmailMapEntry> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, BursaEmailMapEntry> = {};
  for (const [email, entry] of Object.entries(parsed)) {
    const key = normalizeEmailKey(email);
    if (!key) continue;
    if (!entry || typeof entry !== "object") throw new Error(`Invalid map entry for "${email}"`);
    const username = (entry as { username?: unknown }).username;
    if (typeof username !== "string" || !username.trim()) throw new Error(`Invalid username for "${email}"`);
    out[key] = { username: username.trim() };
  }
  return out;
}

function loadBursaUserMapByEmail(): Record<string, BursaEmailMapEntry> {
  const raw = process.env.BURSA_USER_MAP_BY_EMAIL_JSON?.trim();
  if (!raw) return { ...DEFAULT_BURSA_USER_MAP_BY_EMAIL };
  return parseBursaUserMapFromJson(raw);
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const enabledIntegrations = parseCsv((process.env.ENABLED_INTEGRATIONS || "123cargo,cargopedia").trim());
  const isTransEuEnabled = enabledIntegrations.includes("transeu");

  const flags = (process.env.FLAGS_COLUMN_ID || "").trim();
  const privateNotice = (process.env.PRIVATE_NOTICE_COLUMN_ID || "").trim();
  const forceTestMode = (process.env.FORCE_TEST_AUTH_MODE || "").trim() === "1";

  cached = {
    nodeEnv: (process.env.NODE_ENV || "development").trim(),
    port: parseNumberEnv("PORT", 8080),
    mondayToken: reqEnv("MONDAY_TOKEN"),
    mondayApiUrl: (process.env.MONDAY_API_URL || "https://api.monday.com/v2").trim(),
    bursaBase: reqEnv("BURSA_BASE").replace(/\/+$/, ""),
    bursaPassword: reqEnvWhen("BURSA_PASSWORD", !forceTestMode),
    mondayColumns: {
      dealOwner: reqEnv("DEAL_OWNER_COLUMN_ID"),
      error: reqEnv("ERROR_COLUMN_ID"),
      publicationBursa: process.env.PUBLICARE_BURSA_COLUMN_ID?.trim() || "color_mkyp8xqz",
      tipMarfa: (process.env.TIP_MARFA_COLUMN_ID || "color_mksemxby").trim(),
      ocupareCamion: (process.env.OCUPARE_CAMION_COLUMN_ID || "color_mkrb3hhk").trim(),
      flags,
      privateNotice,
      externalLoadId: (process.env.EXTERNAL_LOAD_ID_COLUMN_ID || "").trim(),
      twoStepLink: (process.env.TWO_STEP_LINK_COLUMN_ID || "").trim(),
    },
    publicationBursa: {
      triggerLabel: process.env.PUBLICARE_BURSA_TRIGGER_LABEL?.trim() || "Publica pe bursa",
      processingLabel: process.env.PUBLICARE_BURSA_PROCESSING_LABEL?.trim() || "Procesare",
      successLabel: reqEnv("TRIGGER_STATUS_SUCCESS_LABEL"),
      errorLabel: reqEnv("TRIGGER_STATUS_ERROR_LABEL"),
    },
    flagsColumnId: flags,
    privateNoticeColumnId: privateNotice,
    auth: {
      bursaUserMapByEmail: loadBursaUserMapByEmail(),
      forceTestMode,
      testUsername: reqEnvWhen("TEST_BURSA_USERNAME", forceTestMode),
      testPassword: reqEnvWhen("TEST_BURSA_PASSWORD", forceTestMode),
    },
    integrations: {
      cargo123: {
        defaultLoadingIntervalDays: parseNumberEnv("DEFAULT_LOADING_INTERVAL_DAYS", 1),
      },
      cargopedia: {
        baseUrl: (process.env.CARGOPEDIA_BASE_URL || "").trim(),
        apiKey: (process.env.CARGOPEDIA_API_KEY || "").trim(),
        apiKeySecret: (process.env.CARGOPEDIA_API_KEY_SECRET || "").trim(),
        userId: (process.env.CARGOPEDIA_USER_ID || "").trim(),
        userIdSecret: (process.env.CARGOPEDIA_USER_ID_SECRET || "").trim(),
      },
      timocom: {
        baseUrl: (process.env.TIMOCOM_BASE_URL || "").trim(),
        apiToken: (process.env.TIMOCOM_API_TOKEN || "").trim(),
        apiTokenSecret: (process.env.TIMOCOM_API_TOKEN_SECRET || "").trim(),
      },
      transeu: {
        baseUrl: reqEnvWhen("TRANSEU_BASE_URL", isTransEuEnabled).replace(/\/+$/, ""),
        clientId: reqEnvWhen("TRANSEU_CLIENT_ID", isTransEuEnabled),
        clientSecret: reqEnvWhen("TRANSEU_CLIENT_SECRET", isTransEuEnabled),
        apiKey: reqEnvWhen("TRANSEU_API_KEY", isTransEuEnabled),
        accessToken: (process.env.TRANSEU_ACCESS_TOKEN || "").trim(),
        refreshToken: (process.env.TRANSEU_REFRESH_TOKEN || "").trim(),
        authCode: (process.env.TRANSEU_AUTH_CODE || "").trim(),
        redirectUri: (process.env.TRANSEU_REDIRECT_URI || "").trim(),
      },
    },
    enabledIntegrations,
    twoStep: {
      appBaseUrl: (process.env.APP_BASE_URL || "").trim(),
      tokenSecret: (process.env.TWO_STEP_TOKEN_SECRET || reqEnv("MONDAY_TOKEN")).trim(),
      tokenTtlSeconds: parseNumberEnv("TWO_STEP_TOKEN_TTL_SECONDS", parseNumberEnv("TWO_STEP_TICKET_TTL_SECONDS", 900)),
    },
  };

  return cached;
}

/** Backwards-compatible accessor for integrations that read `config` at runtime. */
export const config: AppConfig = new Proxy({} as AppConfig, {
  get(_target, prop: string | symbol) {
    return getConfig()[prop as keyof AppConfig];
  },
});
