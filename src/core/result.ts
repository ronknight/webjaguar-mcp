// Builds MCP tool results. Output is capped so one call cannot flood the model's context.

import { ApiError, ConfigError, InputError, WriteBlockedError } from "./errors";
import { Redactor } from "./redact";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export const DEFAULT_MAX_CHARS = 60_000;

export function ok(data: unknown, options: { summary?: string; maxChars?: number } = {}): ToolResult {
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text.length > max) {
    const dropped = text.length - max;
    text = `${text.slice(0, max)}\n... [truncated ${dropped} characters; narrow the request with filters, fields, count or offset]`;
  }
  return { content: [{ type: "text", text: options.summary ? `${options.summary}\n\n${text}` : text }] };
}

export function fail(err: unknown, redactor: Redactor): ToolResult {
  let message: string;
  if (err instanceof ApiError || err instanceof InputError || err instanceof ConfigError || err instanceof WriteBlockedError) {
    message = `${err.name}: ${err.message}`;
  } else if (err instanceof Error) {
    message = `Unexpected error: ${err.message}`;
  } else {
    message = `Unexpected error: ${String(err)}`;
  }
  return { isError: true, content: [{ type: "text", text: redactor.text(message) }] };
}

/** Result for a write tool called with dry_run=true: shows exactly what would be sent. */
export function preview(action: string, request: unknown, notes: string[] = []): ToolResult {
  return ok({
    dry_run: true,
    action,
    request,
    notes,
    next_step: "Nothing was changed. Review the request above, then call the same tool again with dry_run=false to apply it.",
  });
}
