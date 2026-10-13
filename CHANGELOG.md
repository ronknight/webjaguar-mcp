# Changelog

## [Unreleased]

#### 2026-10-13 - Extension icon

- Added an extension icon (`images/icon.png`, source `images/icon.svg`): a glowing shopping bag in the publisher's node-graph style, plus a dark gallery banner. Original artwork, no WebJaguar branding.

## [0.1.0] - 2026-10-13

#### 2026-10-13 - First release

- Stdio MCP server for the WebJaguar REST API (`src/server.ts`, `src/tools.ts`, `src/client.ts`): products, product search, inventory, category tree, orders, customers, sales reps and a read-only raw GET. Handles the known quirks (keyword search, `user` lookup, not-found as HTTP 400, per-endpoint 401s, ignored order date filters).
- Product writes behind `WEBJAGUAR_ALLOW_WRITES` (`src/products.ts`): allow-listed fields only, dry run by default, archive before write, changed fields only, read-back verification, restore from archive.
- VS Code extension (`src/extension.ts`, `src/vscode/provider.ts`): one server per profile, credentials in Secret Storage bound to profile settings, user/machine-scoped settings only, runs on VS Code's bundled Node.js.
- Offline test suite with a fake fetch; `scripts/nda-check.mjs` pre-publish guard.
