import crypto from "crypto";
import { cargo123Integration, postBursaLoad, resolveBasicAuthForBursa, bursaResponseRequiresTwoStep } from "../integrations/123cargo.js";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { colsToMap, getStatusLabel } from "../utils/mondayParsing.js";
import { buildLoadPayload, validateBusinessRules, validateRequired } from "./loadProcessing.js";
import { MondayClient, extractEventRef } from "./mondayClient.js";
import * as statusRouter from "./statusRouter.js";
function toDisplayMessage(input, max = 1800) {
    return input.length <= max ? input : `${input.slice(0, max - 3)}...`;
}
function b64url(data) {
    return Buffer.from(data, "utf8").toString("base64url");
}
function buildBaseUrlFromRequestMeta(meta) {
    const cfg = getConfig();
    if (cfg.twoStep.appBaseUrl)
        return cfg.twoStep.appBaseUrl.replace(/\/+$/, "");
    if (meta?.baseUrl)
        return meta.baseUrl.replace(/\/+$/, "");
    return "";
}
function buildTwoStepMessage(link) {
    const cfg = getConfig();
    if (cfg.mondayColumns.twoStepLink) {
        return "Trebuie sa introduci codul primit in email: AICI";
    }
    return `Trebuie sa introduci codul primit in email: AICI -> ${link}`;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export class EventProcessor {
    monday = new MondayClient();
    signTwoStepToken(payload) {
        const encodedPayload = b64url(JSON.stringify(payload));
        const secret = getConfig().twoStep.tokenSecret;
        const signature = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
        return `${encodedPayload}.${signature}`;
    }
    verifyTwoStepToken(token) {
        const [encodedPayload, encodedSignature] = String(token || "").split(".");
        if (!encodedPayload || !encodedSignature) {
            return { ok: false, reason: "Token invalid." };
        }
        const secret = getConfig().twoStep.tokenSecret;
        const expected = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
        const sigOk = crypto.timingSafeEqual(Buffer.from(encodedSignature), Buffer.from(expected));
        if (!sigOk)
            return { ok: false, reason: "Semnătură token invalidă." };
        let payload;
        try {
            payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
        }
        catch {
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
    async setPublicationErrorWithMessage(boardId, itemId, statusColumnId, message) {
        const cfg = getConfig();
        await this.monday.changeTextColumn(boardId, itemId, cfg.mondayColumns.error, toDisplayMessage(message));
        await this.monday.changeStatusLabel(boardId, itemId, statusColumnId, cfg.publicationBursa.errorLabel);
    }
    async clearErrorState(boardId, itemId) {
        const cfg = getConfig();
        await this.monday.changeTextColumn(boardId, itemId, cfg.mondayColumns.error, "");
        if (cfg.mondayColumns.twoStepLink) {
            await this.monday.changeLinkColumn(boardId, itemId, cfg.mondayColumns.twoStepLink, "", "");
        }
    }
    buildTwoStepLink(meta, token) {
        const baseUrl = buildBaseUrlFromRequestMeta(meta);
        return `${baseUrl}/2step?token=${encodeURIComponent(token)}`;
    }
    /**
     * Publicare Bursă: doar coloana `publicationBursa` + label `Publica pe bursa`.
     * Fără rutare Site / fără trigger generic „De publicat”.
     */
    async processWebhookPayload(body, meta) {
        const cfg = getConfig();
        const ref = extractEventRef(body);
        if (!ref) {
            logger.warn("Webhook payload missing event ref");
            return;
        }
        if (ref.columnId !== cfg.mondayColumns.publicationBursa) {
            return;
        }
        const { boardId, itemId } = ref;
        const publicationColId = cfg.mondayColumns.publicationBursa;
        const expectedLabel = cfg.publicationBursa.triggerLabel;
        // Monday can be eventually consistent right after the webhook event.
        // If the status label reads empty, retry a couple of times before skipping.
        let item = await this.monday.fetchItem(boardId, itemId);
        let cols = colsToMap(item.column_values);
        let rawCol = cols[publicationColId];
        let currentLabel = getStatusLabel(rawCol);
        if (!currentLabel) {
            logger.info("Publication label empty after webhook; retrying read", {
                triggerColumnId: ref.columnId,
                publicationColId,
                expectedLabel,
                boardId,
                itemId,
                col: rawCol ? { id: rawCol.id, text: rawCol.text ?? null, value: rawCol.value ?? null } : null,
            });
            for (const delayMs of [250, 750, 1500]) {
                await sleep(delayMs);
                item = await this.monday.fetchItem(boardId, itemId);
                cols = colsToMap(item.column_values);
                rawCol = cols[publicationColId];
                currentLabel = getStatusLabel(rawCol);
                if (currentLabel)
                    break;
            }
        }
        logger.debug("Publication label check", {
            triggerColumnId: ref.columnId,
            publicationColId,
            expectedLabel,
            currentLabel,
            boardId,
            itemId,
            col: rawCol ? { id: rawCol.id, text: rawCol.text ?? null, value: rawCol.value ?? null } : null,
        });
        if (currentLabel !== cfg.publicationBursa.triggerLabel) {
            logger.info("Skipping webhook: publication label mismatch", { currentLabel });
            return;
        }
        await statusRouter.setPublicationProcessing(this.monday, cfg, boardId, itemId);
        const fail = async (prefix, message) => {
            const text = `${prefix} ${message}`.trim().slice(0, 1800);
            await this.monday.changeTextColumn(boardId, itemId, cfg.mondayColumns.error, text);
            await statusRouter.setPublicationError(this.monday, cfg, boardId, itemId);
        };
        const businessErrors = validateBusinessRules(cols);
        if (businessErrors.length) {
            await fail("[BUSINESS RULES]", businessErrors.join("; "));
            return;
        }
        const authPick = await resolveBasicAuthForBursa(this.monday, cols);
        if (!authPick.ok) {
            await fail("[USER]", authPick.error);
            return;
        }
        const validationErrors = validateRequired(cols);
        if (validationErrors.length) {
            await fail("[VALIDATION]", validationErrors.join("; "));
            return;
        }
        const { payload, errors: mapErrors } = buildLoadPayload(cols, Number(itemId));
        if (mapErrors.length) {
            await fail("[MAPPING]", mapErrors.join("; "));
            return;
        }
        const bursaRes = await postBursaLoad(authPick.authHeader, payload);
        if (bursaResponseRequiresTwoStep(bursaRes.status, bursaRes.data)) {
            const tokenPayload = {
                v: 1,
                exp: Date.now() + cfg.twoStep.tokenTtlSeconds * 1000,
                boardId,
                itemId,
                statusColumnId: cfg.mondayColumns.publicationBursa,
                integration: "123cargo",
                action: "publishLoad",
            };
            const token = this.signTwoStepToken(tokenPayload);
            const link = this.buildTwoStepLink(meta, token);
            const text = buildTwoStepMessage(link);
            await this.setPublicationErrorWithMessage(boardId, itemId, cfg.mondayColumns.publicationBursa, text);
            if (cfg.mondayColumns.twoStepLink) {
                await this.monday.changeLinkColumn(boardId, itemId, cfg.mondayColumns.twoStepLink, link, "AICI");
            }
            logger.warn("Two-step required, waiting for user code", { boardId, itemId });
            return;
        }
        const ok = bursaRes.status === 200 && bursaRes.data?.resultCode === 0;
        if (ok) {
            await statusRouter.setPublicationSuccess(this.monday, cfg, boardId, itemId);
            await this.monday.changeTextColumn(boardId, itemId, cfg.mondayColumns.error, "");
        }
        else {
            const msg = `HTTP ${bursaRes.status} - ${JSON.stringify(bursaRes.data)?.slice(0, 800)}`;
            await fail("[123CARGO]", msg);
        }
    }
    validateTwoStepToken(token) {
        const verified = this.verifyTwoStepToken(token);
        if (!verified.ok)
            return { ok: false, message: verified.reason };
        return { ok: true, message: "ok" };
    }
    async processTwoStepToken(token, code) {
        const cfg = getConfig();
        const verified = this.verifyTwoStepToken(token);
        if (!verified.ok)
            return { ok: false, message: verified.reason };
        if (!code.trim())
            return { ok: false, message: "Codul SMS este obligatoriu." };
        const payload = verified.payload;
        if (payload.integration !== "123cargo" || !cargo123Integration.completeTwoStepPublish) {
            return { ok: false, message: `Integrarea '${payload.integration}' nu suportă confirmare 2-step aici.` };
        }
        const item = await this.monday.fetchItem(payload.boardId, payload.itemId);
        const context = {
            boardId: payload.boardId,
            itemId: payload.itemId,
            statusColumnId: payload.statusColumnId,
            item,
            mondayClient: this.monday,
        };
        await this.monday.changeStatusLabel(payload.boardId, payload.itemId, payload.statusColumnId, cfg.publicationBursa.processingLabel);
        const result = await cargo123Integration.completeTwoStepPublish(context, code.trim());
        if (result.status === "success") {
            await this.monday.changeStatusLabel(payload.boardId, payload.itemId, payload.statusColumnId, cfg.publicationBursa.successLabel);
            await this.clearErrorState(payload.boardId, payload.itemId);
            return { ok: true, message: "Publicare realizată cu succes." };
        }
        const message = result.status === "error" ? result.message : "[123CARGO] Eroare necunoscută.";
        await this.setPublicationErrorWithMessage(payload.boardId, payload.itemId, payload.statusColumnId, message);
        return { ok: false, message };
    }
}
