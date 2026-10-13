// MCP tools for the WebJaguar REST API.
//
// Policy: reads are always available. The only writes are product updates and restores,
// registered only with WEBJAGUAR_ALLOW_WRITES=true. Each write previews first, archives the
// full product before changing it, sends only changed fields and reads the product back to
// prove what applied. Orders, customers, inventory, pricing and promotions are read-only here.

import path from "node:path";

import { z } from "zod";

import { InputError } from "./core/errors";
import { ok, preview } from "./core/result";
import { defineTool, dryRun, ToolContext } from "./core/tool";
import { Json, WebJaguarClient } from "./client";
import {
  checkChanges,
  listArchives,
  pick,
  readArchive,
  RISKY_FIELDS,
  same,
  Scalar,
  SUMMARY_FIELDS,
  WRITABLE_FIELDS,
  writeArchive,
} from "./products";

const sku = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._\-/ ]+$/, "Unexpected characters in SKU.");
const page = z.number().int().min(0).max(100_000).default(1).describe("Page number, passed to the store as-is.");
const pageSize = (max: number, def: number) => z.number().int().min(1).max(max).default(def).describe(`Records per page (1-${max}).`);
const fieldList = z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).max(100).optional();

const ORDER_SUMMARY = [
  "orderId",
  "orderNum",
  "dateOrdered",
  "status",
  "subStatus",
  "subTotal",
  "grandTotal",
  "shippingCost",
  "paymentMethod",
  "shippingMethod",
  "userId",
  "purchaseOrder",
];

export function registerTools(ctx: ToolContext, wj: WebJaguarClient): void {
  const cfg = wj.config;
  const target = `${cfg.environmentLabel} (${wj.host})`;

  const getProduct = async (by: { sku?: string; id?: number }, fresh = false): Promise<Json | null> => {
    const query = by.sku ? { sku: by.sku } : { id: by.id };
    return (await wj.find("product", fresh ? { ...query, nocache: Date.now() } : query, "product")) as Json | null;
  };

  defineTool(ctx, {
    name: "webjaguar_get_product",
    title: "Get product",
    description:
      "Returns one product by SKU or numeric id. By default a summary of key fields; pass fields for specific ones or full=true for everything (about 380 fields).",
    kind: "read",
    input: { sku: sku.optional(), id: z.number().int().positive().optional(), fields: fieldList, full: z.boolean().default(false) },
    handler: async (a) => {
      if (!a.sku === !a.id) throw new InputError("Give exactly one of sku or id.");
      const product = await getProduct({ sku: a.sku, id: a.id });
      if (!product) return ok({ found: false, sku: a.sku, id: a.id });
      return ok({ found: true, product: a.full ? product : pick(product, a.fields ?? SUMMARY_FIELDS) });
    },
  });

  defineTool(ctx, {
    name: "webjaguar_search_products",
    title: "Search products",
    description:
      "Searches the catalog by keyword (the parameter is keyword, not q). Set all_products=true to page through everything. category_id and modified_since use filters from the vendor documentation and may not be honoured by every store.",
    kind: "read",
    input: {
      keyword: z.string().trim().min(1).max(200).optional(),
      all_products: z.boolean().default(false),
      category_id: z.number().int().positive().optional(),
      modified_since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").optional(),
      page,
      page_size: pageSize(100, 24),
    },
    handler: async (a) => {
      if (!a.keyword && !a.all_products && !a.category_id && !a.modified_since) {
        throw new InputError("Give a keyword, a category_id, modified_since, or all_products=true.");
      }
      let modified: string | undefined;
      if (a.modified_since) {
        const [y, m, d] = a.modified_since.split("-").map(Number);
        modified = `${m}/${d}/${y}`;
      }
      const data = await wj.get("productSearch", {
        keyword: a.keyword,
        noKeywords: a.all_products && !a.keyword ? "true" : undefined,
        searchIndexedCatId: a.category_id,
        last_modified: modified,
        page: a.page,
        pageSize: a.page_size,
      });
      const list = Array.isArray(data.productList) ? (data.productList as Json[]) : [];
      return ok({
        count: data.count ?? null,
        page: data.page ?? a.page,
        page_size: data.pageSize ?? a.page_size,
        returned: list.length,
        products: list.map((p) => pick(p, ["id", "sku", "name", "active", "price1", "inventory", "productType", "lastModified"])),
        note: list.length === 0 && a.keyword ? "No matches. Keyword search may not match bare SKUs; try webjaguar_get_product with sku." : undefined,
      });
    },
  });

  defineTool(ctx, {
    name: "webjaguar_get_inventory",
    title: "Get inventory for SKUs",
    description: "Returns stock figures for up to 50 SKUs (one product lookup per SKU). Store figures can lag the admin export.",
    kind: "read",
    input: { skus: z.array(sku).min(1).max(50) },
    handler: async (a) => {
      const rows = await Promise.all(
        [...new Set(a.skus)].map(async (s) => {
          const p = await getProduct({ sku: s });
          return p
            ? { sku: s, found: true, ...pick(p, ["active", "inventory", "inventoryAFS", "qtyOnPO", "orderPendingQty", "purchasePendingQty"]) }
            : { sku: s, found: false };
        }),
      );
      return ok({ items: rows });
    },
  });

  defineTool(ctx, {
    name: "webjaguar_get_category_tree",
    title: "Get category tree",
    description: "Returns the category tree from the root, or below one category, trimmed to id, name, url and children.",
    kind: "read",
    input: { category_id: z.number().int().positive().optional(), max_depth: z.number().int().min(1).max(6).default(2) },
    handler: async (a) => {
      const data = await wj.get("categoryTree", { cid: a.category_id });
      const nodes = Array.isArray(data.category) ? (data.category as Json[]) : data.category ? [data.category as Json] : [];
      let total = 0;
      const trim = (node: Json, depth: number): Json => {
        total += 1;
        const children = Array.isArray(node.subCategories) ? (node.subCategories as Json[]) : [];
        return {
          id: node.id,
          name: node.name,
          url: node.url ?? undefined,
          ...(children.length
            ? depth < a.max_depth
              ? { children: children.map((c) => trim(c, depth + 1)) }
              : { children_not_shown: children.length }
            : {}),
        };
      };
      const tree = nodes.map((n) => trim(n, 1));
      return ok({ nodes_shown: total, tree });
    },
  });

  defineTool(ctx, {
    name: "webjaguar_search_orders",
    title: "Search orders",
    description:
      "Searches orders by order number, customer email (the customer's login) or status. Date filters are applied here, after fetching, because the store ignores them. Without filters the store returns its oldest orders first.",
    kind: "read",
    input: {
      order_number: z.string().trim().max(40).optional(),
      email: z.string().trim().email().optional(),
      status: z.string().trim().max(10).optional().describe("Store status code, e.g. p (pending), s (shipped), x (cancelled)."),
      placed_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      placed_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      page,
      size: pageSize(100, 25),
      full: z.boolean().default(false).describe("Return full order records instead of a summary."),
    },
    handler: async (a) => {
      let orders: Json[] = [];
      try {
        const data = await wj.get("orderSearch", { orderNum: a.order_number, email: a.email, status: a.status, page: a.page, size: a.size });
        orders = Array.isArray(data.apiOrderList) ? (data.apiOrderList as Json[]) : [];
      } catch (err) {
        if (!(err instanceof Error && /no orders? found/i.test(err.message))) throw err;
      }
      const after = a.placed_after ? Date.parse(`${a.placed_after}T00:00:00`) : undefined;
      const before = a.placed_before ? Date.parse(`${a.placed_before}T23:59:59`) : undefined;
      let undated = 0;
      const kept = orders.filter((o) => {
        if (after === undefined && before === undefined) return true;
        const t = Date.parse(String(o.dateOrdered ?? ""));
        if (Number.isNaN(t)) {
          undated += 1;
          return true;
        }
        return (after === undefined || t >= after) && (before === undefined || t <= before);
      });
      return ok({
        returned: kept.length,
        fetched: orders.length,
        undated_kept: undated || undefined,
        orders: a.full
          ? kept
          : kept.map((o) => ({ ...pick(o, ORDER_SUMMARY), line_items: Array.isArray(o.lineItems) ? o.lineItems.length : undefined })),
      });
    },
  });

  defineTool(ctx, {
    name: "webjaguar_get_order",
    title: "Get order",
    description: "Returns one order by order id or order number.",
    kind: "read",
    input: { order_id: z.number().int().positive().optional(), order_number: z.string().trim().max(40).optional() },
    handler: async (a) => {
      if (!a.order_id === !a.order_number) throw new InputError("Give exactly one of order_id or order_number.");
      const order = await wj.find("order", a.order_id ? { orderId: a.order_id } : { orderNum: a.order_number }, "order");
      return ok(order ? { found: true, order } : { found: false });
    },
  });

  defineTool(ctx, {
    name: "webjaguar_get_customer",
    title: "Get customer",
    description: "Returns one customer by login username (usually their email). Password fields are always masked.",
    kind: "read",
    input: { username: z.string().trim().min(1).max(320) },
    handler: async (a) => {
      const customer = await wj.find("customer", { user: a.username }, "customer");
      return ok(customer ? { found: true, customer: ctx.redactor.value(customer) } : { found: false });
    },
  });

  defineTool(ctx, {
    name: "webjaguar_search_customers",
    title: "Search customers",
    description:
      "Searches customers. email is the filter known to work reliably; the others come from the vendor documentation and may be ignored by some stores, so check the results.",
    kind: "read",
    input: {
      email: z.string().trim().max(320).optional(),
      first_name: z.string().trim().max(100).optional(),
      last_name: z.string().trim().max(100).optional(),
      account_number: z.string().trim().max(60).optional(),
      company_name: z.string().trim().max(200).optional(),
      zipcode: z.string().trim().max(20).optional(),
      phone: z.string().trim().max(40).optional(),
      page,
      size: pageSize(100, 25),
    },
    handler: async (a) => {
      const filters = {
        email: a.email,
        firstName: a.first_name,
        lastName: a.last_name,
        accountNumber: a.account_number,
        companyName: a.company_name,
        zipcode: a.zipcode,
        phone: a.phone,
      };
      if (!Object.values(filters).some(Boolean)) throw new InputError("Give at least one filter.");
      const data = await wj.get("customerSearch", { ...filters, page: a.page, size: a.size });
      const list = Array.isArray(data.customerList) ? (data.customerList as Json[]) : [];
      return ok({ returned: list.length, message: list.length ? undefined : data.message, customers: ctx.redactor.value(list) });
    },
  });

  defineTool(ctx, {
    name: "webjaguar_search_sales_reps",
    title: "Search sales reps",
    description: "Lists or finds sales reps by id, account number or email. Pair with a customer's salesRepId.",
    kind: "read",
    input: {
      id: z.number().int().positive().optional(),
      account_number: z.string().trim().max(60).optional(),
      email: z.string().trim().max(320).optional(),
      page,
      page_size: pageSize(100, 25),
    },
    handler: async (a) => {
      const reps = await wj.find(
        "salesRepSearch",
        { id: a.id, accountNumber: a.account_number, email: a.email, page: a.page, pageSize: a.page_size },
        "salesRepList",
      );
      return ok({ sales_reps: ctx.redactor.value(reps ?? []) });
    },
  });

  defineTool(ctx, {
    name: "webjaguar_api_get",
    title: "Raw GET request",
    description:
      "Read-only escape hatch: sends a GET to <api path>/<endpoint>.jhtm with the given query, e.g. endpoint subOrderSearch or crmContact. Use the dedicated tools when one fits.",
    kind: "read",
    input: {
      endpoint: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,60}$/, "Endpoint name only, e.g. productSearch (no path, no .jhtm)."),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    },
    handler: async (a) => ok(ctx.redactor.value(await wj.get(a.endpoint, a.query))),
  });

  // ---- Writes: product updates only ---------------------------------------------------

  const applyAndVerify = async (skuValue: string, changes: Record<string, Scalar>) => {
    const response = await wj.post("updateProduct", { sku: skuValue, ...changes });
    const after = await getProduct({ sku: skuValue }, true);
    const verification = Object.entries(changes).map(([field, expected]) => ({
      field,
      expected,
      actual: after?.[field],
      applied: Boolean(after) && same(after?.[field], expected),
    }));
    return { message: response.message ?? null, verification, not_applied: verification.filter((v) => !v.applied).map((v) => v.field) };
  };

  defineTool(ctx, {
    name: "webjaguar_update_product",
    title: "Update product fields",
    description: `Changes product fields by SKU. Only fields known to persist are accepted (copy, dimensions, prices 1-10, price tables, field1-100 and a few flags); others are refused because the API reports success but ignores them. Before writing, the full product is archived so webjaguar_restore_product can undo the change. After writing, the product is read back and each field is checked. Target store: ${target}.`,
    kind: "write",
    input: {
      sku,
      changes: z
        .record(z.union([z.string().max(100_000), z.number(), z.boolean()]))
        .refine((c) => Object.keys(c).length > 0 && Object.keys(c).length <= 50, "Give 1-50 fields.")
        .describe('Field name to new value, e.g. {"name": "New name", "price1": 4.99}. Null is not allowed; omit a field to leave it unchanged.'),
      allow_risky_fields: z.boolean().default(false).describe(`Also allow ${[...RISKY_FIELDS].join(" and ")}, which other systems key off.`),
      dry_run: dryRun,
    },
    handler: async (a) => {
      checkChanges(a.changes, cfg.extraWritableFields, a.allow_risky_fields);
      const current = await getProduct({ sku: a.sku }, true);
      if (!current) throw new InputError(`No product with SKU ${a.sku} on ${target}.`);
      const diff = Object.entries(a.changes).map(([field, to]) => ({ field, from: current[field] ?? null, to, changes: !same(current[field], to) }));
      const toSend = Object.fromEntries(diff.filter((d) => d.changes).map((d) => [d.field, d.to])) as Record<string, Scalar>;
      if (!Object.keys(toSend).length) return ok({ sku: a.sku, message: "Every field already has the requested value. Nothing to do." });
      if (a.dry_run) {
        return preview(`update product ${a.sku} on ${target}`, { endpoint: "POST updateProduct", body: { sku: a.sku, ...toSend }, diff }, [
          `The full product will be archived to ${cfg.archiveDir} first.`,
          "Only the fields that differ are sent. The product is read back afterwards to confirm each one.",
        ]);
      }
      const archive = await writeArchive(cfg.archiveDir, {
        sku: a.sku,
        saved_at: new Date().toISOString(),
        host: wj.host,
        environment: cfg.environmentLabel,
        reason: `before update of ${Object.keys(toSend).join(", ")}`,
        product: current,
      });
      const result = await applyAndVerify(a.sku, toSend);
      return ok(
        { sku: a.sku, target, archive_file: path.basename(archive), ...result },
        {
          summary: result.not_applied.length
            ? `WARNING: the store answered, but ${result.not_applied.join(", ")} did not change. Restore with webjaguar_restore_product if needed.`
            : "All fields applied and verified.",
        },
      );
    },
  });

  defineTool(ctx, {
    name: "webjaguar_list_archives",
    title: "List product archives",
    description: "Lists product snapshots this server saved before updates (newest first), for use with webjaguar_restore_product.",
    kind: "write",
    input: { sku: sku.optional() },
    handler: async (a) => ok({ archive_dir: cfg.archiveDir, archives: await listArchives(cfg.archiveDir, a.sku) }),
  });

  defineTool(ctx, {
    name: "webjaguar_restore_product",
    title: "Restore product from archive",
    description:
      "Puts a product's writable fields back to an archived snapshot. Only fields that differ are sent, the current state is archived first (so the restore can itself be undone), and the result is verified. Refuses archives taken from a different store.",
    kind: "write",
    input: { archive_file: z.string().min(6).max(200), dry_run: dryRun },
    handler: async (a) => {
      const record = await readArchive(cfg.archiveDir, a.archive_file);
      if (record.host !== wj.host) {
        throw new InputError(
          `That archive was taken on ${record.host}, but this server points at ${wj.host}. Restore it from a server configured for ${record.host}.`,
        );
      }
      const current = await getProduct({ sku: record.sku }, true);
      if (!current) throw new InputError(`No product with SKU ${record.sku} on ${target}.`);
      const allowed = new Set([...WRITABLE_FIELDS, ...cfg.extraWritableFields]);
      const toSend: Record<string, Scalar> = {};
      for (const [field, value] of Object.entries(record.product)) {
        if (!allowed.has(field)) continue;
        if (!(typeof value === "string" || typeof value === "number" || typeof value === "boolean")) continue;
        if (!same(current[field], value)) toSend[field] = value;
      }
      if (!Object.keys(toSend).length) return ok({ sku: record.sku, message: "The product already matches the archive for every writable field." });
      const diff = Object.entries(toSend).map(([field, to]) => ({ field, from: current[field] ?? null, to }));
      if (a.dry_run) {
        return preview(`restore product ${record.sku} on ${target} to ${record.saved_at}`, { endpoint: "POST updateProduct", diff }, [
          "The current state is archived first.",
        ]);
      }
      const archive = await writeArchive(cfg.archiveDir, {
        sku: record.sku,
        saved_at: new Date().toISOString(),
        host: wj.host,
        environment: cfg.environmentLabel,
        reason: `before restore from ${path.basename(a.archive_file)}`,
        product: current,
      });
      const result = await applyAndVerify(record.sku, toSend);
      return ok({ sku: record.sku, target, restored_from: path.basename(a.archive_file), pre_restore_archive: path.basename(archive), ...result });
    },
  });
}
