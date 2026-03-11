import { createServer } from "./server.js";
import { config } from "./utils/config.js";
import { logger } from "./utils/logger.js";

const app = createServer();

app.listen(config.port, () => {
  logger.info("Server started", { port: config.port, env: config.nodeEnv });
});
