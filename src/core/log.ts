// Logging for stdio MCP servers. stdout carries the protocol, so every log line goes to stderr.

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = "info";
let prefix = "mcp";

export function configureLog(name: string, level: string | undefined): void {
  prefix = name;
  if (level && level in ORDER) threshold = level as Level;
}

function emit(level: Level, message: string): void {
  if (ORDER[level] < ORDER[threshold]) return;
  process.stderr.write(`[${prefix}] ${level}: ${message}\n`);
}

export const log = {
  debug: (message: string) => emit("debug", message),
  info: (message: string) => emit("info", message),
  warn: (message: string) => emit("warn", message),
  error: (message: string) => emit("error", message),
};
