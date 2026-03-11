import express from "express";
import { webhookRouter } from "./routes/webhook.js";
import { logger } from "./utils/logger.js";

export function createServer() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
  app.use(webhookRouter());

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error("Unhandled HTTP error", { error: String(err) });
    res.status(500).json({ ok: false, error: "internal_error" });
  });

  return app;
}
