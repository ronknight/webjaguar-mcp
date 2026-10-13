#!/usr/bin/env node
// Pre-publish guard. Fails when files that would be committed or packaged contain
// secret-shaped strings or any term from a private denylist.
//
// Denylist sources (both optional, neither is ever committed):
//   .nda-denylist    one term per line; "re:<regex>" for patterns; "#" comments
//   NDA_DENYLIST     comma-separated terms in the environment
// --strict fails when no denylist is configured, so a publish cannot skip the check.
// Matches are reported by file, line and rule; the matched text itself is never printed.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const strict = process.argv.includes("--strict");
const SKIP_DIRS = new Set([".git", "node_modules", "out", "archive"]);
const BINARY = /\.(png|jpe?g|gif|ico|webp|vsix|zip|gz|woff2?|ttf|pdf)$/i;
const ALLOWED_EMAIL = /@(example\.(com|org|net)|users\.noreply\.github\.com)$/i;
const PLACEHOLDER = /(example|placeholder|dummy|fake|test|xxxx|your[-_]?|changeme|<|\{\{|\$\{)/i;

const SECRET_RULES = [
  { name: "Mailchimp-style API key", rx: /\b[0-9a-f]{32}-us\d{1,2}\b/gi },
  { name: "private key block", rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "AWS access key", rx: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "GitHub token", rx: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: "bearer token", rx: /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/g },
  { name: "credential assignment", rx: /(api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi, value: 2 },
  { name: "basic-auth URL", rx: /https?:\/\/[^/\s:@]+:[^/\s@]+@/g },
  { name: "email address", rx: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, email: true },
];

function loadDenylist() {
  const terms = [];
  const file = path.join(root, ".nda-denylist");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) terms.push(t);
    }
  }
  for (const t of (process.env.NDA_DENYLIST ?? "").split(",")) if (t.trim()) terms.push(t.trim());
  return terms.map((t, i) => ({
    name: `denylist term #${i + 1}`,
    rx: t.startsWith("re:") ? new RegExp(t.slice(3), "gi") : new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
  }));
}

function listFiles() {
  let files;
  try {
    files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    files = walk(root).map((f) => path.relative(root, f));
  }
  // Packaged build output is git-ignored but ships in the .vsix, so scan it too.
  for (const f of ["dist/extension.js", "dist/server.js"]) if (existsSync(path.join(root, f))) files.push(f);
  return [...new Set(files)].filter((f) => !BINARY.test(f) && f !== "package-lock.json");
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const denylist = loadDenylist();
if (!denylist.length) {
  const msg = "nda-check: no .nda-denylist file and no NDA_DENYLIST variable; only generic secret checks run.";
  if (strict) {
    console.error(`${msg}\nCreate .nda-denylist (git-ignored) with the private terms that must never ship, then retry.`);
    process.exit(2);
  }
  console.warn(msg);
}

const findings = [];
for (const rel of listFiles()) {
  const full = path.join(root, rel);
  if (!existsSync(full)) continue;
  const text = readFileSync(full, "utf8");
  const isBundle = rel.startsWith("dist/");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of denylist) {
      rule.rx.lastIndex = 0;
      if (rule.rx.test(line)) findings.push(`${rel}:${i + 1}: ${rule.name}`);
    }
    // Third-party code in the bundle contains test fixtures and emails; check it against the denylist only.
    if (isBundle) return;
    for (const rule of SECRET_RULES) {
      rule.rx.lastIndex = 0;
      let m;
      while ((m = rule.rx.exec(line))) {
        const value = rule.value ? m[rule.value] : m[0];
        if (rule.email && ALLOWED_EMAIL.test(value)) continue;
        if (!rule.email && PLACEHOLDER.test(value)) continue;
        findings.push(`${rel}:${i + 1}: ${rule.name}`);
      }
    }
  });
}

if (findings.length) {
  console.error(`nda-check: ${findings.length} finding(s); nothing may be published until they are fixed:`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`nda-check: clean (${denylist.length} denylist terms, ${SECRET_RULES.length} secret rules).`);
