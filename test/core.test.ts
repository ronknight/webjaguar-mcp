import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../src/core/errors";
import { HttpClient } from "../src/core/http";
import { Redactor } from "../src/core/redact";
import { ok } from "../src/core/result";
import { fakeFetch, json } from "./helpers";

const noSleep = async () => undefined;

test("redactor masks registered secrets, credential fields and auth headers", () => {
  const r = new Redactor();
  r.add("s3cr3t-value-123");
  assert.equal(r.text("token s3cr3t-value-123 leaked"), "token *** leaked");
  assert.equal(r.text("Authorization: Basic dXNlcjpwYXNzd29yZA=="), "Authorization: Basic ***");
  assert.deepEqual(r.value({ password: "x1", nested: { api_key: "y2", name: "ok" } }), {
    password: "***",
    nested: { api_key: "***", name: "ok" },
  });
});

test("GET is retried on 503 and honours Retry-After", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const { fetch } = fakeFetch([
    () => {
      attempts += 1;
      return attempts < 3 ? json({ title: "busy" }, 503, { "retry-after": "2" }) : json({ fine: true });
    },
  ]);
  const http = new HttpClient({
    baseUrl: "https://api.test/v1",
    userAgent: "t",
    redactor: new Redactor(),
    fetchImpl: fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.deepEqual(await http.request({ path: "/x" }), { fine: true });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2000, 2000]);
});

test("POST is not retried on 500, so a write is never sent twice", async () => {
  const { fetch, calls } = fakeFetch([() => json({ title: "boom" }, 500)]);
  const http = new HttpClient({ baseUrl: "https://api.test", userAgent: "t", redactor: new Redactor(), fetchImpl: fetch, sleep: noSleep });
  await assert.rejects(http.request({ method: "POST", path: "/w", body: {} }), (err: unknown) => err instanceof ApiError && err.status === 500);
  assert.equal(calls.length, 1);
});

test("error messages never contain the secret", async () => {
  const redactor = new Redactor();
  redactor.add("topsecretkey-999");
  const { fetch } = fakeFetch([() => json({ detail: "bad key topsecretkey-999" }, 401)]);
  const http = new HttpClient({ baseUrl: "https://api.test", userAgent: "t", redactor, fetchImpl: fetch, sleep: noSleep });
  await assert.rejects(http.request({ path: "/x" }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.ok(!err.message.includes("topsecretkey-999"));
    assert.match(err.message, /HTTP 401/);
    return true;
  });
});

test("query arrays repeat and empty values are dropped", () => {
  const http = new HttpClient({ baseUrl: "https://api.test/base/", userAgent: "t", redactor: new Redactor() });
  const url = new URL(http.url("/items", { a: ["1", "2"], b: undefined, c: "", d: 0 }));
  assert.equal(url.pathname, "/base/items");
  assert.deepEqual(url.searchParams.getAll("a"), ["1", "2"]);
  assert.equal(url.searchParams.has("b"), false);
  assert.equal(url.searchParams.has("c"), false);
  assert.equal(url.searchParams.get("d"), "0");
});

test("results are capped", () => {
  const res = ok("x".repeat(100), { maxChars: 10 });
  assert.match(res.content[0].text, /truncated 90 characters/);
});
