// WebJaguar REST client. Endpoints are <base>/<apiPath>/<name>.jhtm with HTTP Basic auth.
// Behavior noted here was observed on real stores and may differ between stores and API users.

import { ApiError } from "./core/errors";
import { HttpClient, QueryValue } from "./core/http";
import { Redactor } from "./core/redact";
import { WebJaguarConfig } from "./config";

export const USER_AGENT = "webjaguar-mcp/0.1.0";

export type Json = Record<string, unknown>;

export class WebJaguarClient {
  readonly http: HttpClient;

  constructor(
    readonly config: WebJaguarConfig,
    redactor: Redactor,
    fetchImpl?: typeof fetch,
  ) {
    const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
    redactor.add(config.password, auth);
    this.http = new HttpClient({
      baseUrl: `${config.baseUrl}/${config.apiPath}`,
      userAgent: USER_AGENT,
      redactor,
      timeoutMs: config.timeoutMs,
      maxConcurrency: config.maxConcurrency,
      headers: () => ({ Authorization: auth }),
      fetchImpl,
    });
  }

  get host(): string {
    return new URL(this.config.baseUrl).hostname;
  }

  async get(endpoint: string, query?: Record<string, QueryValue>): Promise<Json> {
    try {
      return ((await this.http.request({ method: "GET", path: `${endpoint}.jhtm`, query })) ?? {}) as Json;
    } catch (err) {
      throw explain(err, endpoint);
    }
  }

  async post(endpoint: string, body: unknown): Promise<Json> {
    try {
      return ((await this.http.request({ method: "POST", path: `${endpoint}.jhtm`, body })) ?? {}) as Json;
    } catch (err) {
      throw explain(err, endpoint);
    }
  }

  /** GET that turns WebJaguar's "nothing found" answers (HTTP 400 or 200 with a message) into null. */
  async find(endpoint: string, query: Record<string, QueryValue>, key: string): Promise<unknown | null> {
    try {
      const data = await this.get(endpoint, query);
      const value = data[key];
      if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return null;
      return value;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

const NOT_FOUND = /no .{0,40}found|not found|no sales rep/i;

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && NOT_FOUND.test(err.message);
}

function explain(err: unknown, endpoint: string): unknown {
  if (!(err instanceof ApiError)) return err;
  if (err.status === 401) {
    return new ApiError(
      `${err.message}. Either the credentials are wrong, or this API user is not permitted to call ${endpoint} (WebJaguar grants API access per endpoint; ask WebJaguar support to enable it).`,
      401,
      err.detail,
    );
  }
  if ((err.status === 403 || err.status === 503) && /cf-chl|just a moment|cloudflare/i.test(JSON.stringify(err.detail ?? ""))) {
    return new ApiError(
      `${err.message}. The request was stopped by the store's bot protection (Cloudflare). Ask the store or WebJaguar to allow API traffic from this machine.`,
      err.status,
      err.detail,
    );
  }
  if (err.status === 404) {
    return new ApiError(`${err.message}. The endpoint ${endpoint} is not available on this store.`, 404, err.detail);
  }
  return err;
}
