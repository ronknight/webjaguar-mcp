// Registers tools with consistent annotations, error handling and the read-only gate.
// Write tools are not registered at all unless writes are enabled, so a read-only
// server never even offers them to the model.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { log } from "./log";
import { Redactor } from "./redact";
import { fail, ToolResult } from "./result";

export type ToolKind = "read" | "write";

export interface ToolContext {
  server: McpServer;
  redactor: Redactor;
  allowWrites: boolean;
}

export interface ToolDefinition<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  /** Write tools only: true when the change cannot be undone through this server. */
  destructive?: boolean;
  /** Extra switch a write tool needs besides allowWrites (e.g. sending test emails). */
  enabled?: boolean;
  input: Shape;
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<ToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(ctx: ToolContext, def: ToolDefinition<Shape>): boolean {
  if (def.kind === "write" && (!ctx.allowWrites || def.enabled === false)) {
    log.debug(`write tool ${def.name} not registered (writes disabled)`);
    return false;
  }
  const register = ctx.server.registerTool.bind(ctx.server) as unknown as (
    name: string,
    config: Record<string, unknown>,
    cb: (args: Record<string, unknown>) => Promise<ToolResult>,
  ) => void;
  register(
    def.name,
    {
      title: def.title,
      description: def.kind === "write" ? `${def.description}\n\nWrite tool: defaults to dry_run=true, which only previews.` : def.description,
      inputSchema: def.input,
      annotations: {
        title: def.title,
        readOnlyHint: def.kind === "read",
        destructiveHint: def.kind === "write" ? Boolean(def.destructive) : false,
        idempotentHint: def.kind === "read",
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        return await def.handler(args as z.objectOutputType<Shape, z.ZodTypeAny>);
      } catch (err) {
        log.warn(`${def.name} failed: ${ctx.redactor.text(err instanceof Error ? err.message : String(err))}`);
        return fail(err, ctx.redactor);
      }
    },
  );
  return true;
}

/** Shared input field for write tools. */
export const dryRun = z
  .boolean()
  .default(true)
  .describe("Preview only when true (the default). Set to false to apply the change after reviewing the preview.");
