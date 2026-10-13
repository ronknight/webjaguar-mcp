// Server configuration, read from environment variables only.

import os from "node:os";
import path from "node:path";

import { envBool, envInt, envRequired, envString, envUrl, Env } from "./core/env";
import { ConfigError } from "./core/errors";

export interface WebJaguarConfig {
  baseUrl: string;
  apiPath: string;
  username: string;
  password: string;
  environmentLabel: string;
  allowWrites: boolean;
  archiveDir: string;
  extraWritableFields: string[];
  timeoutMs: number;
  maxConcurrency: number;
  logLevel?: string;
}

export function loadConfig(env: Env = process.env): WebJaguarConfig {
  const baseUrl = envUrl(env, "WEBJAGUAR_BASE_URL", "Set it to your store's root URL, e.g. https://www.example.com.");
  const apiPath = (envString(env, "WEBJAGUAR_API_PATH") ?? "api/v1").replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_\-/]+$/.test(apiPath)) throw new ConfigError("WEBJAGUAR_API_PATH may contain only letters, digits, -, _ and /.");
  const extra = (envString(env, "WEBJAGUAR_EXTRA_WRITABLE_FIELDS") ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  for (const field of extra) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) throw new ConfigError(`WEBJAGUAR_EXTRA_WRITABLE_FIELDS has an invalid field name: "${field}".`);
  }
  return {
    baseUrl,
    apiPath,
    username: envRequired(env, "WEBJAGUAR_USERNAME", "Use the API user WebJaguar set up for your store."),
    password: envRequired(env, "WEBJAGUAR_PASSWORD", "Use the API user's password."),
    environmentLabel: envString(env, "WEBJAGUAR_ENVIRONMENT_LABEL") ?? new URL(baseUrl).hostname,
    allowWrites: envBool(env, "WEBJAGUAR_ALLOW_WRITES", false),
    archiveDir: path.resolve(envString(env, "WEBJAGUAR_ARCHIVE_DIR") ?? path.join(os.homedir(), ".webjaguar-mcp", "archive")),
    extraWritableFields: extra,
    // Product and order responses are large; allow more time than usual.
    timeoutMs: envInt(env, "WEBJAGUAR_TIMEOUT_SECONDS", 60, 5, 300) * 1000,
    // No documented rate limit, so stay gentle.
    maxConcurrency: envInt(env, "WEBJAGUAR_MAX_CONCURRENCY", 2, 1, 6),
    logLevel: envString(env, "WEBJAGUAR_LOG_LEVEL"),
  };
}
