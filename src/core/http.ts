// Small HTTP client shared by the MCP servers: timeouts, bounded retries, a concurrency cap
// and error messages that never carry secrets.

import { ApiError } from "./errors";
import { log } from "./log";
import { Redactor } from "./redact";

export type QueryValue = string | number | boolean | undefined | null | Array<string | number>;

export interface HttpOptions {
  baseUrl: string;
  userAgent: string;
  redactor: Redactor;
  timeoutMs?: number;
  maxRetries?: number;
  maxConcurrency?: number;
  /** Headers added to every request, e.g. auth. Called per request so tokens can refresh. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Injected in tests so no request ever leaves the machine. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, QueryValue>;
  /** JSON body. */
  body?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

const RETRY_STATUS_SAFE = new Set([429, 500, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_RETRY_AFTER_MS = 60_000;

export class HttpClient {
  private active = 0;
  private waiting: Array<() => void> = [];
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  url(path: string, query?: Record<string, QueryValue>): string {
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request<T = unknown>(req: RequestOptions): Promise<T> {
    const method = (req.method ?? "GET").toUpperCase();
    const maxRetries = this.options.maxRetries ?? 3;
    let attempt = 0;
    for (;;) {
      const response = await this.withSlot(() => this.send(method, req));
      if (response.ok) return (await parseBody(response)) as T;

      // Writes are retried only on 429, where the server did not act on the request.
      const retryable = SAFE_METHODS.has(method) ? RETRY_STATUS_SAFE.has(response.status) : response.status === 429;
      if (retryable && attempt < maxRetries) {
        const wait = retryDelay(response.headers.get("retry-after"), attempt);
        log.warn(`${method} ${req.path} returned HTTP ${response.status}; retry ${attempt + 1}/${maxRetries} in ${wait} ms`);
        await response.body?.cancel().catch(() => undefined);
        await this.sleep(wait);
        attempt += 1;
        continue;
      }
      throw await this.toError(method, req.path, response);
    }
  }

  private async send(method: string, req: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.options.userAgent,
      ...(await this.options.headers?.()),
      ...req.headers,
    };
    let body: string | undefined;
    if (req.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(req.form).toString();
    } else if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(this.url(req.path, req.query), { method, headers, body, signal: controller.signal });
    } catch (err) {
      const reason = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : (err as Error).message;
      throw new ApiError(this.options.redactor.text(`${method} ${req.path} failed: ${reason}`), 0);
    } finally {
      clearTimeout(timer);
    }
  }

  private async toError(method: string, path: string, response: Response): Promise<ApiError> {
    let detail: unknown;
    try {
      detail = await parseBody(response);
    } catch {
      detail = undefined;
    }
    const summary = summarize(detail);
    const message = `${method} ${path} failed: HTTP ${response.status}${summary ? ` - ${summary}` : ""}`;
    return new ApiError(this.options.redactor.text(message), response.status, this.options.redactor.value(detail));
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    const limit = this.options.maxConcurrency ?? 4;
    while (this.active >= limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json") || /^[[{]/.test(text.trim())) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Picks the most useful human-readable part of an error body. */
export function summarize(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  if (typeof detail === "string") return detail.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  if (typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    const parts = [d.title, d.detail, d.message, d.error_description, d.error, d.name, d.description]
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (Array.isArray(d.errors)) {
      for (const e of d.errors.slice(0, 5)) {
        if (e && typeof e === "object") {
          const item = e as Record<string, unknown>;
          parts.push([item.field, item.message ?? item.detail].filter(Boolean).join(": "));
        } else if (typeof e === "string") {
          parts.push(e);
        }
      }
    }
    if (parts.length) return [...new Set(parts)].join(" | ").slice(0, 500);
    return JSON.stringify(detail).slice(0, 300);
  }
  return String(detail).slice(0, 300);
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), MAX_RETRY_AFTER_MS);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return Math.min(1000 * 2 ** attempt, MAX_RETRY_AFTER_MS);
}
