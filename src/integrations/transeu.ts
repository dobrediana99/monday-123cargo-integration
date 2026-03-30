import axios, { AxiosError } from "axios";
import countries from "i18n-iso-countries";
import { createRequire } from "module";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import type { MondayColumnValue } from "../services/mondayClient.js";
import type { FreightIntegration, IntegrationContext, IntegrationResult } from "./types.js";

const require = createRequire(import.meta.url);
const en = require("i18n-iso-countries/langs/en.json");
countries.registerLocale(en);

const TOKEN_ENDPOINT = "/ext/auth-api/accounts/token";
const PUBLISH_ENDPOINT = "/ext/freights-api/v1/freight-exchange";
const REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number | string;
};

type TokenCache = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

type PublishApiResult = {
  status: number;
  data: any;
};

type Timespan = {
  begin: string;
  end: string;
};

function normalize(input: string): string {
  return String(input ?? "")
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

function parseNumberLoose(value: string): number {
  const normalized = String(value ?? "").replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function parseDateFlexible(raw: string): Date | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) return date;
    return null;
  }

  const ro = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!ro) return null;
  const d = Number(ro[1]);
  const m = Number(ro[2]);
  const y = Number(ro[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) return date;
  return null;
}

function formatIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toTimespan(date: Date): Timespan {
  const datePart = formatIsoDate(date);
  return {
    begin: `${datePart}T08:00:00+00:00`,
    end: `${datePart}T16:00:00+00:00`,
  };
}

function extractDateFromColumn(column: MondayColumnValue | undefined): Date | null {
  if (!column) return null;
  if (column.value) {
    try {
      const parsed = JSON.parse(column.value);
      const date = parseDateFlexible(String(parsed?.date ?? ""));
      if (date) return date;
    } catch {
      // ignore and fallback to text
    }
  }
  return parseDateFlexible(String(column.text ?? ""));
}

function countryCode(input: string): string | null {
  const value = String(input ?? "").trim();
  if (!value) return null;
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  const mapped = countries.getAlpha2Code(value, "en");
  return mapped ? mapped.toUpperCase() : null;
}

function normalizeCurrency(input: string): string | null {
  const value = String(input ?? "").trim();
  if (!value) return null;
  const upper = value.toUpperCase();
  if (upper === "EUR" || upper === "RON" || upper === "USD") return upper.toLowerCase();
  const key = normalize(value);
  const map: Record<string, string> = {
    euro: "eur",
    eur: "eur",
    ron: "ron",
    lei: "ron",
    usd: "usd",
    dollar: "usd",
    dollars: "usd",
  };
  return map[key] ?? null;
}

function mapTruckBodies(truckTypeRaw: string, cargoTypeRaw: string): string[] {
  const truckType = normalize(truckTypeRaw);
  const cargoType = normalize(cargoTypeRaw);
  const result: string[] = [];

  if (truckType.includes("prelata") || truckType.includes("curtain")) result.push("curtainsider");
  if (truckType.includes("box") || truckType.includes("duba") || truckType.includes("rigid")) result.push("box");
  if (truckType.includes("frigo") || truckType.includes("reefer")) result.push("cooler");
  if (truckType.includes("basculanta") || truckType.includes("tipper")) result.push("dump-truck");
  if (truckType.includes("cisterna") || truckType.includes("tanker") || truckType.includes("tank")) result.push("gas-tanker");
  if (truckType.includes("platforma") || truckType.includes("flatbed")) result.push("platform-trailer");
  if (truckType.includes("auto") || truckType.includes("car transporter")) result.push("car-transporter");

  if (cargoType.includes("frigo") || cargoType.includes("reefer")) result.push("cooler");
  if (cargoType.includes("adr")) result.push("standard-tent");

  if (!result.length) return ["curtainsider"];
  return Array.from(new Set(result));
}

function mapIsFtl(ocupareCamionRaw: string): boolean {
  const key = normalize(ocupareCamionRaw);
  if (!key) return true;
  if (key === "groupage ltl") return false;
  if (key === "complete ftl") return true;
  return true;
}

function colsMap(context: IntegrationContext): Record<string, MondayColumnValue> {
  return Object.fromEntries(context.item.column_values.map((column) => [column.id, column])) as Record<
    string,
    MondayColumnValue
  >;
}

function summarizeValidationErrors(errors: string[]): string {
  return `[TRANSEU][MAPPING] ${errors.join("; ")}`;
}

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data).slice(0, 1000);
  } catch {
    return String(data);
  }
}

function normalizeApiErrorMessage(data: any, fallback: string): string {
  if (typeof data?.detail === "string" && data.detail.trim()) return data.detail.trim();
  if (typeof data?.message === "string" && data.message.trim()) return data.message.trim();
  if (typeof data?.title === "string" && data.title.trim()) return `${data.title.trim()} (${fallback})`;
  return fallback;
}

export function mapMondayToTransEuPayload(context: IntegrationContext): { payload: any; errors: string[] } {
  const cols = colsMap(context);
  const errors: string[] = [];

  const loadingCity = String(cols["text_mkypcczr"]?.text ?? "").trim();
  const loadingCountryRaw = String(cols["dropdown_mkx6jyjf"]?.text ?? "").trim();
  const unloadingCity = String(cols["text_mkypxb8h"]?.text ?? "").trim();
  const unloadingCountryRaw = String(cols["dropdown_mkx687jv"]?.text ?? "").trim();
  const loadingDate = extractDateFromColumn(cols["date_mkx77z0m"]);
  const weightKg = parseNumberLoose(String(cols["text_mkt9nr81"]?.text ?? "").trim());
  const truckType = String(cols["dropdown_mkx1s5nv"]?.text ?? "").trim();
  const cargoType = String(cols[config.mondayColumns.tipMarfa]?.text ?? "").trim();
  const ocupareCamion = String(cols[config.mondayColumns.ocupareCamion]?.text ?? "").trim();
  const budget = parseNumberLoose(String(cols["numeric_mkr4e4qc"]?.text ?? "").trim());
  const currencyRaw = String(cols["color_mksh2abx"]?.text ?? "").trim();

  if (!loadingCity) errors.push("Localitate Încărcare este obligatorie.");
  if (!unloadingCity) errors.push("Localitate Descărcare este obligatorie.");

  const loadingCountry = countryCode(loadingCountryRaw);
  const unloadingCountry = countryCode(unloadingCountryRaw);
  if (!loadingCountry) errors.push(`Țara Încărcare invalidă: '${loadingCountryRaw}'`);
  if (!unloadingCountry) errors.push(`Țara Descărcare invalidă: '${unloadingCountryRaw}'`);

  if (!loadingDate) errors.push("Data Încărcare este invalidă.");
  if (!Number.isFinite(weightKg) || weightKg <= 0) errors.push("Greutate (KG) invalidă.");

  const capacityTons = Number((weightKg / 1000).toFixed(3));
  if (!Number.isFinite(capacityTons) || capacityTons <= 0) {
    errors.push("Capacitatea (tone) rezultată din greutate este invalidă.");
  }

  const requiredTruckBodies = mapTruckBodies(truckType, cargoType);
  const currency = normalizeCurrency(currencyRaw);

  const loadingTimespan = loadingDate ? toTimespan(loadingDate) : null;
  const unloadingTimespan = loadingDate ? toTimespan(addDays(loadingDate, 1)) : null;
  const isFtl = mapIsFtl(ocupareCamion);

  const payload: any = {
    publish: true,
    external_source: "1_api",
    shipment_external_id: context.itemId,
    capacity: capacityTons,
    requirements: {
      is_ftl: isFtl,
      required_truck_bodies: requiredTruckBodies,
      vehicle_size: "any_size",
    },
    loads: [],
    spots:
      loadingCountry && unloadingCountry && loadingTimespan && unloadingTimespan
        ? [
            {
              spot_order: 1,
              place: {
                address: {
                  country: loadingCountry,
                  locality: loadingCity,
                },
              },
              operations: [
                {
                  operation_order: 1,
                  type: "loading",
                  timespans: loadingTimespan,
                },
              ],
            },
            {
              spot_order: 2,
              place: {
                address: {
                  country: unloadingCountry,
                  locality: unloadingCity,
                },
              },
              operations: [
                {
                  operation_order: 1,
                  type: "unloading",
                  timespans: unloadingTimespan,
                },
              ],
            },
          ]
        : [],
  };

  if (Number.isFinite(budget) && budget > 0 && currency) {
    payload.payment = {
      price: {
        value: Number(budget.toFixed(2)),
        currency,
        period: {
          payment: "deferred",
          days: 30,
        },
      },
    };
  }

  return { payload, errors };
}

class TransEuApiClient {
  private tokenCache: TokenCache | null = null;
  private refreshInFlight: Promise<TokenCache> | null = null;

  private get baseUrl(): string {
    return config.integrations.transeu.baseUrl.replace(/\/+$/, "");
  }

  private get authHeaders() {
    return {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "Api-key": config.integrations.transeu.apiKey,
    };
  }

  private get publishHeaders() {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Api-key": config.integrations.transeu.apiKey,
    };
  }

  private tokenIsFresh(): boolean {
    if (!this.tokenCache) return false;
    return Date.now() + TOKEN_EXPIRY_SKEW_MS < this.tokenCache.expiresAt;
  }

  private async requestToken(params: URLSearchParams): Promise<TokenCache> {
    const response = await axios.post(`${this.baseUrl}${TOKEN_ENDPOINT}`, params.toString(), {
      headers: this.authHeaders,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `[TRANSEU][AUTH] Token request failed (HTTP ${response.status}): ${normalizeApiErrorMessage(
          response.data,
          safeJson(response.data)
        )}`
      );
    }

    const data = (response.data || {}) as TokenResponse;
    const accessToken = String(data.access_token || "").trim();
    if (!accessToken) {
      throw new Error("[TRANSEU][AUTH] Invalid token response: access_token missing.");
    }

    const expiresInSecondsRaw = Number(data.expires_in);
    const expiresInSeconds = Number.isFinite(expiresInSecondsRaw) && expiresInSecondsRaw > 0 ? expiresInSecondsRaw : 3600;
    const refreshToken = String(data.refresh_token || "").trim() || undefined;

    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    };
  }

  private async exchangeAuthCode(): Promise<TokenCache> {
    const authCode = config.integrations.transeu.authCode.trim();
    const redirectUri = config.integrations.transeu.redirectUri.trim();
    if (!authCode || !redirectUri) {
      throw new Error(
        "[TRANSEU][AUTH] Missing TRANSEU_AUTH_CODE / TRANSEU_REDIRECT_URI. Follow OAuth2 flow from Trans.eu docs."
      );
    }

    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: redirectUri,
      client_id: config.integrations.transeu.clientId,
      client_secret: config.integrations.transeu.clientSecret,
    });
    return this.requestToken(params);
  }

  private async refreshAccessToken(refreshToken: string): Promise<TokenCache> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.integrations.transeu.clientId,
      client_secret: config.integrations.transeu.clientSecret,
    });
    return this.requestToken(params);
  }

  private async refreshAccessTokenShared(refreshToken: string): Promise<TokenCache> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshAccessToken(refreshToken).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenIsFresh()) {
      return this.tokenCache!.accessToken;
    }

    const configuredAccessToken = config.integrations.transeu.accessToken.trim();
    const configuredRefreshToken = config.integrations.transeu.refreshToken.trim();

    if (this.tokenCache?.refreshToken) {
      try {
        this.tokenCache = await this.refreshAccessTokenShared(this.tokenCache.refreshToken);
        return this.tokenCache.accessToken;
      } catch (error) {
        logger.warn("Trans.eu access token refresh failed, trying fallback auth flow", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (configuredRefreshToken) {
      this.tokenCache = await this.refreshAccessTokenShared(configuredRefreshToken);
      return this.tokenCache.accessToken;
    }

    if (configuredAccessToken) {
      this.tokenCache = {
        accessToken: configuredAccessToken,
        refreshToken: configuredRefreshToken || undefined,
        expiresAt: Date.now() + 50 * 60 * 1000,
      };
      return this.tokenCache.accessToken;
    }

    this.tokenCache = await this.exchangeAuthCode();
    return this.tokenCache.accessToken;
  }

  async publishFreight(payload: any): Promise<PublishApiResult> {
    let accessToken = await this.getAccessToken();

    const execute = async (token: string) =>
      axios.post(`${this.baseUrl}${PUBLISH_ENDPOINT}`, payload, {
        headers: {
          ...this.publishHeaders,
          Authorization: `Bearer ${token}`,
        },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });

    let response = await execute(accessToken);
    if ((response.status === 401 || response.status === 403) && (this.tokenCache?.refreshToken || config.integrations.transeu.refreshToken)) {
      const tokenForRefresh = this.tokenCache?.refreshToken || config.integrations.transeu.refreshToken;
      if (tokenForRefresh) {
        logger.warn("Trans.eu publish unauthorized, refreshing token and retrying once", { status: response.status });
        this.tokenCache = await this.refreshAccessTokenShared(tokenForRefresh);
        accessToken = this.tokenCache.accessToken;
        response = await execute(accessToken);
      }
    }

    return {
      status: response.status,
      data: response.data,
    };
  }

  resetForTests() {
    this.tokenCache = null;
    this.refreshInFlight = null;
  }
}

const transEuApiClient = new TransEuApiClient();

function handleAxiosError(error: unknown): IntegrationResult {
  const err = error as AxiosError;
  const status = err.response?.status;
  if (status === 401 || status === 403) {
    return {
      status: "error",
      message: "[TRANSEU][AUTH] Authentication failed. Check token/client credentials and API key.",
    };
  }
  if (status === 429) {
    return {
      status: "error",
      message: "[TRANSEU] Rate limit reached (HTTP 429). Retry later.",
    };
  }
  if (err.code === "ECONNABORTED") {
    return {
      status: "error",
      message: "[TRANSEU] Request timeout.",
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { status: "error", message: `[TRANSEU] ${message}` };
}

async function publishLoad(context: IntegrationContext): Promise<IntegrationResult> {
  try {
    const { payload, errors } = mapMondayToTransEuPayload(context);
    if (errors.length) return { status: "error", message: summarizeValidationErrors(errors) };

    logger.info("Publishing freight to Trans.eu", { itemId: context.itemId });
    const response = await transEuApiClient.publishFreight(payload);

    if (response.status === 200 || response.status === 201) {
      return {
        status: "success",
        message: `[TRANSEU] Freight published successfully${response.data?.id ? ` (id=${response.data.id})` : ""}.`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        status: "error",
        message: "[TRANSEU][AUTH] Publish rejected. Verify OAuth credentials and API key.",
      };
    }
    if (response.status === 429) {
      return {
        status: "error",
        message: "[TRANSEU] Publish rejected due to rate limiting (HTTP 429).",
      };
    }

    const fallback = safeJson(response.data);
    return {
      status: "error",
      message: `[TRANSEU] Publish failed (HTTP ${response.status}): ${normalizeApiErrorMessage(response.data, fallback)}`,
    };
  } catch (error) {
    logger.error("Trans.eu publish failed", {
      itemId: context.itemId,
      error: error instanceof Error ? error.message : String(error),
    });
    return handleAxiosError(error);
  }
}

async function removeLoad(_context: IntegrationContext): Promise<IntegrationResult> {
  return {
    status: "error",
    message: "[TRANSEU] Remove load is not implemented in current integration flow.",
  };
}

export function resetTransEuClientForTests() {
  transEuApiClient.resetForTests();
}

export const transeuIntegration: FreightIntegration = {
  name: "transeu",
  publishLoad,
  removeLoad,
};
