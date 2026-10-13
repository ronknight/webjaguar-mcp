# Security

## Reporting a vulnerability

Please report security problems privately through the repository's GitHub Security Advisories ("Report a vulnerability"), not in public issues. Include steps to reproduce. Never include real credentials, store addresses or customer data.

## Design

- **Least privilege.** Read tools only by default. Product writes are not registered unless enabled, accept only fields known to persist, and default to a dry run. Orders, customers, inventory, pricing and promotions have no write tools.
- **Reversible writes.** Each update archives the full product first, sends only changed fields, reads the product back and reports fields the store ignored. Restores archive the current state first and refuse snapshots from another store.
- **Secrets.** In VS Code, credentials live in Secret Storage, bound to the profile's settings; if the URL changes you are asked again. Credentials reach the server only through its environment and are masked in logs, errors and results, as are password fields in customer and sales-rep records.
- **Workspace isolation.** Profile and runtime settings are read from user/machine settings only, so a workspace cannot redirect credentials or replace the executable.
- **Input handling.** SKUs, endpoint names and field names are validated; archive names cannot leave the archive folder.
- **Bounded output.** Results are capped in size; requests have timeouts, bounded retries (reads and HTTP 429 only) and a concurrency cap.
- **Supply chain.** Two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`), bundled at build time; licenses ship in `THIRD_PARTY_NOTICES.txt`.
