# Repository Working Agreement

Instructions for every AI coding assistant working in this repository. `CLAUDE.md` imports this file; edit only this one.

## Hard rules

- **Never call a real WebJaguar store from tests or while developing** — not a live store, not a demo or staging store. Tests use the fake fetch in `test/helpers.ts`, which refuses any host that does not end in `.test`. Do not add live, demo or "smoke" tests.
- **Writes stay narrow.** The only write tools update and restore product fields. New write tools must default to `dry_run: true`, archive before writing, verify by reading back, and be registered only when `WEBJAGUAR_ALLOW_WRITES` is true. Do not add order, customer, inventory, pricing or promotion writes, or `createOnNotFound`.
- **Writable fields are an allow-list** (`src/products.ts`). Add a field only after it was confirmed to persist; never send `protectedLevel`.
- **Public repository.** Never commit real store data: no hostnames, credentials, SKUs, product names, order or customer details, category ids, or company names — including in tests, examples and docs. Use invented values (`shop.test`, `A1`, `example.com`). `npm run nda-check` must pass before any publish.
- **Secrets** never appear in logs, errors or tool results; route messages through `Redactor`.
- **Logs go to stderr.** stdout carries the MCP protocol.

## Layout

- `src/core/` shared, API-agnostic pieces (HTTP, redaction, results, tool registration). Kept identical across the sibling MCP server repos; change it in all of them together.
- `src/config.ts`, `src/client.ts`, `src/products.ts`, `src/tools.ts`, `src/server.ts` the WebJaguar server.
- `src/extension.ts`, `src/vscode/provider.ts` the VS Code extension.
- `test/` offline tests (`npm test`).

## Definition of Done

1. `npm test` and `npm run typecheck` pass.
2. Add a dated entry under `## [Unreleased]` in `CHANGELOG.md` (`#### YYYY-MM-DD - <summary>`).
3. Update `README.md` (tool tables, settings, quirks) and `docs/` when behavior changes.
4. Update `openspec/diagram/*.md` when the flow changes.
5. Add an ADR in `docs/adr/YYYYMMDD-<kebab-title>.md` for architectural decisions.
