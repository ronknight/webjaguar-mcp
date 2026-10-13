// Typed readers for environment configuration. Every reader fails loudly on bad input.

import { ConfigError } from "./errors";

export type Env = Record<string, string | undefined>;

export function envString(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function envRequired(env: Env, name: string, hint: string): string {
  const value = envString(env, name);
  if (!value) throw new ConfigError(`${name} is not set. ${hint}`);
  return value;
}

export function envBool(env: Env, name: string, fallback: boolean): boolean {
  const value = envString(env, name);
  if (value === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new ConfigError(`${name} must be true or false, got "${value}".`);
}

export function envInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const value = envString(env, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}, got "${value}".`);
  }
  return parsed;
}

/** Reads an http(s) URL and strips trailing slashes. */
export function envUrl(env: Env, name: string, hint: string): string {
  const value = envRequired(env, name, hint);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: "${value}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${name} must use https:// (or http:// for a local test server).`);
  }
  return value.replace(/\/+$/, "");
}
