import axios from "axios";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";
export class MondayClient {
    gqlUrl() {
        return getConfig().mondayApiUrl;
    }
    authHeader() {
        return getConfig().mondayToken;
    }
    async gql(query, variables = {}) {
        const res = await axios.post(this.gqlUrl(), { query, variables }, {
            headers: {
                Authorization: this.authHeader(),
                "Content-Type": "application/json",
            },
        });
        const body = res.data;
        if (Array.isArray(body?.errors) && body.errors.length > 0) {
            const msg = body.errors.map((e) => e.message || "Unknown monday error").join(" | ");
            throw new Error(`Monday GraphQL error: ${msg}`);
        }
        if (!body?.data)
            throw new Error("Monday GraphQL error: missing data");
        return body.data;
    }
    async fetchItem(boardId, itemId) {
        const q = `
      query ($boardId: [ID!], $itemId: [ID!]) {
        boards(ids:$boardId) {
          items_page(limit:1, query_params:{ ids:$itemId }) {
            items { id name column_values { id text value } }
          }
        }
      }`;
        const data = await this.gql(q, { boardId: [String(boardId)], itemId: [String(itemId)] });
        const item = data?.boards?.[0]?.items_page?.items?.[0];
        if (!item)
            throw new Error("Item not found in monday");
        return item;
    }
    async changeTextColumn(boardId, itemId, columnId, text) {
        const trimmed = String(text ?? "");
        // Text / long-text columns are unreliable with `change_column_value` + `{"text": ...}` on some boards;
        // Monday documents `change_simple_column_value` for plain string updates.
        const m = `
      mutation ($boardId: ID!, $itemId: ID!, $colId: String!, $val: String!) {
        change_simple_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
        logger.info("Monday write: changeTextColumn", {
            boardId: String(boardId),
            itemId: String(itemId),
            columnId,
            value: trimmed,
        });
        return this.gql(m, {
            boardId: String(boardId),
            itemId: String(itemId),
            colId: columnId,
            val: trimmed,
        });
    }
    async changeStatusLabel(boardId, itemId, statusColId, label) {
        const trimmed = String(label ?? "").trim();
        const m = `
      mutation ($boardId: ID!, $itemId: ID!, $colId: String!, $val: JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
        const val = JSON.stringify({ label: trimmed });
        logger.info("Monday write: changeStatusLabel", {
            boardId: String(boardId),
            itemId: String(itemId),
            columnId: statusColId,
            value: val,
        });
        return this.gql(m, {
            boardId: String(boardId),
            itemId: String(itemId),
            colId: statusColId,
            val,
        });
    }
    async changeLinkColumn(boardId, itemId, columnId, url, text) {
        const trimmedUrl = String(url ?? "").trim();
        const trimmedText = String(text ?? "").trim();
        const m = `
      mutation ($boardId: ID!, $itemId: ID!, $colId: String!, $val: JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
        const val = JSON.stringify({ url: trimmedUrl, text: trimmedText });
        logger.info("Monday write: changeLinkColumn", {
            boardId: String(boardId),
            itemId: String(itemId),
            columnId,
            value: val,
        });
        return this.gql(m, {
            boardId: String(boardId),
            itemId: String(itemId),
            colId: columnId,
            val,
        });
    }
    async fetchUserById(userId) {
        const q = `
      query ($ids: [ID!]) {
        users(ids: $ids) {
          id
          name
          email
        }
      }`;
        const data = await this.gql(q, {
            ids: [String(userId)],
        });
        const u = data?.users?.[0];
        if (!u)
            return null;
        return { id: String(u.id), name: String(u.name ?? ""), email: u.email ?? null };
    }
    colsToMap(columnValues) {
        return Object.fromEntries(columnValues.map((c) => [c.id, c]));
    }
}
export function extractEventRef(body) {
    const event = body?.event;
    if (!event)
        return null;
    const boardIdRaw = event.boardId;
    const itemIdRaw = event.pulseId ?? event.itemId;
    const colRaw = event.columnId;
    const fromRef = event.ref?.columnId?.trim();
    const fromCol = typeof colRaw === "object" && colRaw !== null
        ? String(colRaw.columnId || "").trim()
        : String(colRaw || "").trim();
    const columnId = fromCol || fromRef || "";
    if (boardIdRaw == null || itemIdRaw == null || !columnId)
        return null;
    return {
        boardId: String(boardIdRaw),
        itemId: String(itemIdRaw),
        columnId,
    };
}
