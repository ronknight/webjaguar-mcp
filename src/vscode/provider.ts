// VS Code glue shared by the MCP server extensions: one MCP server per profile,
// credentials in Secret Storage, and the bundled server started on VS Code's own runtime.
//
// Security notes:
// - Profiles and nodePath are application-scoped settings, so a workspace cannot
//   point a stored credential at another host or swap the Node executable.
// - Each stored secret remembers the profile settings it was entered for. If those
//   settings change (for example the base URL), the user is asked to confirm again.

import { createHash } from "node:crypto";

import * as vscode from "vscode";

export interface FieldSpec {
  id: string;
  env: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  validate?: (value: string) => string | undefined;
}

export interface FlagSpec {
  id: string;
  env: string;
  label: string;
  detail: string;
  /** Flag only makes sense when this other flag is on. */
  requires?: string;
}

export interface SecretSpec {
  id: string;
  env: string;
  label: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}

export interface ProviderSpec {
  providerId: string;
  section: string;
  displayName: string;
  serverScript: string;
  fields: FieldSpec[];
  flags: FlagSpec[];
  secrets: SecretSpec[];
}

type Profile = { name: string } & Record<string, unknown>;

interface StoredSecret {
  value: string;
  fingerprint: string;
}

const NAME = /^[A-Za-z0-9_-]{1,32}$/;

export function activateProvider(context: vscode.ExtensionContext, spec: ProviderSpec): void {
  const changed = new vscode.EventEmitter<void>();
  const labels = new Map<string, Profile>();
  const version = String(context.extension.packageJSON.version ?? "0.0.0");

  const config = () => vscode.workspace.getConfiguration(spec.section);
  // Read only the user-level value; workspace values are ignored on purpose.
  const profiles = (): Profile[] => {
    const value = config().inspect<unknown[]>("profiles")?.globalValue;
    return Array.isArray(value) ? value.filter((p): p is Profile => isProfile(p)) : [];
  };
  const nodePath = (): string => String(config().inspect<string>("nodePath")?.globalValue ?? "").trim();
  const secretKey = (profile: string, secret: SecretSpec) => `${spec.section}:${profile}:${secret.id}`;
  const fingerprint = (profile: Profile) =>
    createHash("sha256")
      .update(JSON.stringify(spec.fields.map((f) => String(profile[f.id] ?? ""))))
      .digest("hex")
      .slice(0, 16);
  const labelFor = (profile: Profile) => (profile.name === "default" ? spec.displayName : `${spec.displayName} (${profile.name})`);

  const definition = (profile: Profile): vscode.McpStdioServerDefinition => {
    const custom = nodePath();
    const env: Record<string, string | number | null> = {};
    if (!custom) env.ELECTRON_RUN_AS_NODE = "1";
    for (const field of spec.fields) {
      const value = String(profile[field.id] ?? "").trim();
      if (value) env[field.env] = value;
    }
    for (const flag of spec.flags) {
      env[flag.env] = profile[flag.id] === true ? "true" : "false";
    }
    const label = labelFor(profile);
    labels.set(label, profile);
    return new vscode.McpStdioServerDefinition(label, custom || process.execPath, [context.asAbsolutePath(spec.serverScript)], env, version);
  };

  const readSecret = async (profile: Profile, secret: SecretSpec): Promise<StoredSecret | undefined> => {
    const raw = await context.secrets.get(secretKey(profile.name, secret));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as StoredSecret;
      return typeof parsed.value === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const askSecret = async (profile: Profile, secret: SecretSpec, reason: string): Promise<string | undefined> => {
    const value = await vscode.window.showInputBox({
      title: `${spec.displayName} MCP: ${secret.label} for profile "${profile.name}"`,
      prompt: reason,
      placeHolder: secret.placeholder,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? secret.validate?.(v.trim()) : "Required."),
    });
    if (!value?.trim()) return undefined;
    await context.secrets.store(secretKey(profile.name, secret), JSON.stringify({ value: value.trim(), fingerprint: fingerprint(profile) }));
    return value.trim();
  };

  context.subscriptions.push(
    changed,
    vscode.lm.registerMcpServerDefinitionProvider(spec.providerId, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: async () => {
        labels.clear();
        return profiles()
          .filter((p) => spec.fields.every((f) => !f.required || String(p[f.id] ?? "").trim()))
          .map(definition);
      },
      resolveMcpServerDefinition: async (server) => {
        const profile = labels.get(server.label);
        if (!profile || !(server instanceof vscode.McpStdioServerDefinition)) return server;
        const env = { ...server.env };
        for (const secret of spec.secrets) {
          const stored = await readSecret(profile, secret);
          let value = stored?.value;
          if (!stored) {
            value = await askSecret(profile, secret, `Stored in VS Code Secret Storage and passed to the ${spec.displayName} MCP server only.`);
          } else if (stored.fingerprint !== fingerprint(profile)) {
            value = await askSecret(
              profile,
              secret,
              `The settings of profile "${profile.name}" changed since this credential was saved. Re-enter it to confirm it may be sent to the new settings.`,
            );
          }
          if (!value) return undefined;
          env[secret.env] = value;
        }
        server.env = env;
        return server;
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(spec.section)) changed.fire();
    }),
    vscode.commands.registerCommand(`${spec.section}.configure`, () => configureProfile(context, spec, profiles(), askSecret, changed)),
    vscode.commands.registerCommand(`${spec.section}.clearCredentials`, async () => {
      const pick = await vscode.window.showQuickPick(
        profiles().map((p) => p.name),
        { title: `${spec.displayName} MCP: clear stored credentials`, placeHolder: "Profile" },
      );
      if (!pick) return;
      for (const secret of spec.secrets) await context.secrets.delete(secretKey(pick, secret));
      changed.fire();
      void vscode.window.showInformationMessage(`${spec.displayName} MCP: credentials for "${pick}" removed. Restart the server to apply.`);
    }),
  );
}

async function configureProfile(
  context: vscode.ExtensionContext,
  spec: ProviderSpec,
  existing: Profile[],
  askSecret: (profile: Profile, secret: SecretSpec, reason: string) => Promise<string | undefined>,
  changed: vscode.EventEmitter<void>,
): Promise<void> {
  const NEW = "$(add) New profile";
  const choice = await vscode.window.showQuickPick([NEW, ...existing.map((p) => p.name)], {
    title: `${spec.displayName} MCP: add or edit a profile`,
  });
  if (!choice) return;

  let profile: Profile;
  if (choice === NEW) {
    const name = await vscode.window.showInputBox({
      title: `${spec.displayName} MCP: profile name`,
      value: existing.length ? "" : "default",
      prompt: "Letters, digits, - or _. Use one profile per account or environment.",
      ignoreFocusOut: true,
      validateInput: (v) => (!NAME.test(v) ? "Use 1-32 letters, digits, - or _." : existing.some((p) => p.name === v) ? "That profile exists." : undefined),
    });
    if (!name) return;
    profile = { name };
  } else {
    profile = { ...(existing.find((p) => p.name === choice) as Profile) };
  }

  for (const field of spec.fields) {
    const value = await vscode.window.showInputBox({
      title: `${spec.displayName} MCP: ${field.label}`,
      value: String(profile[field.id] ?? ""),
      placeHolder: field.placeholder,
      ignoreFocusOut: true,
      validateInput: (v) => (field.required && !v.trim() ? "Required." : v.trim() ? field.validate?.(v.trim()) : undefined),
    });
    if (value === undefined) return;
    if (value.trim()) profile[field.id] = value.trim();
    else delete profile[field.id];
  }

  if (spec.flags.length) {
    const picked = await vscode.window.showQuickPick(
      spec.flags.map((f) => ({ label: f.label, detail: f.detail, picked: profile[f.id] === true, id: f.id })),
      { title: `${spec.displayName} MCP: optional write features (leave all unchecked for read-only)`, canPickMany: true, ignoreFocusOut: true },
    );
    if (!picked) return;
    const on = new Set(picked.map((p) => p.id));
    for (const flag of spec.flags) {
      profile[flag.id] = on.has(flag.id) && (!flag.requires || on.has(flag.requires));
    }
  }

  for (const secret of spec.secrets) {
    const value = await askSecret(profile, secret, `Stored in VS Code Secret Storage. Leave empty (Escape) to keep the current value.`);
    if (!value && !(await context.secrets.get(`${spec.section}:${profile.name}:${secret.id}`))) {
      void vscode.window.showWarningMessage(`${spec.displayName} MCP: no ${secret.label} stored; you will be asked when the server starts.`);
    }
  }

  const next = existing.filter((p) => p.name !== profile.name).concat(profile);
  await vscode.workspace.getConfiguration(spec.section).update("profiles", next, vscode.ConfigurationTarget.Global);
  changed.fire();
  void vscode.window.showInformationMessage(
    `${spec.displayName} MCP: profile "${profile.name}" saved. Start it from the MCP Servers view or the chat tools picker.`,
  );
}

function isProfile(value: unknown): value is Profile {
  return Boolean(value && typeof value === "object" && typeof (value as Profile).name === "string" && NAME.test((value as Profile).name));
}
