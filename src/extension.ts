// VS Code entry point: registers one WebJaguar MCP server per configured profile
// (for example one for a test store and one for the live store).

import * as vscode from "vscode";

import { activateProvider } from "./vscode/provider";

export function activate(context: vscode.ExtensionContext): void {
  activateProvider(context, {
    providerId: "webjaguarMcp.servers",
    section: "webjaguarMcp",
    displayName: "WebJaguar",
    serverScript: "dist/server.js",
    fields: [
      {
        id: "baseUrl",
        env: "WEBJAGUAR_BASE_URL",
        label: "Store URL",
        placeholder: "https://www.example.com",
        required: true,
        validate: (v) => (/^https:\/\/[^/\s]+\/?$/.test(v) ? undefined : "Use the store root, e.g. https://www.example.com"),
      },
      {
        id: "environmentLabel",
        env: "WEBJAGUAR_ENVIRONMENT_LABEL",
        label: "Environment label (optional)",
        placeholder: "e.g. test or live - shown in every write preview",
      },
      {
        id: "extraWritableFields",
        env: "WEBJAGUAR_EXTRA_WRITABLE_FIELDS",
        label: "Extra writable product fields (optional)",
        placeholder: "Comma-separated, only fields you have confirmed persist on your store",
        validate: (v) => (/^[A-Za-z][A-Za-z0-9_]*(\s*,\s*[A-Za-z][A-Za-z0-9_]*)*$/.test(v) ? undefined : "Comma-separated field names."),
      },
    ],
    flags: [
      {
        id: "allowWrites",
        env: "WEBJAGUAR_ALLOW_WRITES",
        label: "Product update tools",
        detail: "Update and restore product fields. Each call previews first, archives the product and verifies the result.",
      },
    ],
    secrets: [
      { id: "username", env: "WEBJAGUAR_USERNAME", label: "API username" },
      { id: "password", env: "WEBJAGUAR_PASSWORD", label: "API password" },
    ],
  });
}

export function deactivate(): void {
  // Nothing to clean up; VS Code stops the MCP server processes.
}
