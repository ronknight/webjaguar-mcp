import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { WebJaguarClient } from "../src/client";
import { loadConfig } from "../src/config";
import { ConfigError } from "../src/core/errors";
import { Redactor } from "../src/core/redact";
import { registerTools } from "../src/tools";
import { connect, fakeFetch, json, Route, text } from "./helpers";

// Invented store and credentials; the fake fetch only allows *.test hosts.
const BASE_ENV = {
  WEBJAGUAR_BASE_URL: "https://shop.test",
  WEBJAGUAR_USERNAME: "api-user",
  WEBJAGUAR_PASSWORD: "fake-password-for-tests",
  WEBJAGUAR_ENVIRONMENT_LABEL: "unit",
};

function productStore(initial: Record<string, unknown>, ignore: string[] = []) {
  const product = { ...initial };
  const route: Route = (c) => {
    if (c.method === "GET" && c.url.pathname === "/api/v1/product.jhtm") {
      return c.url.searchParams.get("sku") === product.sku ? json({ product }) : json({ message: "No product found for given Id" }, 400);
    }
    if (c.method === "POST" && c.url.pathname === "/api/v1/updateProduct.jhtm") {
      for (const [k, v] of Object.entries(c.body as Record<string, unknown>)) if (k !== "sku" && !ignore.includes(k)) product[k] = v;
      return json({ message: `Product ${product.sku} updated` });
    }
    return undefined;
  };
  return { product, route };
}

async function setup(env: Record<string, string>, routes: Route[] = []) {
  const archiveDir = mkdtempSync(path.join(os.tmpdir(), "wj-mcp-test-"));
  const config = loadConfig({ ...BASE_ENV, WEBJAGUAR_ARCHIVE_DIR: archiveDir, ...env });
  const redactor = new Redactor();
  const fake = fakeFetch(routes);
  const client = new WebJaguarClient(config, redactor, fake.fetch);
  const server = new McpServer({ name: "t", version: "0" });
  registerTools({ server, redactor, allowWrites: config.allowWrites }, client);
  return { mcp: await connect(server), calls: fake.calls, archiveDir };
}

test("config needs URL and credentials and defaults to read-only", () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ ...BASE_ENV, WEBJAGUAR_BASE_URL: "ftp://x" }), ConfigError);
  const cfg = loadConfig(BASE_ENV);
  assert.equal(cfg.allowWrites, false);
  assert.equal(cfg.apiPath, "api/v1");
});

test("read-only server offers no write tools", async () => {
  const { mcp } = await setup({});
  const tools = (await mcp.listTools()).tools;
  assert.ok(tools.some((t) => t.name === "webjaguar_get_product"));
  assert.ok(!tools.some((t) => /update|restore|archive/.test(t.name)));
});

test("missing product (HTTP 400) is reported as not found", async () => {
  const { route } = productStore({ sku: "A1", name: "Thing" });
  const { mcp } = await setup({}, [route]);
  const res = await mcp.callTool({ name: "webjaguar_get_product", arguments: { sku: "NOPE" } });
  assert.equal(res.isError, undefined);
  assert.match(text(res), /"found": false/);
});

test("product search sends keyword, never q", async () => {
  const { mcp, calls } = await setup({}, [(c) => (c.url.pathname === "/api/v1/productSearch.jhtm" ? json({ productList: [], count: 0 }) : undefined)]);
  await mcp.callTool({ name: "webjaguar_search_products", arguments: { keyword: "balloon" } });
  assert.equal(calls[0].url.searchParams.get("keyword"), "balloon");
  assert.equal(calls[0].url.searchParams.has("q"), false);
  assert.match(calls[0].headers.Authorization, /^Basic /);
});

test("customer passwords are masked", async () => {
  const { mcp } = await setup({}, [() => json({ customer: { username: "a@example.com", password: "fake-secret-22" } })]);
  const out = text(await mcp.callTool({ name: "webjaguar_get_customer", arguments: { username: "a@example.com" } }));
  assert.ok(!out.includes("fake-secret-22"));
});

test("401 explains the per-endpoint privilege and never shows the password", async () => {
  const { mcp } = await setup({}, [() => new Response("Invalid API Crendentials fake-password-for-tests", { status: 401 })]);
  const out = text(await mcp.callTool({ name: "webjaguar_get_order", arguments: { order_id: 5 } }));
  assert.match(out, /not permitted to call order/);
  assert.ok(!out.includes("fake-password-for-tests"));
});

test("update refuses blocked, unknown and risky fields", async () => {
  const { mcp, calls } = await setup({ WEBJAGUAR_ALLOW_WRITES: "true" });
  for (const changes of [{ protectedLevel: "1" }, { active: false }, { upc: "123" }]) {
    const res = await mcp.callTool({ name: "webjaguar_update_product", arguments: { sku: "A1", changes, dry_run: false } });
    assert.equal(res.isError, true, JSON.stringify(changes));
  }
  assert.equal(calls.length, 0);
});

test("update dry run reads but never writes", async () => {
  const { route } = productStore({ sku: "A1", name: "Old", price1: 2 });
  const { mcp, calls } = await setup({ WEBJAGUAR_ALLOW_WRITES: "true" }, [route]);
  const res = await mcp.callTool({ name: "webjaguar_update_product", arguments: { sku: "A1", changes: { name: "New" } } });
  assert.match(text(res), /"dry_run": true/);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
});

test("update archives first, sends only changed fields and flags fields the store ignored", async () => {
  const { route } = productStore({ sku: "A1", name: "Old", price1: 2, field5: "x" }, ["field5"]);
  const { mcp, calls, archiveDir } = await setup({ WEBJAGUAR_ALLOW_WRITES: "true" }, [route]);
  const res = await mcp.callTool({
    name: "webjaguar_update_product",
    arguments: { sku: "A1", changes: { name: "New", price1: 2, field5: "y" }, dry_run: false },
  });
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(post?.body, { sku: "A1", name: "New", field5: "y" });
  const files = readdirSync(archiveDir);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(archiveDir, files[0]), "utf8")).product.name, "Old");
  assert.match(text(res), /WARNING: .*field5/);
});

test("restore puts archived values back and refuses another store's archive or a path", async () => {
  const { product, route } = productStore({ sku: "A1", name: "Old", price1: 2 });
  const { mcp, archiveDir } = await setup({ WEBJAGUAR_ALLOW_WRITES: "true" }, [route]);
  await mcp.callTool({ name: "webjaguar_update_product", arguments: { sku: "A1", changes: { name: "New" }, dry_run: false } });
  assert.equal(product.name, "New");
  const [file] = readdirSync(archiveDir);
  const res = await mcp.callTool({ name: "webjaguar_restore_product", arguments: { archive_file: file, dry_run: false } });
  assert.equal(res.isError, undefined, text(res));
  assert.equal(product.name, "Old");

  writeFileSync(path.join(archiveDir, "other.json"), JSON.stringify({ sku: "A1", saved_at: "x", host: "elsewhere.test", environment: "x", reason: "x", product: { name: "Z" } }));
  assert.equal((await mcp.callTool({ name: "webjaguar_restore_product", arguments: { archive_file: "other.json", dry_run: false } })).isError, true);
  const traversal = await mcp.callTool({ name: "webjaguar_restore_product", arguments: { archive_file: "../../etc/passwd.json" } });
  assert.equal(traversal.isError, true);
});
