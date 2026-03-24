import axios from "axios";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { resolveSecretOrEnv } from "../utils/secretManager.js";
import type { MondayColumnValue } from "../services/mondayClient.js";
import type { FreightIntegration, IntegrationContext, IntegrationResult } from "./types.js";

type TruckTypeMapping = {
  truckType: string;
  reefer?: number;
};

type CargoTypeMapping = {
  adr?: number;
  reefer?: number;
  forceTruckType?: string;
};

function parseNumberLoose(value: string): number {
  const normalized = String(value ?? "").replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

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

function mapTruckType(input: string): TruckTypeMapping {
  const value = normalize(input);
  if (!value) return { truckType: "tilt" };

  if (value.includes("prelata") || value.includes("curtain")) return { truckType: "tilt" };
  if (value.includes("box") || value.includes("rigid") || value.includes("duba")) return { truckType: "box" };
  if (value.includes("frigo") || value.includes("reefer")) return { truckType: "box", reefer: 1 };
  if (value.includes("tipper") || value.includes("basculanta")) return { truckType: "tipper" };
  if (value.includes("cisterna") || value.includes("cistern") || value.includes("tank")) return { truckType: "tank" };
  if (value.includes("container")) return { truckType: "container" };
  if (value.includes("platform") || value.includes("flatbed")) return { truckType: "flatbed" };
  if (value.includes("auto") || value.includes("car transporter")) return { truckType: "cartransporter" };
  if (value.includes("tractor")) return { truckType: "tractorunit" };
  if (value.includes("sliding floor") || value.includes("walking floor")) return { truckType: "openbody" };

  logger.warn("Unknown truck type for Cargopedia", { input });
  return { truckType: "tilt" };
}

function mapCargoType(input: string): CargoTypeMapping {
  const value = normalize(input);
  if (!value) return {};

  return {
    adr: value.includes("adr") ? 1 : undefined,
    reefer: value.includes("frigo") || value.includes("reefer") ? 1 : undefined,
    forceTruckType: value.includes("car") ? "cartransporter" : undefined,
  };
}

function colsMap(context: IntegrationContext): Record<string, MondayColumnValue> {
  return Object.fromEntries(context.item.column_values.map((c) => [c.id, c])) as Record<string, MondayColumnValue>;
}

function buildRoute(city: string, country: string): string {
  const c = city.trim();
  const co = country.trim();
  return [c, co].filter(Boolean).join(", ");
}

async function loadCredentials(): Promise<{ key: string; userId: string }> {
  const key = await resolveSecretOrEnv({
    logicalName: "CARGOPEDIA_API_KEY",
    envValue: config.integrations.cargopedia.apiKey,
    secretRef: config.integrations.cargopedia.apiKeySecret,
  });
  const userId = await resolveSecretOrEnv({
    logicalName: "CARGOPEDIA_USER_ID",
    envValue: config.integrations.cargopedia.userId,
    secretRef: config.integrations.cargopedia.userIdSecret,
  });
  return { key, userId };
}

function normalizeApiMessage(data: any, fallback: string): string {
  if (typeof data?.message === "string" && data.message.trim()) return data.message.trim();
  if (typeof data?.response === "string" && data.response.trim()) return data.response.trim();
  return fallback;
}

function isApiOk(data: any): boolean {
  return data?.ok === true || data?.ok === 1 || data?.ok === "1" || data?.success === true;
}

async function publishLoad(context: IntegrationContext): Promise<IntegrationResult> {
  const baseUrl = config.integrations.cargopedia.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    return { status: "error", message: "[CARGOPEDIA] CARGOPEDIA_BASE_URL is not configured." };
  }

  try {
    const { key, userId } = await loadCredentials();
    const cols = colsMap(context);

    const from = buildRoute((cols["text_mkypcczr"]?.text ?? "").trim(), (cols["dropdown_mkx6jyjf"]?.text ?? "").trim());
    const to = buildRoute((cols["text_mkypxb8h"]?.text ?? "").trim(), (cols["dropdown_mkx687jv"]?.text ?? "").trim());
    const weightKg = parseNumberLoose((cols["text_mkt9nr81"]?.text ?? "").trim());
    const weightTons = Number.isFinite(weightKg) && weightKg > 0 ? weightKg / 1000 : NaN;

    if (!from || !to || !Number.isFinite(weightTons) || weightTons <= 0) {
      return {
        status: "error",
        message: "[CARGOPEDIA] Missing required fields: source, destination or weight.",
      };
    }

    const transportType = (cols["dropdown_mkx1s5nv"]?.text ?? "").trim();
    const cargoType = (cols[config.mondayColumns.tipMarfa]?.text ?? "").trim();
    const budget = parseNumberLoose((cols["numeric_mkr4e4qc"]?.text ?? "").trim());
    const description = context.item.name?.trim() || undefined;

    const truck = mapTruckType(transportType);
    const cargo = mapCargoType(cargoType);
    const finalTruckType = cargo.forceTruckType || truck.truckType;

    const params: Record<string, string | number> = {
      key,
      user_id: userId,
      from,
      to,
      weight: Number(weightTons.toFixed(3)),
      truck_type: finalTruckType,
      lang: "en",
      oid: context.itemId,
    };

    if (Number.isFinite(budget) && budget > 0) {
      params.price = budget;
      params.price_unit = "EUR";
    }
    if (cargo.adr) params.adr = 1;
    if (cargo.reefer || truck.reefer) params.reefer = 1;
    if (description) params.description = description;

    logger.info("Publishing load to Cargopedia", {
      itemId: context.itemId,
      from,
      to,
      truckType: finalTruckType,
    });

    const response = await axios.get(`${baseUrl}/api/v1/loads/publish`, { params });
    const data = response.data;
    if (!isApiOk(data)) {
      return {
        status: "error",
        message: `[CARGOPEDIA] ${normalizeApiMessage(data, `Publish failed (HTTP ${response.status}).`)}`,
      };
    }

    return {
      status: "success",
      message: `[CARGOPEDIA] ${normalizeApiMessage(data, "Load published.")}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Cargopedia publish failed", { error: message, itemId: context.itemId });
    return { status: "error", message: `[CARGOPEDIA] ${message}` };
  }
}

async function removeLoad(context: IntegrationContext): Promise<IntegrationResult> {
  const baseUrl = config.integrations.cargopedia.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    return { status: "error", message: "[CARGOPEDIA] CARGOPEDIA_BASE_URL is not configured." };
  }

  try {
    const { key, userId } = await loadCredentials();
    const cols = colsMap(context);
    const externalId = config.mondayColumns.externalLoadId
      ? (cols[config.mondayColumns.externalLoadId]?.text ?? "").trim()
      : "";
    const oid = externalId || context.itemId;

    const params = {
      key,
      user_id: userId,
      oid,
    };

    const response = await axios.get(`${baseUrl}/api/v1/loads/delete`, { params });
    const data = response.data;
    if (!isApiOk(data)) {
      return {
        status: "error",
        message: `[CARGOPEDIA] ${normalizeApiMessage(data, `Delete failed (HTTP ${response.status}).`)}`,
      };
    }

    return {
      status: "success",
      message: `[CARGOPEDIA] ${normalizeApiMessage(data, "Load removed.")}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Cargopedia delete failed", { error: message, itemId: context.itemId });
    return { status: "error", message: `[CARGOPEDIA] ${message}` };
  }
}

export const cargopediaIntegration: FreightIntegration = {
  name: "cargopedia",
  publishLoad,
  removeLoad,
};
