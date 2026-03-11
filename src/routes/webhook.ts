import { Router } from "express";
import type { Request, Response } from "express";
import { EventProcessor } from "../services/eventProcessor.js";
import { logger } from "../utils/logger.js";
import type { MondayWebhookBody } from "../services/mondayClient.js";

const processor = new EventProcessor();

function getBaseUrl(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]) : req.protocol;
  return `${proto}://${req.get("host")}`;
}

async function handleWebhook(req: Request, res: Response) {
  const body = (req.body || {}) as MondayWebhookBody;

  if (body?.challenge) {
    return res.status(200).json({ challenge: body.challenge });
  }

  logger.info("Webhook received", { path: req.path });
  res.status(200).json({ ok: true });

  setImmediate(() => {
    processor
      .processWebhookPayload(body, { baseUrl: getBaseUrl(req) })
      .catch((error: unknown) => logger.error("Async webhook processing failed", { error: String(error) }));
  });
}

function renderHtml(title: string, body: string) {
  return `<!doctype html>
<html><body style="font-family: sans-serif; max-width: 720px; margin: 40px auto;">
  <h2>${title}</h2>
  <p>${body}</p>
</body></html>`;
}

export function webhookRouter() {
  const router = Router();

  router.post("/webhook", handleWebhook);
  // Keep backwards compatibility with old endpoint.
  router.post("/webhooks/monday", handleWebhook);

  router.get("/2step", (req, res) => {
    const token = String(req.query.token || "");
    const valid = processor.validateTwoStepToken(token);
    if (!valid.ok) {
      return res.status(400).send(renderHtml("Ticket invalid sau expirat", valid.message));
    }
    return res.status(200).send(`<!doctype html>
<html><body style="font-family: sans-serif; max-width: 720px; margin: 40px auto;">
  <h2>Confirmare 2-step BursaTransport</h2>
  <p>Introdu codul primit pe email/SMS pentru a continua publicarea.</p>
  <form method="post" action="/2step">
    <input type="hidden" name="token" value="${token}" />
    <label for="code">Cod</label><br />
    <input id="code" name="code" autocomplete="one-time-code" style="padding: 8px; width: 260px;" />
    <button type="submit" style="margin-left: 8px; padding: 8px 12px;">Confirmă</button>
  </form>
</body></html>`);
  });

  router.post("/2step", async (req, res) => {
    const token = String(req.body?.token || "");
    const code = String(req.body?.code || "");
    try {
      const result = await processor.processTwoStepToken(token, code);
      return res.status(result.ok ? 200 : 400).send(renderHtml(result.ok ? "Succes" : "Eroare", result.message));
    } catch (error: unknown) {
      logger.error("2-step HTML endpoint failed", { error: String(error) });
      return res.status(500).send(renderHtml("Eroare internă", "A apărut o eroare internă."));
    }
  });

  router.post("/internal/2step/confirm", async (req, res) => {
    const token = String(req.body?.token || "");
    const code = String(req.body?.code || "");
    try {
      const result = await processor.processTwoStepToken(token, code);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (error: unknown) {
      logger.error("2-step API endpoint failed", { error: String(error) });
      return res.status(500).json({ ok: false, message: "internal error" });
    }
  });

  return router;
}
