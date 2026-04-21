import axios from "axios";
const MONDAY_URL = "https://api.monday.com/v2";
export class MondayClient {
    token;
    constructor(token) {
        this.token = token;
    }
    async gql(query, variables = {}) {
        const res = await axios.post(MONDAY_URL, { query, variables }, { headers: { Authorization: this.token, "Content-Type": "application/json" } });
        const body = res.data;
        if (body.errors?.length) {
            throw new Error(body.errors.map((e) => e.message).join("; "));
        }
        return body.data;
    }
    async fetchItem(boardId, itemId) {
        const q = `
      query ($boardId:[Int], $itemId:[Int]) {
        boards(ids:$boardId) {
          items_page(limit:1, query_params:{ ids:$itemId }) {
            items { id name column_values { id text value } }
          }
        }
      }`;
        const data = await this.gql(q, { boardId, itemId });
        const item = data?.boards?.[0]?.items_page?.items?.[0];
        if (!item)
            throw new Error("Item not found in monday");
        return item;
    }
    async changeTextColumn(boardId, itemId, columnId, text) {
        const m = `
      mutation ($boardId:Int!, $itemId:Int!, $colId:String!, $val:JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
        return this.gql(m, { boardId, itemId, colId: columnId, val: JSON.stringify({ text }) });
    }
    async changeStatusLabel(boardId, itemId, statusColId, label) {
        const m = `
      mutation ($boardId:Int!, $itemId:Int!, $colId:String!, $val:JSON!) {
        change_column_value(board_id:$boardId, item_id:$itemId, column_id:$colId, value:$val) { id }
      }`;
        return this.gql(m, { boardId, itemId, colId: statusColId, val: JSON.stringify({ label }) });
    }
    /** Resolve Monday user id → profile including email (for Bursa auth mapping). */
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
}
