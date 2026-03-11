type LogLevel = "debug" | "info" | "warn" | "error";

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
const minPriority = priorities[currentLevel] ?? priorities.info;

function write(level: LogLevel, message: string, meta: Record<string, unknown> = {}) {
  if (priorities[level] < minPriority) return;
  const line = {
    severity: level.toUpperCase(),
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  };
  const out = JSON.stringify(line);
  if (level === "error") {
    console.error(out);
    return;
  }
  if (level === "warn") {
    console.warn(out);
    return;
  }
  console.log(out);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
