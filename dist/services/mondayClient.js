import axios from "axios";
import { getConfig } from "../utils/config.js";
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
        const m = `
      mutation ($boardId: ID!, $itemId: ID!, $colId: String!, $val: JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
        return this.gql(m, {
            boardId: String(boardId),
            itemId: String(itemId),
            colId: columnId,
            val: JSON.stringify({ text }),
        });
    }
    async changeStatusLabel(boardId, itemId, statusColId, label) {
        const m = `
      mutation ($boardId: ID!, $itemId: ID!, $colId: String!, $val: JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
        return this.gql(m, {
            boardId: String(boardId),
            itemId: String(itemId),
            colId: statusColId,
            val: JSON.stringify({ label }),
        });
    }
    async changeLinkColumn(boardId, itemId, columnId, url, text) {
        const m = `
      mutation ($boardId: ID!, $itemId: ID!, $colId: String!, $val: JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
        return this.gql(m, {
            boardId: String(boardId),
            itemId: String(itemId),
            colId: columnId,
            val: JSON.stringify({ url, text }),
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
