import { getConfig } from "../utils/config.js";
import { colsToMap, getStatusLabel } from "../utils/mondayParsing.js";
import { postLoadTo123Cargo, resolveBasicAuthForBursa } from "../integrations/123cargo.js";
import { buildLoadPayload, validateBusinessRules, validateRequired } from "./loadProcessing.js";
import * as statusRouter from "./statusRouter.js";
function resolveTriggerColumnId(event) {
    return event.columnId?.trim() || event.ref?.columnId?.trim();
}
export async function processWebhookPayload(body, monday) {
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
    const fail = async (prefix, message) => {
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
    const ok = bursaRes.status === 200 && bursaRes.data?.resultCode === 0;
    if (ok) {
        await statusRouter.setPublicationSuccess(monday, cfg, boardId, itemId);
        await monday.changeTextColumn(boardId, itemId, cfg.mondayColumns.error, "");
    }
    else {
        const msg = `[123CARGO] HTTP ${bursaRes.status} - ${JSON.stringify(bursaRes.data)?.slice(0, 800)}`;
        await monday.changeTextColumn(boardId, itemId, cfg.mondayColumns.error, msg);
        await statusRouter.setPublicationError(monday, cfg, boardId, itemId);
    }
    return { httpStatus: 200, json: { ok: true } };
}
