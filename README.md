# MCP Server for WebJaguar

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants (GitHub Copilot agent mode in VS Code, Claude Code, Claude Desktop and other MCP clients) read a WebJaguar store through its REST API, and optionally update product fields safely.

Read-only by default. When product writes are on, every change is previewed first, the full product is archived before writing, only changed fields are sent, and the product is read back to prove what applied. Any change can be undone from the archive.

> Not affiliated with or endorsed by WebJaguar. Behavior notes below were observed on real stores; stores and API users differ, so treat them as guidance.

## Tools

| Tool | What it does |
|---|---|
| `webjaguar_get_product` | One product by SKU or id (summary, chosen fields, or all ~380 fields) |
| `webjaguar_search_products` | Keyword search, or page through all products |
| `webjaguar_get_inventory` | Stock figures for up to 50 SKUs |
| `webjaguar_get_category_tree` | Category tree, trimmed to a depth |
| `webjaguar_search_orders`, `webjaguar_get_order` | Orders by number, customer email or status (date filters applied locally) |
| `webjaguar_get_customer`, `webjaguar_search_customers` | Customers (password fields always masked) |
| `webjaguar_search_sales_reps` | Sales reps |
| `webjaguar_api_get` | Read-only GET to any other endpoint |

Only offered when product writes are enabled:

| Tool | What it does |
|---|---|
| `webjaguar_update_product` | Changes product fields: preview, archive, send changed fields, read back, report anything the store ignored |
| `webjaguar_list_archives` | Lists saved snapshots |
| `webjaguar_restore_product` | Puts a product back to a snapshot (archives the current state first; refuses snapshots from another store) |

Writes default to `dry_run: true`. Accepted fields are those observed to persist: `name`, `shortDesc`, `longDesc`, `productType`, `weight`, `packageL/W/H`, `caseContent`, `caseUnitTitle`, `packing`, `price1`-`price10`, `msrp`, `priceTable1`-`priceTable10`, `priceCasePackQty`, `loginRequire`, `negInventory`, `showNegInventory` and `field1`-`field100`. `masterSku` and `upc` need `allow_risky_fields`. `protectedLevel` is never sent (changing it can make a product unreachable). Other fields are refused because the API answers success but ignores them; add ones you have verified on your store with `WEBJAGUAR_EXTRA_WRITABLE_FIELDS`.

Orders, customers, inventory, prices by customer and promotions are read-only by design.

## API quirks handled for you

- Product search uses `keyword`; `q` silently returns nothing.
- Customer lookup uses the login `user`; id lookups are unreliable.
- "Not found" can arrive as HTTP 400, or as HTTP 200 with a message; both become `found: false`.
- A 401 can mean wrong credentials **or** that the API user lacks permission for that endpoint (WebJaguar grants API access per endpoint).
- Order searches ignore date filters, so dates are filtered after fetching.

## Use in VS Code

1. Install the extension.
2. Run **WebJaguar MCP: Add or Edit Profile**. Enter the store URL, an optional label (for example `test` or `live`), choose whether product writes are allowed, then the API username and password.
3. In Copilot Chat agent mode the server appears as **WebJaguar** (or **WebJaguar (profile)**).

Add one profile per store or environment, for example a writable `test` profile and a read-only `live` profile. Credentials live in VS Code Secret Storage and are tied to the profile's URL: change the URL and you are asked for them again. The server runs on VS Code's own Node.js runtime.

| Setting | Scope | Purpose |
|---|---|---|
| `webjaguarMcp.profiles` | user | `name`, `baseUrl`, `environmentLabel`, `extraWritableFields`, `allowWrites` |
| `webjaguarMcp.nodePath` | machine | Use a different Node.js executable (normally leave empty) |

## Use with other MCP clients

```json
{
  "mcpServers": {
    "webjaguar": {
      "command": "node",
      "args": ["/path/to/webjaguar-mcp/dist/server.js"],
      "env": {
        "WEBJAGUAR_BASE_URL": "https://www.example.com",
        "WEBJAGUAR_USERNAME": "${WEBJAGUAR_USERNAME}",
        "WEBJAGUAR_PASSWORD": "${WEBJAGUAR_PASSWORD}",
        "WEBJAGUAR_ENVIRONMENT_LABEL": "live",
        "WEBJAGUAR_ALLOW_WRITES": "false"
      }
    }
  }
}
```

| Variable | Default | Purpose |
|---|---|---|
| `WEBJAGUAR_BASE_URL` | (required) | Store root URL |
| `WEBJAGUAR_USERNAME`, `WEBJAGUAR_PASSWORD` | (required) | API user (HTTP Basic) |
| `WEBJAGUAR_ENVIRONMENT_LABEL` | host name | Shown in write previews |
| `WEBJAGUAR_ALLOW_WRITES` | `false` | Offer the product update tools |
| `WEBJAGUAR_ARCHIVE_DIR` | `~/.webjaguar-mcp/archive` | Where snapshots are saved |
| `WEBJAGUAR_EXTRA_WRITABLE_FIELDS` | | Comma-separated extra product fields |
| `WEBJAGUAR_API_PATH` | `api/v1` | API path prefix |
| `WEBJAGUAR_TIMEOUT_SECONDS` | `60` | Per-request timeout |
| `WEBJAGUAR_MAX_CONCURRENCY` | `2` | Parallel requests |
| `WEBJAGUAR_LOG_LEVEL` | `info` | Logs go to stderr |

If the store sits behind Cloudflare bot protection, API calls from a new machine can be challenged; the error says so. Ask the store or WebJaguar to allow API traffic.

## Privacy and data handling

- The server talks only to the store URL you configure. No telemetry.
- Customer and order results contain personal data and go to the AI assistant you use.
- Passwords and `Authorization` headers are masked in logs, errors and results. Archives are plain JSON product snapshots on your machine.

## Development

```bash
npm ci
npm test          # offline tests; a fake fetch blocks any real network call
npm run build
npm run package   # runs the NDA check, type check and production build first
```

## License

MIT
