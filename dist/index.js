import express from "express";
import { getConfig } from "./utils/config.js";
import { MondayClient } from "./services/mondayClient.js";
import { processWebhookPayload } from "./services/eventProcessor.js";
const cfg = getConfig();
const monday = new MondayClient(cfg.mondayToken);
const app = express();
app.use(express.json());
app.get("/health", (_, res) => res.json({ ok: true }));
app.post("/webhooks/monday", async (req, res) => {
    try {
        const result = await processWebhookPayload(req.body, monday);
        return res.status(result.httpStatus).json(result.json);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return res.status(200).json({ ok: true, error: "internal", detail: msg });
    }
});
app.listen(cfg.port, () => {
    console.log(`Server running on http://localhost:${cfg.port}`);
});
