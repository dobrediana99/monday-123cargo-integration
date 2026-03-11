import { config } from "../utils/config.js";
import type { FreightIntegration, IntegrationContext, IntegrationResult } from "./types.js";

async function publishLoad(_context: IntegrationContext): Promise<IntegrationResult> {
  if (!config.integrations.cargopedia.baseUrl || !config.integrations.cargopedia.apiKey) {
    return {
      status: "error",
      message: "[CARGOPEDIA] Integration is not configured (missing CARGOPEDIA_BASE_URL/CARGOPEDIA_API_KEY).",
    };
  }

  // Placeholder for future implementation.
  return {
    status: "error",
    message: "[CARGOPEDIA] publishLoad not implemented yet.",
  };
}

async function removeLoad(_context: IntegrationContext): Promise<IntegrationResult> {
  if (!config.integrations.cargopedia.baseUrl || !config.integrations.cargopedia.apiKey) {
    return {
      status: "error",
      message: "[CARGOPEDIA] Integration is not configured (missing CARGOPEDIA_BASE_URL/CARGOPEDIA_API_KEY).",
    };
  }
  return {
    status: "error",
    message: "[CARGOPEDIA] removeLoad not implemented yet.",
  };
}

export const cargopediaIntegration: FreightIntegration = {
  name: "cargopedia",
  publishLoad,
  removeLoad,
};
