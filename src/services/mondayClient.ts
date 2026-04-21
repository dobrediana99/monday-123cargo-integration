import axios from "axios";
import { config } from "../utils/config.js";

const MONDAY_URL = "https://api.monday.com/v2";

export type MondayColumnValue = { id: string; text: string | null; value: string | null };
export type MondayItem = { id: string; name: string; column_values: MondayColumnValue[] };

type MondayGraphQLError = { message?: string };
type MondayGraphQLResponse<T> = { data?: T; errors?: MondayGraphQLError[] };

export type MondayWebhookBody = {
  challenge?: string;
  event?: {
    boardId: number | string;
    pulseId?: number | string;
    itemId?: number | string;
    columnId?: string | { columnId?: string };
    value?: unknown;
    previousValue?: unknown;
  };
};

export type MondayEventRef = {
  boardId: string;
  itemId: string;
  columnId: string;
};

export class MondayClient {
  private async gql<T>(query: string, variables: unknown): Promise<T> {
    const res = await axios.post(
      config.mondayApiUrl,
      { query, variables },
      {
        headers: {
          Authorization: config.mondayApiToken,
        },
      }
    );
    const body = res.data as MondayGraphQLResponse<T>;
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const msg = body.errors.map((e) => e.message || "Unknown monday error").join(" | ");
      throw new Error(`Monday GraphQL error: ${msg}`);
    }
    if (!body?.data) {
      throw new Error("Monday GraphQL error: missing data");
    }
    return body.data;
  }

  async fetchItem(boardId: string, itemId: string): Promise<MondayItem> {
    const query = `
      query ($boardId:[ID!], $itemId:[ID!]) {
export type MondayUserDetails = {
  id: string;
  name: string;
  email: string | null;
};

type GqlEnvelope<T> = { data?: T; errors?: { message: string }[] };

export class MondayClient {
  constructor(private readonly token: string) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await axios.post<GqlEnvelope<T>>(
      MONDAY_URL,
      { query, variables },
      { headers: { Authorization: this.token, "Content-Type": "application/json" } }
    );
    const body = res.data;
    if (body.errors?.length) {
      throw new Error(body.errors.map((e) => e.message).join("; "));
    }
    return body.data as T;
  }

  async fetchItem(boardId: number, itemId: number): Promise<MondayItem> {
    const q = `
      query ($boardId:[Int], $itemId:[Int]) {
        boards(ids:$boardId) {
          items_page(limit:1, query_params:{ ids:$itemId }) {
            items { id name column_values { id text value } }
          }
        }
      }`;
    const data: any = await this.gql(query, { boardId: [boardId], itemId: [itemId] });
    const item = data?.boards?.[0]?.items_page?.items?.[0];
    if (!item) {
      throw new Error("Item not found in monday");
    }
    return item as MondayItem;
  }

  async changeStatusLabel(boardId: string, itemId: string, columnId: string, label: string) {
    const mutation = `
      mutation ($boardId:ID!, $itemId:ID!, $colId:String!, $val:JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
    return this.gql(mutation, { boardId, itemId, colId: columnId, val: JSON.stringify({ label }) });
  }

  async changeTextColumn(boardId: string, itemId: string, columnId: string, text: string) {
    const mutation = `
      mutation ($boardId:ID!, $itemId:ID!, $colId:String!, $val:String!) {
        change_simple_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
    return this.gql(mutation, { boardId, itemId, colId: columnId, val: text });
  }

  async changeLinkColumn(boardId: string, itemId: string, columnId: string, url: string, text: string) {
    const mutation = `
      mutation ($boardId:ID!, $itemId:ID!, $colId:String!, $val:JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
    return this.gql(mutation, {
      boardId,
      itemId,
      colId: columnId,
      val: JSON.stringify({ url, text }),
    });
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
  const columnId =
    typeof colRaw === "object" && colRaw !== null
      ? String(colRaw.columnId || "")
      : String(colRaw || "");
  if (!boardIdRaw || !itemIdRaw || !columnId) return null;

  return {
    boardId: String(boardIdRaw),
    itemId: String(itemIdRaw),
    columnId,
  };
}

export function getStatusLabel(col: MondayColumnValue | undefined): string {
  if (!col?.value) return "";
  try {
    const parsed = JSON.parse(col.value);
    return String(parsed?.label || "");
  } catch {
    return "";
    const data = await this.gql<{
      boards?: { items_page?: { items?: MondayItem[] } }[];
    }>(q, { boardId, itemId });
    const item = data?.boards?.[0]?.items_page?.items?.[0];
    if (!item) throw new Error("Item not found in monday");
    return item;
  }

  async changeTextColumn(boardId: number, itemId: number, columnId: string, text: string) {
    const m = `
      mutation ($boardId:Int!, $itemId:Int!, $colId:String!, $val:JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
    return this.gql(m, { boardId, itemId, colId: columnId, val: JSON.stringify({ text }) });
  }

  async changeStatusLabel(boardId: number, itemId: number, statusColId: string, label: string) {
    const m = `
      mutation ($boardId:Int!, $itemId:Int!, $colId:String!, $val:JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
    return this.gql(m, { boardId, itemId, colId: statusColId, val: JSON.stringify({ label }) });
  }

  /** Resolve Monday user id → profile including email (for Bursa auth mapping). */
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
}
