import { createServer } from "./server.js";
import { getConfig } from "./utils/config.js";
import { logger } from "./utils/logger.js";
/** Minimal JSON lines for Cloud Run when the process dies before `listen()`. */
function logBoot(message, meta = {}) {
    console.log(JSON.stringify({ phase: "boot", message, timestamp: new Date().toISOString(), ...meta }));
}
function logBootFatal(err) {
    const error = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(JSON.stringify({
        phase: "boot_fatal",
        message: "Startup failed before listen(); check env vars and config",
        error,
        stack,
        timestamp: new Date().toISOString(),
    }));
}
try {
    logBoot("createServer: begin");
    const app = createServer();
    logBoot("createServer: ok");
    logBoot("getConfig: begin");
    const cfg = getConfig();
    logBoot("getConfig: ok", { port: cfg.port, nodeEnv: cfg.nodeEnv });
    logBoot("listen: begin", { port: cfg.port });
    const server = app.listen(cfg.port, () => {
        logger.info("Server started", { port: cfg.port, env: cfg.nodeEnv });
    });
    server.on("error", (listenErr) => {
        logBootFatal(listenErr);
        process.exit(1);
    });
}
catch (err) {
    logBootFatal(err);
    process.exit(1);
}
