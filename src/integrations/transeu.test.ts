import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

process.env.MONDAY_TOKEN = process.env.MONDAY_TOKEN || "test-token";
process.env.TRIGGER_STATUS_SUCCESS_LABEL = process.env.TRIGGER_STATUS_SUCCESS_LABEL || "Publicata";
process.env.TRIGGER_STATUS_ERROR_LABEL = process.env.TRIGGER_STATUS_ERROR_LABEL || "Eroare";
process.env.DEAL_OWNER_COLUMN_ID = process.env.DEAL_OWNER_COLUMN_ID || "deal_owner";
process.env.ERROR_COLUMN_ID = process.env.ERROR_COLUMN_ID || "error_col";
process.env.BURSA_BASE = process.env.BURSA_BASE || "https://bursa.example";
process.env.BURSA_PASSWORD = process.env.BURSA_PASSWORD || "test-bursa-password";
process.env.TRANSEU_BASE_URL = process.env.TRANSEU_BASE_URL || "https://api.platform.trans.eu";
process.env.TRANSEU_CLIENT_ID = process.env.TRANSEU_CLIENT_ID || "client-id";
process.env.TRANSEU_CLIENT_SECRET = process.env.TRANSEU_CLIENT_SECRET || "client-secret";
process.env.TRANSEU_API_KEY = process.env.TRANSEU_API_KEY || "api-key";
process.env.TRANSEU_REFRESH_TOKEN = process.env.TRANSEU_REFRESH_TOKEN || "refresh-token";
process.env.ENABLED_INTEGRATIONS = process.env.ENABLED_INTEGRATIONS || "transeu";

const { mapMondayToTransEuPayload, transeuIntegration, resetTransEuClientForTests } = await import("./transeu.js");
type IntegrationContext = import("./types.js").IntegrationContext;

const originalAxiosPost = axios.post;

function buildContext(overrides: Partial<Record<string, string>> = {}): IntegrationContext {
  const columns = {
    text_mkypcczr: "Cluj-Napoca",
    dropdown_mkx6jyjf: "Romania",
    text_mkypxb8h: "Berlin",
    dropdown_mkx687jv: "Germany",
    date_mkx77z0m: "2026-03-20",
    text_mkt9nr81: "24000",
    dropdown_mkx1s5nv: "Prelata",
    color_mksemxby: "General goods",
    color_mkrb3hhk: "Complete FTL",
    numeric_mkr4e4qc: "1800",
    color_mksh2abx: "EUR",
    ...overrides,
  };

  return {
    boardId: "1",
    itemId: "1001",
    statusColumnId: "status",
    item: {
      id: "1001",
      name: "Test freight",
      column_values: Object.entries(columns).map(([id, text]) => ({
        id,
        text,
        value: null,
      })),
    },
  };
}

test("mapMondayToTransEuPayload maps monday columns into Trans.eu payload", () => {
  const context = buildContext();
  const { payload, errors } = mapMondayToTransEuPayload(context);

  assert.equal(errors.length, 0);
  assert.equal(payload.publish, true);
  assert.equal(payload.capacity, 24);
  assert.equal(payload.shipment_external_id, "1001");
  assert.deepEqual(payload.requirements.required_truck_bodies, ["curtainsider"]);
  assert.equal(payload.requirements.is_ftl, true);
  assert.equal(payload.spots[0].place.address.country, "RO");
  assert.equal(payload.spots[1].place.address.country, "DE");
  assert.equal(payload.payment.price.currency, "eur");
});

test("transeuIntegration.publishLoad succeeds with valid API responses", async () => {
  resetTransEuClientForTests();
  const calls: Array<{ url: string }> = [];

  (axios.post as unknown as typeof originalAxiosPost) = (async (url: string, data: any) => {
    calls.push({ url });
    if (url.endsWith("/ext/auth-api/accounts/token")) {
      assert.equal(String(data).includes("grant_type=refresh_token"), true);
      return {
        status: 200,
        data: {
          access_token: "access-token-1",
          refresh_token: "refresh-token-1",
          expires_in: 3600,
          token_type: "Bearer",
        },
        headers: {},
      } as any;
    }
    if (url.endsWith("/ext/freights-api/v1/freight-exchange")) {
      return {
        status: 201,
        data: { id: 987654 },
        headers: {},
      } as any;
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as any;

  const result = await transeuIntegration.publishLoad(buildContext());
  assert.equal(result.status, "success");
  assert.equal(calls.length, 2);
});

test("transeuIntegration.publishLoad returns API error on failed publish", async () => {
  resetTransEuClientForTests();
  const calls: Array<{ url: string }> = [];

  (axios.post as unknown as typeof originalAxiosPost) = (async (url: string) => {
    calls.push({ url });
    if (url.endsWith("/ext/auth-api/accounts/token")) {
      return {
        status: 200,
        data: {
          access_token: "access-token-2",
          refresh_token: "refresh-token-2",
          expires_in: 3600,
          token_type: "Bearer",
        },
        headers: {},
      } as any;
    }
    if (url.endsWith("/ext/freights-api/v1/freight-exchange")) {
      return {
        status: 422,
        data: {
          detail: "Failed Validation",
          validation_messages: { capacity: { value: { isEmpty: "Value is required and can't be empty" } } },
        },
        headers: {},
      } as any;
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as any;

  const result = await transeuIntegration.publishLoad(buildContext());
  assert.equal(result.status, "error");
  assert.equal(result.message.includes("[TRANSEU]"), true);
  assert.equal(calls.length, 2);
});

test.after(() => {
  resetTransEuClientForTests();
  axios.post = originalAxiosPost;
});
