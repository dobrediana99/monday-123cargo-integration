import { createServer } from "./server.js";
import { getConfig } from "./utils/config.js";
import { logger } from "./utils/logger.js";
const app = createServer();
const cfg = getConfig();
app.listen(cfg.port, () => {
    logger.info("Server started", { port: cfg.port, env: cfg.nodeEnv });
});
