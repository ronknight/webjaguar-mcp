// Offline test helpers. Every test uses this fake fetch; no test may reach a real API.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

export type Route = (call: Call) => Response | undefined;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

export function fakeFetch(routes: Route[]): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (!url.hostname.endsWith(".test")) throw new Error(`test tried to reach a non-test host: ${url.hostname}`);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown = raw;
    if (raw && String((init?.headers as Record<string, string>)?.["Content-Type"]).includes("json")) body = JSON.parse(raw);
    const call: Call = { method: init?.method ?? "GET", url, headers: (init?.headers as Record<string, string>) ?? {}, body };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    return json({ title: "Not Found", detail: `no fake route for ${call.method} ${url.pathname}` }, 404);
  };
  return { calls, fetch: impl as typeof fetch };
}

export async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

export function text(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}
