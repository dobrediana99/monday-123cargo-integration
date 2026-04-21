import crypto from "crypto";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { MondayClient, extractEventRef, getStatusLabel, type MondayWebhookBody } from "./mondayClient.js";
import { StatusRouter } from "./statusRouter.js";
import { cargo123Integration } from "../integrations/123cargo.js";
import { cargopediaIntegration } from "../integrations/cargopedia.js";
import { timocomIntegration } from "../integrations/timocom.js";
import { transeuIntegration } from "../integrations/transeu.js";
import type { FreightIntegration, IntegrationContext, IntegrationResult } from "../integrations/types.js";

type TwoStepTokenPayload = {
  v: 1;
  exp: number;
  boardId: string;
  itemId: string;
  statusColumnId: string;
  integration: string;
  action: "publishLoad";
};

type RequestMeta = {
  baseUrl?: string;
};

type TwoStepProcessResult = {
  ok: boolean;
  message: string;
};

const integrations: Record<string, FreightIntegration> = {
  "123cargo": cargo123Integration,
  cargopedia: cargopediaIntegration,
  timocom: timocomIntegration,
  transeu: transeuIntegration,
};

function toDisplayMessage(input: string, max = 1800) {
  return input.length <= max ? input : `${input.slice(0, max - 3)}...`;
}

function b64url(data: string): string {
  return Buffer.from(data, "utf8").toString("base64url");
}

function buildBaseUrlFromRequestMeta(meta?: RequestMeta): string {
  if (config.twoStep.appBaseUrl) return config.twoStep.appBaseUrl.replace(/\/+$/, "");
  if (meta?.baseUrl) return meta.baseUrl.replace(/\/+$/, "");
  return "";
}

function buildTwoStepMessage(link: string): string {
  if (config.mondayColumns.twoStepLink) {
    return "Trebuie sa introduci codul primit in email: AICI";
  }
  return `Trebuie sa introduci codul primit in email: AICI -> ${link}`;
}

export class EventProcessor {
  private readonly monday = new MondayClient();
  private readonly router = new StatusRouter();

  private signTwoStepToken(payload: TwoStepTokenPayload): string {
    const encodedPayload = b64url(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", config.twoStep.tokenSecret).update(encodedPayload).digest("base64url");
    return `${encodedPayload}.${signature}`;
  }

  private verifyTwoStepToken(token: string): { ok: true; payload: TwoStepTokenPayload } | { ok: false; reason: string } {
    const [encodedPayload, encodedSignature] = String(token || "").split(".");
    if (!encodedPayload || !encodedSignature) {
      return { ok: false, reason: "Token invalid." };
    }
    const expected = crypto.createHmac("sha256", config.twoStep.tokenSecret).update(encodedPayload).digest("base64url");
    const sigOk = crypto.timingSafeEqual(Buffer.from(encodedSignature), Buffer.from(expected));
    if (!sigOk) return { ok: false, reason: "Semnătură token invalidă." };

    let payload: TwoStepTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as TwoStepTokenPayload;
    } catch {
      return { ok: false, reason: "Payload token invalid." };
    }
    if (payload.v !== 1 || payload.action !== "publishLoad") {
      return { ok: false, reason: "Versiune token invalidă." };
    }
    if (Date.now() > payload.exp) {
      return { ok: false, reason: "Ticket invalid sau expirat" };
    }
    return { ok: true, payload };
  }

  private async setErrorState(boardId: string, itemId: string, statusColumnId: string, message: string) {
    await this.monday.changeTextColumn(boardId, itemId, config.mondayColumns.error, toDisplayMessage(message));
    await this.monday.changeStatusLabel(boardId, itemId, statusColumnId, config.labels.error);
  }

  private async clearErrorState(boardId: string, itemId: string) {
    await this.monday.changeTextColumn(boardId, itemId, config.mondayColumns.error, "");
    if (config.mondayColumns.twoStepLink) {
      await this.monday.changeLinkColumn(boardId, itemId, config.mondayColumns.twoStepLink, "", "");
    }
  }

  private buildTwoStepLink(meta: RequestMeta | undefined, token: string): string {
    const baseUrl = buildBaseUrlFromRequestMeta(meta);
    return `${baseUrl}/2step?token=${encodeURIComponent(token)}`;
  }

  private async runAction(
    action: "publishLoad" | "removeLoad",
    integration: FreightIntegration,
    context: IntegrationContext
  ): Promise<IntegrationResult> {
    if (action === "publishLoad") return integration.publishLoad(context);
    return integration.removeLoad(context);
  }

  async processWebhookPayload(body: MondayWebhookBody, meta?: RequestMeta): Promise<void> {
    const ref = extractEventRef(body);
    if (!ref) {
      logger.warn("Webhook payload missing event ref");
      return;
    }

    const scope = { boardId: ref.boardId, itemId: ref.itemId, columnId: ref.columnId };
    logger.info("Webhook event received", scope);

    const item = await this.monday.fetchItem(ref.boardId, ref.itemId);
    const cols = this.monday.colsToMap(item.column_values);

    const statusLabel = getStatusLabel(cols[ref.columnId]) || String(cols[ref.columnId]?.text || "");
    if (!this.router.isPublishTrigger(statusLabel)) {
      logger.info("Skipping event because status is not publish trigger", { ...scope, statusLabel });
      return;
    }

    const siteColumnId = config.mondayColumns.site;
    const siteLabel = String(cols[siteColumnId]?.text || "").trim();
    const targetIntegrations = this.router.resolveIntegrationsFromSite(siteLabel);
    if (!targetIntegrations.length) {
      await this.setErrorState(
        ref.boardId,
        ref.itemId,
        ref.columnId,
        `[SITE] Invalid or empty Site value '${siteLabel}'. Allowed: Cargopedia, Bursa(123cargo), Timocom, Trans.eu.`
      );
      logger.warn("No integrations resolved from Site column", { ...scope, siteLabel, siteColumnId });
      return;
    }

    await this.monday.changeStatusLabel(ref.boardId, ref.itemId, ref.columnId, config.labels.processing);
    logger.info("Status switched to processing", { ...scope, statusLabel, siteLabel, targetIntegrations });

    const context: IntegrationContext = {
      boardId: ref.boardId,
      itemId: ref.itemId,
      statusColumnId: ref.columnId,
      item,
    };

    let executedIntegrations = 0;
    for (const integrationKey of targetIntegrations) {
      if (!config.enabledIntegrations.includes(integrationKey)) {
        logger.info("Integration disabled, skipping", { ...scope, integration: integrationKey, action: "publishLoad" });
        continue;
      }
      executedIntegrations += 1;
      const integration = integrations[integrationKey];
      if (!integration) {
        await this.setErrorState(ref.boardId, ref.itemId, ref.columnId, `[ROUTER] Unknown integration: ${integrationKey}`);
        return;
      }
      if (integrationKey === "timocom") {
        await this.setErrorState(
          ref.boardId,
          ref.itemId,
          ref.columnId,
          "[TIMOCOM] Integrarea este inca neimplementata."
        );
        return;
      }
      logger.info("Triggering integration action", {
        ...scope,
        integration: integration.name,
        action: "publishLoad",
      });
      const result = await this.runAction("publishLoad", integration, context);

      if (result.status === "requires_two_step") {
        const tokenPayload: TwoStepTokenPayload = {
          v: 1,
          exp: Date.now() + config.twoStep.tokenTtlSeconds * 1000,
          boardId: ref.boardId,
          itemId: ref.itemId,
          statusColumnId: ref.columnId,
          integration: integrationKey,
          action: "publishLoad",
        };
        const token = this.signTwoStepToken(tokenPayload);
        const link = this.buildTwoStepLink(meta, token);
        const text = buildTwoStepMessage(link);
        await this.setErrorState(ref.boardId, ref.itemId, ref.columnId, text);
        if (config.mondayColumns.twoStepLink) {
          await this.monday.changeLinkColumn(ref.boardId, ref.itemId, config.mondayColumns.twoStepLink, link, "AICI");
        }
        logger.warn("Two-step required, waiting for user code", { ...scope, integration: integrationKey });
        return;
      }

      if (result.status === "error") {
        await this.setErrorState(ref.boardId, ref.itemId, ref.columnId, result.message);
        logger.warn("Integration action failed", { ...scope, integration: integrationKey, message: result.message });
        return;
      }
    }

    if (!executedIntegrations) {
      await this.setErrorState(
        ref.boardId,
        ref.itemId,
        ref.columnId,
        `[SITE] Selected marketplace(s) are disabled via ENABLED_INTEGRATIONS: ${targetIntegrations.join(", ")}`
      );
      return;
    }

    await this.monday.changeStatusLabel(ref.boardId, ref.itemId, ref.columnId, config.labels.success);
    await this.clearErrorState(ref.boardId, ref.itemId);
    logger.info("Event processed successfully", scope);
  }

  validateTwoStepToken(token: string): { ok: boolean; message: string } {
    const verified = this.verifyTwoStepToken(token);
    if (!verified.ok) return { ok: false, message: verified.reason };
    return { ok: true, message: "ok" };
  }

  async processTwoStepToken(token: string, code: string): Promise<TwoStepProcessResult> {
    const verified = this.verifyTwoStepToken(token);
    if (!verified.ok) return { ok: false, message: verified.reason };
    if (!code.trim()) return { ok: false, message: "Codul SMS este obligatoriu." };

    const payload = verified.payload;
    const integration = integrations[payload.integration];
    if (!integration || !integration.completeTwoStepPublish) {
      return { ok: false, message: `Integrarea '${payload.integration}' nu suportă confirmare 2-step.` };
    }

    const item = await this.monday.fetchItem(payload.boardId, payload.itemId);
    const context: IntegrationContext = {
      boardId: payload.boardId,
      itemId: payload.itemId,
      statusColumnId: payload.statusColumnId,
      item,
    };

    await this.monday.changeStatusLabel(payload.boardId, payload.itemId, payload.statusColumnId, config.labels.processing);
    const result = await integration.completeTwoStepPublish(context, code.trim());
    if (result.status === "success") {
      await this.monday.changeStatusLabel(payload.boardId, payload.itemId, payload.statusColumnId, config.labels.success);
      await this.clearErrorState(payload.boardId, payload.itemId);
      return { ok: true, message: "Publicare realizată cu succes." };
    }

    const message = result.status === "error" ? result.message : result.message;
    await this.setErrorState(payload.boardId, payload.itemId, payload.statusColumnId, message);
    return { ok: false, message };
  }
}
import { getConfig } from "../utils/config.js";
import { colsToMap, getStatusLabel } from "../utils/mondayParsing.js";
import { postLoadTo123Cargo, resolveBasicAuthForBursa } from "../integrations/123cargo.js";
import { buildLoadPayload, validateBusinessRules, validateRequired } from "./loadProcessing.js";
import type { MondayClient } from "./mondayClient.js";
import * as statusRouter from "./statusRouter.js";

export type MondayWebhookBody = {
  challenge?: string;
  event?: MondayWebhookEvent;
};

export type MondayWebhookEvent = {
  boardId: number;
  pulseId?: number;
  itemId?: number;
  columnId?: string;
  /** Some Monday webhook payloads nest the column id here. */
  ref?: { columnId?: string };
};

function resolveTriggerColumnId(event: MondayWebhookEvent): string | undefined {
  return event.columnId?.trim() || event.ref?.columnId?.trim();
}

export async function processWebhookPayload(
  body: MondayWebhookBody,
  monday: MondayClient
): Promise<{ httpStatus: number; json: Record<string, unknown> }> {
  if (body?.challenge) {
    return { httpStatus: 200, json: { challenge: body.challenge } };
  }

  const cfg = getConfig();
  const event = body?.event;
  if (!event) {
    return { httpStatus: 200, json: { ok: true } };
  }

  const triggerCol = resolveTriggerColumnId(event);
  if (triggerCol !== cfg.mondayColumns.publicationBursa) {
    return { httpStatus: 200, json: { ok: true, skipped: true, reason: "wrong_column" } };
  }

  const boardId = Number(event.boardId);
  const itemId = Number(event.pulseId ?? event.itemId);
  if (!Number.isFinite(boardId) || !Number.isFinite(itemId)) {
    return { httpStatus: 200, json: { ok: true, skipped: true, reason: "missing_ids" } };
  }

  const publicationColId = cfg.mondayColumns.publicationBursa;

  const item = await monday.fetchItem(boardId, itemId);
  const cols = colsToMap(item.column_values);
  const currentLabel = getStatusLabel(cols[publicationColId]);
  if (currentLabel !== cfg.publicationBursa.triggerLabel) {
    return { httpStatus: 200, json: { ok: true, skipped: true, reason: "wrong_label" } };
  }

  await statusRouter.setPublicationProcessing(monday, cfg, boardId, itemId);

  const fail = async (prefix: string, message: string) => {
    await monday.changeTextColumn(boardId, itemId, cfg.mondayColumns.error, `${prefix} ${message}`);
    await statusRouter.setPublicationError(monday, cfg, boardId, itemId);
  };

  const businessErrors = validateBusinessRules(cols);
  if (businessErrors.length) {
    await fail("[BUSINESS RULES]", businessErrors.join("; "));
    return { httpStatus: 200, json: { ok: true } };
  }

  const authPick = await resolveBasicAuthForBursa(monday, cols);
  if (!authPick.ok) {
    await fail("[USER]", authPick.error);
    return { httpStatus: 200, json: { ok: true } };
  }

  const validationErrors = validateRequired(cols);
  if (validationErrors.length) {
    await fail("[VALIDATION]", validationErrors.join("; "));
    return { httpStatus: 200, json: { ok: true } };
  }

  const { payload, errors: mapErrors } = buildLoadPayload(cols, itemId);
  if (mapErrors.length) {
    await fail("[MAPPING]", mapErrors.join("; "));
    return { httpStatus: 200, json: { ok: true } };
  }

  const bursaRes = await postLoadTo123Cargo(authPick.authHeader, payload);
  const ok = bursaRes.status === 200 && (bursaRes.data as { resultCode?: number })?.resultCode === 0;

  if (ok) {
    await statusRouter.setPublicationSuccess(monday, cfg, boardId, itemId);
    await monday.changeTextColumn(boardId, itemId, cfg.mondayColumns.error, "");
  } else {
    const msg = `[123CARGO] HTTP ${bursaRes.status} - ${JSON.stringify(bursaRes.data)?.slice(0, 800)}`;
    await monday.changeTextColumn(boardId, itemId, cfg.mondayColumns.error, msg);
    await statusRouter.setPublicationError(monday, cfg, boardId, itemId);
  }

  return { httpStatus: 200, json: { ok: true } };
}
