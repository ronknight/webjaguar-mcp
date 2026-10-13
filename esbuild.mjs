// Bundles the VS Code extension and the stdio MCP server into dist/.
// Production builds also write dist/THIRD_PARTY_NOTICES.txt for the bundled packages.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: !production,
  minify: production,
  legalComments: "none",
  metafile: true,
  logLevel: "info",
};

const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
  { ...common, entryPoints: ["src/server.ts"], outfile: "dist/server.js", banner: { js: "#!/usr/bin/env node" } },
];

function writeNotices(metafiles) {
  const packages = new Map();
  for (const meta of metafiles) {
    for (const input of Object.keys(meta.inputs)) {
      const match = input.replace(/\\/g, "/").match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
      if (match) packages.set(match[1], path.join("node_modules", match[1]));
    }
  }
  const sections = [];
  for (const [name, dir] of [...packages].sort()) {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"].map((f) => path.join(dir, f)).find(existsSync);
    const text = licenseFile ? readFileSync(licenseFile, "utf8").trim() : `License: ${pkg.license ?? "see package"}`;
    sections.push(`${name}@${pkg.version} (${pkg.license ?? "unknown"})\n${"-".repeat(60)}\n${text}`);
  }
  writeFileSync("dist/THIRD_PARTY_NOTICES.txt", `Third-party software bundled in this extension\n\n${sections.join("\n\n")}\n`);
  console.log(`wrote dist/THIRD_PARTY_NOTICES.txt (${packages.size} packages)`);
}

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  const results = await Promise.all(builds.map((b) => esbuild.build(b)));
  if (production) writeNotices(results.map((r) => r.metafile));
}
