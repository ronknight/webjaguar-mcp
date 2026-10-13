// Entry point: stdio MCP server. Used by the VS Code extension and by any other MCP client.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { USER_AGENT, WebJaguarClient } from "./client";
import { loadConfig } from "./config";
import { configureLog, log } from "./core/log";
import { Redactor } from "./core/redact";
import { registerTools } from "./tools";

const VERSION = USER_AGENT.split("/")[1];

function instructions(target: string, writes: boolean): string {
  return `Tools for one WebJaguar store: ${target}.
- Reads are safe. Prefer the dedicated tools; use webjaguar_api_get only when none fits.
- The API is quirky: product search uses keyword (not q), customer lookup uses the login username, and "not found" can arrive as HTTP 400. The tools handle this.
- Customer and order results contain personal data; quote only what the user needs.
${
  writes
    ? "- Product writes are enabled. They default to dry_run=true: show the preview to the user and get approval before calling again with dry_run=false. Every write archives the product first and verifies the result; report any field listed in not_applied."
    : "- This server is read-only."
}`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv.includes("--help")) {
    process.stdout.write(
      "webjaguar-mcp: stdio MCP server for the WebJaguar REST API.\n" +
        "Environment: WEBJAGUAR_BASE_URL, WEBJAGUAR_USERNAME, WEBJAGUAR_PASSWORD (required), WEBJAGUAR_ENVIRONMENT_LABEL,\n" +
        "WEBJAGUAR_ALLOW_WRITES, WEBJAGUAR_ARCHIVE_DIR, WEBJAGUAR_EXTRA_WRITABLE_FIELDS, WEBJAGUAR_API_PATH,\n" +
        "WEBJAGUAR_TIMEOUT_SECONDS, WEBJAGUAR_MAX_CONCURRENCY, WEBJAGUAR_LOG_LEVEL.\n",
    );
    return;
  }

  const redactor = new Redactor();
  const config = loadConfig();
  configureLog("webjaguar-mcp", config.logLevel);
  const client = new WebJaguarClient(config, redactor);
  const target = `${config.environmentLabel} (${client.host})`;

  const server = new McpServer({ name: "webjaguar-mcp", version: VERSION }, { instructions: instructions(target, config.allowWrites) });
  registerTools({ server, redactor, allowWrites: config.allowWrites }, client);

  await server.connect(new StdioServerTransport());
  log.info(`ready (store ${target}; product writes ${config.allowWrites ? `ON, archive ${config.archiveDir}` : "off"})`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`[webjaguar-mcp] fatal: ${new Redactor().text(message)}\n`);
    process.exit(1);
  });
}
