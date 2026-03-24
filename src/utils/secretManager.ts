import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { logger } from "./logger.js";

const secretCache = new Map<string, string>();
let client: SecretManagerServiceClient | null = null;

function getProjectId(): string {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    ""
  ).trim();
}

function normalizeSecretVersionName(secretRef: string): string {
  const ref = secretRef.trim();
  if (!ref) {
    throw new Error("Secret reference is empty.");
  }

  if (/^projects\/[^/]+\/secrets\/[^/]+\/versions\/[^/]+$/.test(ref)) {
    return ref;
  }

  if (/^projects\/[^/]+\/secrets\/[^/]+$/.test(ref)) {
    return `${ref}/versions/latest`;
  }

  const projectId = getProjectId();
  if (!projectId) {
    throw new Error(
      "Google project id is missing. Set GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT/GCP_PROJECT), or use a full secret path."
    );
  }

  return `projects/${projectId}/secrets/${ref}/versions/latest`;
}

function getClient(): SecretManagerServiceClient {
  if (!client) {
    client = new SecretManagerServiceClient();
  }
  return client;
}

async function readSecret(secretRef: string): Promise<string> {
  const versionName = normalizeSecretVersionName(secretRef);
  const cached = secretCache.get(versionName);
  if (cached) return cached;

  const [version] = await getClient().accessSecretVersion({ name: versionName });
  const payload = version.payload?.data?.toString("utf8").trim() || "";
  if (!payload) {
    throw new Error(`Secret '${versionName}' is empty.`);
  }

  secretCache.set(versionName, payload);
  logger.info("Secret loaded from Secret Manager", { secret: versionName });
  return payload;
}

type ResolveSecretOptions = {
  envValue: string;
  secretRef: string;
  logicalName: string;
};

export async function resolveSecretOrEnv({
  envValue,
  secretRef,
  logicalName,
}: ResolveSecretOptions): Promise<string> {
  if (secretRef.trim()) {
    try {
      return await readSecret(secretRef);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[SECRET_MANAGER] ${logicalName}: ${message}`);
    }
  }

  if (envValue.trim()) {
    return envValue.trim();
  }

  throw new Error(
    `[CONFIG] Missing ${logicalName}. Configure ${logicalName} or ${logicalName}_SECRET.`
  );
}
