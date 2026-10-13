// Product field rules for updateProduct, and the archive used to undo changes.
// The field lists reflect what was observed to persist on a real store; stores differ,
// so WEBJAGUAR_EXTRA_WRITABLE_FIELDS can extend the list.

import { promises as fs } from "node:fs";
import path from "node:path";

import { InputError } from "./core/errors";
import { Json } from "./client";

const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

/** Fields observed to persist through updateProduct. */
export const WRITABLE_FIELDS = new Set([
  "name",
  "shortDesc",
  "longDesc",
  "productType",
  "weight",
  "packageL",
  "packageW",
  "packageH",
  "caseContent",
  "caseUnitTitle",
  "packing",
  ...range("price", 1, 10),
  "msrp",
  ...range("priceTable", 1, 10),
  "priceCasePackQty",
  "loginRequire",
  "negInventory",
  "showNegInventory",
  ...range("field", 1, 100),
]);

/** Writable, but other systems key off them; changing them needs explicit consent. */
export const RISKY_FIELDS = new Set(["masterSku", "upc"]);

/** Never sent: identity, server-managed, or observed to break or silently drop data. */
export const BLOCKED_FIELDS = new Set(["id", "sku", "lastModified", "protectedLevel", "productFieldsUnlimitedNameValue"]);

export const SUMMARY_FIELDS = [
  "id",
  "sku",
  "name",
  "active",
  "productType",
  "masterSku",
  "upc",
  "price1",
  "price2",
  "price3",
  "msrp",
  "inventory",
  "inventoryAFS",
  "qtyOnPO",
  "orderPendingQty",
  "purchasePendingQty",
  "weight",
  "packageL",
  "packageW",
  "packageH",
  "caseContent",
  "caseUnitTitle",
  "shortDesc",
  "kitParts",
  "lastModified",
];

export type Scalar = string | number | boolean;

export function checkChanges(changes: Record<string, Scalar>, extra: string[], allowRisky: boolean): void {
  const extraSet = new Set(extra);
  const problems: string[] = [];
  for (const field of Object.keys(changes)) {
    if (BLOCKED_FIELDS.has(field)) problems.push(`${field}: never sent by this server`);
    else if (RISKY_FIELDS.has(field) && !allowRisky) problems.push(`${field}: risky (other systems key off it); pass allow_risky_fields=true to change it`);
    else if (!WRITABLE_FIELDS.has(field) && !RISKY_FIELDS.has(field) && !extraSet.has(field)) {
      problems.push(`${field}: not in the writable list (the API answers success but ignores many fields)`);
    }
  }
  if (problems.length) throw new InputError(`Refused field(s):\n- ${problems.join("\n- ")}`);
}

export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a !== "boolean" && typeof b !== "boolean" && String(a).trim() !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
    // Weights and prices come back rounded.
    return Math.abs(na - nb) < 0.005;
  }
  return String(a) === String(b);
}

export function pick(source: Json, fields: string[]): Json {
  const out: Json = {};
  for (const f of fields) if (f in source) out[f] = source[f];
  return out;
}

export interface ArchiveRecord {
  sku: string;
  saved_at: string;
  host: string;
  environment: string;
  reason: string;
  product: Json;
}

export async function writeArchive(dir: string, record: ArchiveRecord): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const stamp = record.saved_at.replace(/[:.]/g, "-");
  const file = path.join(dir, `${record.sku.replace(/[^A-Za-z0-9_-]/g, "_")}_${stamp}.json`);
  await fs.writeFile(file, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
  return file;
}

/** Resolves an archive file name strictly inside the archive directory. */
export function archivePath(dir: string, name: string): string {
  const resolved = path.resolve(dir, path.basename(name));
  if (path.dirname(resolved) !== path.resolve(dir) || !resolved.endsWith(".json")) {
    throw new InputError("archive_file must be a .json file name from webjaguar_list_archives.");
  }
  return resolved;
}

export async function readArchive(dir: string, name: string): Promise<ArchiveRecord> {
  const file = archivePath(dir, name);
  const record = JSON.parse(await fs.readFile(file, "utf8")) as ArchiveRecord;
  if (!record?.sku || !record.product || typeof record.product !== "object") {
    throw new InputError(`${path.basename(file)} is not a product archive written by this server.`);
  }
  return record;
}

export async function listArchives(dir: string, sku?: string): Promise<Array<{ file: string; sku: string; saved_at: string }>> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const prefix = sku ? `${sku.replace(/[^A-Za-z0-9_-]/g, "_")}_` : "";
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".json") && n.startsWith(prefix)).sort().reverse().slice(0, 200)) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as ArchiveRecord;
      out.push({ file: name, sku: rec.sku, saved_at: rec.saved_at });
    } catch {
      // Skip unreadable files.
    }
  }
  return out;
}
