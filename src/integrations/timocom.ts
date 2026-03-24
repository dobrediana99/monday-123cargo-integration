import type { FreightIntegration, IntegrationContext, IntegrationResult } from "./types.js";

async function publishLoad(_context: IntegrationContext): Promise<IntegrationResult> {
  return {
    status: "error",
    message: "[TIMOCOM] Integration is not implemented yet.",
  };
}

async function removeLoad(_context: IntegrationContext): Promise<IntegrationResult> {
  return {
    status: "error",
    message: "[TIMOCOM] Integration is not implemented yet.",
  };
}

export const timocomIntegration: FreightIntegration = {
  name: "timocom",
  publishLoad,
  removeLoad,
};
