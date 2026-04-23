import axios from "axios";
import { getConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

export type MondayColumnValue = { id: string; text: string | null; value: string | null };
export type MondayItem = { id: string; name: string; column_values: MondayColumnValue[] };

export type MondayUserDetails = {
  id: string;
  name: string;
  email: string | null;
};

export type MondayWebhookBody = {
  challenge?: string;
  event?: {
    boardId: number | string;
    pulseId?: number | string;
    itemId?: number | string;
    columnId?: string | { columnId?: string };
    value?: unknown;
    previousValue?: unknown;
    ref?: { columnId?: string };
  };
};

export type MondayEventRef = {
  boardId: string;
  itemId: string;
  columnId: string;
};

type MondayGraphQLResponse<T> = { data?: T; errors?: { message?: string }[] };

export class MondayClient {
  private gqlUrl(): string {
    return getConfig().mondayApiUrl;
  }

  private authHeader(): string {
    return getConfig().mondayToken;
  }

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await axios.post<MondayGraphQLResponse<T>>(
      this.gqlUrl(),
      { query, variables },
      {
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
        },
      }
    );
    const body = res.data;
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const msg = body.errors.map((e) => e.message || "Unknown monday error").join(" | ");
      throw new Error(`Monday GraphQL error: ${msg}`);
    }
    if (!body?.data) throw new Error("Monday GraphQL error: missing data");
    return body.data;
  }

  async fetchItem(boardId: number | string, itemId: number | string): Promise<MondayItem> {
    const q = `
      query ($boardId: [ID!], $itemId: [ID!]) {
        boards(ids:$boardId) {
          items_page(limit:1, query_params:{ ids:$itemId }) {
            items { id name column_values { id text value } }
          }
        }
      }`;
    const data = await this.gql<{
      boards?: { items_page?: { items?: MondayItem[] } }[];
    }>(q, { boardId: [String(boardId)], itemId: [String(itemId)] });
    const item = data?.boards?.[0]?.items_page?.items?.[0];
    if (!item) throw new Error("Item not found in monday");
    return item;
  }

  async changeTextColumn(boardId: number | string, itemId: number | string, columnId: string, text: string) {
    const trimmed = String(text ?? "");
    const m = `
      mutation ($boardId: ID!, $itemId: ID!, $colId: String!, $val: JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
    const val = JSON.stringify({ text: trimmed });
    logger.info("Monday write: changeTextColumn", {
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

  async changeStatusLabel(boardId: number | string, itemId: number | string, statusColId: string, label: string) {
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

  async changeLinkColumn(boardId: number | string, itemId: number | string, columnId: string, url: string, text: string) {
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

  async fetchUserById(userId: number | string): Promise<MondayUserDetails | null> {
    const q = `
      query ($ids: [ID!]) {
        users(ids: $ids) {
          id
          name
          email
        }
      }`;
    const data = await this.gql<{ users?: { id: string; name: string; email: string | null }[] }>(q, {
      ids: [String(userId)],
    });
    const u = data?.users?.[0];
    if (!u) return null;
    return { id: String(u.id), name: String(u.name ?? ""), email: u.email ?? null };
  }

  colsToMap(columnValues: MondayColumnValue[]): Record<string, MondayColumnValue> {
    return Object.fromEntries(columnValues.map((c) => [c.id, c])) as Record<string, MondayColumnValue>;
  }
}

export function extractEventRef(body: MondayWebhookBody): MondayEventRef | null {
  const event = body?.event;
  if (!event) return null;

  const boardIdRaw = event.boardId;
  const itemIdRaw = event.pulseId ?? event.itemId;
  const colRaw = event.columnId;
  const fromRef = event.ref?.columnId?.trim();
  const fromCol =
    typeof colRaw === "object" && colRaw !== null
      ? String((colRaw as { columnId?: string }).columnId || "").trim()
      : String(colRaw || "").trim();
  const columnId = fromCol || fromRef || "";
  if (boardIdRaw == null || itemIdRaw == null || !columnId) return null;

  return {
    boardId: String(boardIdRaw),
    itemId: String(itemIdRaw),
    columnId,
  };
}
