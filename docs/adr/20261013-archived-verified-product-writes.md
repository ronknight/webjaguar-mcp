# Archived, verified, allow-listed product writes

- Status: accepted
- Date: 2026-10-13

## Context

The WebJaguar REST API answers "Product updated" even when it ignores a field, and some fields are dangerous (changing `protectedLevel` made products unreachable on a real store). There is no delete endpoint and no history, so a bad bulk change is hard to undo. The extension is published on the VS Code Marketplace and must install without extra runtimes.

## Decision

1. Read tools by default. The only write tools update and restore product fields and are registered only when writes are enabled.
2. Fields are an allow-list of those observed to persist; risky identifiers need an explicit flag; `protectedLevel` is never sent. Stores can extend the list by configuration.
3. Each write previews by default, archives the full product to local JSON, sends only changed fields, reads the product back and reports fields that did not change. Restores archive first and refuse snapshots from another host.
4. TypeScript bundled with esbuild, run on VS Code's own Node.js; credentials in Secret Storage bound to profile settings; profile settings user-scoped only.

## Consequences

- Every write costs two extra reads, which is acceptable for single-product edits and makes silent no-ops visible.
- Archives accumulate on disk and contain product data; users can delete them.
- Order, customer and inventory changes need a different tool.
