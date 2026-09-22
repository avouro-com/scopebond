#!/usr/bin/env node
/**
 * oss-gate.mjs — the hard gate for the Scopebond open-source repository.
 *
 * Purpose: this repository is PUBLIC (Apache-2.0). It must contain only
 * open-source-appropriate content. The business/strategy/legal/economics
 * design docs live in a SEPARATE PRIVATE repository and must never land here.
 *
 * This script fails (exit 1) if anything outside the open-source allowlist,
 * anything on the private denylist, a private-doc signature, or a secret is
 * about to enter the repo. It is wired into:
 *   - .githooks/pre-commit   (mode --staged)  → blocks the commit
 *   - .githooks/pre-push     (mode --tree)    → blocks the push
 *   - .github/workflows/oss-guard.yml (--tree) → required check, blocks merge
 *
 * Modes:
 *   --staged        check files staged for commit (default)
 *   --tree          check every tracked file in the working tree (CI / pre-push)
 *   --range A..B    check files changed in a commit range
 *   --message FILE  scan a commit-message file for private and tool-attribution markers
 *   --help
 *
 * No external dependencies. Node >= 18.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// CONFIG — edit ALLOW/DENY here. ALLOW is authoritative: a path must match an
// ALLOW glob or it is rejected. DENY gives a clearer message for known-private
// paths (and is redundant belt-and-suspenders on top of ALLOW).
// Glob syntax: `*` = one path segment, `**` = any depth (incl. none).
// ---------------------------------------------------------------------------

const ALLOW = [
  // Root project & OSS-hygiene files
  "README.md", "LICENSE", "NOTICE", "CHANGELOG.md",
  "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md",
  "GOVERNANCE.md", "MAINTAINERS.md", "SCOPE.md", "CLA.md", "RELEASING.md",
  "CITATION.cff", "llms.txt", "architecture.svg",
  ".claude-plugin/**",
  ".changeset/**",
  ".gitignore", ".gitattributes", ".editorconfig", ".nvmrc", ".node-version", ".npmrc",
  "package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml",
  "tsconfig.json", "tsconfig.*.json", "vitest.config.*", "eslint.config.*",
  ".prettierrc", ".prettierrc.*", ".prettierignore",
  // Trees that hold only public code, tooling, and public-facing docs
  ".github/**",
  ".githooks/**",
  "scripts/**",
  "packages/**",
  "examples/**",
  "tests/**", "test/**",
];

const DENY = [
  // The private design-doc tree and its record classes — never public.
  "docs/**",
  "CLAUDE.md", "AGENTS.md", "**/AGENTS.md",
  "**/AGENTS.private.md",
  "**/DECISIONS.md",
  "**/CURRENT_STATE.md",
  "**/ROADMAP.md",
  "**/GLOSSARY.md",
  "**/REGULATORY_MEMO.md",
  "**/COMPLIANCE_REGISTER.md",
  "**/TOKEN_AND_ECONOMICS.md",
  "**/VISION_AND_STRATEGY.md",
  "**/BUYER_BRIEF.md",
  "**/AUDIT_READINESS.md",
  "**/GATES.md",
  "**/RISKS.md",
  "changelog/**",
  "**/adr/ADR-*.md",
  // Marketing sites / deploy config belong in a PRIVATE repo, not the OSS repo.
  "site/**", "web/**", "vercel.json", "**/*.html",
  // Secrets / local env
  ".env", ".env.*", ".dev.vars", ".dev.vars.*", "**/*.pem", "**/*.key",
];

// Distinctive markers that flag private content pasted into an allowed path.
// Built by concatenation so this file does not trip its own scanner.
const PRIVATE_MARKER = "SCOPEBOND" + ":" + "PRIVATE";
// Every private design doc carries a "Status: Canonical" header — a strong,
// low-false-positive signal that a private doc has leaked into the public tree.
const PRIVATE_DOC_SIGNATURES = [
  PRIVATE_MARKER,
  "**Status:**" + " Canonical",
  "Draft for legal" + " review",
  "append-only" + " record",
];

// Prior / other private project codenames that must never appear in the public
// repo — not in code, paths, or docs. Assembled by concatenation so this file
// does not trip its own scanner. Add codenames here as needed.
const BLOCKED_TERMS = ["key" + "tine", "true" + "stead"];

// Local workstation paths and private-repository references are never useful
// in a public source tree. Keep the repository name split so the gate does not
// report its own policy declaration.
const PERSONAL_OR_PRIVATE_PATTERNS = [
  { name: "Windows user profile path", re: /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/ },
  { name: "macOS user profile path", re: /\/Users\/[^/\s]+/ },
  { name: "Linux user profile path", re: /\/home\/[^/\s]+/ },
  { name: "private repository name", re: new RegExp("scopebond-" + "internal", "i") },
];

// Do not advertise an assistant or generation tool in commit metadata. Product
// references to AI providers remain valid source content and are not blocked.
const TOOL_ATTRIBUTION_PATTERNS = [
  { name: "AI co-author trailer", re: /co-authored-by:.*(?:chatgpt|openai|codex|claude|anthropic|copilot|\[bot\])/i },
  { name: "AI generation attribution", re: /(?:AI[- ]generated|generated (?:by|with) (?:AI|ChatGPT|OpenAI|Codex|Claude|Anthropic|Copilot))/i },
];

// High-signal secret patterns. Kept conservative to avoid false positives.
const SECRET_PATTERNS = [
  { name: "private key block", re: new RegExp("-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |ENCRYPTED )?" + "PRIVATE KEY-----") },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[posru]_[0-9A-Za-z]{36,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: "Stripe secret key", re: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/ },
  { name: "generic assigned secret",
    re: /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"][^'"\n]{12,}['"]/i },
];
// Values that look like a secret but are clearly placeholders.
const PLACEHOLDER = /(your[_-]|example|changeme|placeholder|xxxx|<[^>]+>|\$\{|process\.env|env\(|todo|redacted|\*\*\*)/i;

// ---------------------------------------------------------------------------

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}
const ALLOW_RE = ALLOW.map(globToRegex);
const DENY_RE = DENY.map((g) => ({ glob: g, re: globToRegex(g) }));

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function listFiles(mode, range) {
  if (mode === "staged") {
    return sh("git diff --cached --name-only --diff-filter=ACMR -z").split("\0").filter(Boolean);
  }
  if (mode === "range") {
    return sh(`git diff --name-only --diff-filter=ACMR -z ${range}`).split("\0").filter(Boolean);
  }
  return sh("git ls-files -z").split("\0").filter(Boolean);
}

function readContent(mode, path) {
  try {
    if (mode === "staged") return sh(`git show :"${path}"`);
    if (existsSync(path)) return readFileSync(path, "utf8");
    return sh(`git show HEAD:"${path}"`);
  } catch { return ""; }
}

function isBinary(s) {
  return s.includes("\0");
}

// ---------------------------------------------------------------------------

const arg = process.argv[2] || "--staged";
if (arg === "--help" || arg === "-h") {
  console.log("usage: node scripts/oss-gate.mjs [--staged|--tree|--range A..B]");
  process.exit(0);
}
let mode = "staged", range = "", msgFile = "";
if (arg === "--tree") mode = "tree";
else if (arg === "--range") { mode = "range"; range = process.argv[3] || "HEAD~1..HEAD"; }
else if (arg === "--message") { mode = "message"; msgFile = process.argv[3] || ""; }
else if (arg === "--messages-range") { mode = "messages-range"; range = process.argv[3] || "HEAD~1..HEAD"; }
else if (arg !== "--staged") { console.error(`unknown argument: ${arg}`); process.exit(2); }

// Commit-message scan: content checks only (no path allowlist).
if (mode === "message") {
  const msg = msgFile && existsSync(msgFile) ? readFileSync(msgFile, "utf8") : "";
  const lower = msg.toLowerCase();
  const found = [];
  const t = BLOCKED_TERMS.find((x) => lower.includes(x));
  if (t) found.push(`blocked codename "${t}"`);
  for (const sig of PRIVATE_DOC_SIGNATURES) if (msg.includes(sig)) { found.push(`private-doc signature "${sig}"`); break; }
  for (const { name, re } of TOOL_ATTRIBUTION_PATTERNS) if (re.test(msg)) { found.push(name); break; }
  for (const { name, re } of SECRET_PATTERNS) { const m = msg.match(re); if (m && !PLACEHOLDER.test(m[0])) { found.push(`possible ${name}`); break; } }
  if (found.length === 0) { console.log("✓ oss-gate: commit message clean."); process.exit(0); }
  console.error(`\n✗ oss-gate: commit message contains: ${found.join(", ")}. Rewrite the message.\n`);
  process.exit(1);
}

// Scan every commit message in a range (CI required check — closes the local
// commit-msg hook's `--no-verify` bypass by enforcing messages server-side).
function scanCommitMessage(msg) {
  const lower = msg.toLowerCase();
  const found = [];
  const t = BLOCKED_TERMS.find((x) => lower.includes(x));
  if (t) found.push(`blocked codename "${t}"`);
  for (const sig of PRIVATE_DOC_SIGNATURES) if (msg.includes(sig)) { found.push(`private-doc signature "${sig}"`); break; }
  for (const { name, re } of TOOL_ATTRIBUTION_PATTERNS) if (re.test(msg)) { found.push(name); break; }
  for (const { name, re } of PERSONAL_OR_PRIVATE_PATTERNS) if (re.test(msg)) { found.push(name); break; }
  for (const { name, re } of SECRET_PATTERNS) { const m = msg.match(re); if (m && !PLACEHOLDER.test(m[0])) { found.push(`possible ${name}`); break; } }
  return found;
}
if (mode === "messages-range") {
  let shas;
  try { shas = sh(`git log --format=%H ${range}`).split(/\r?\n/).filter(Boolean); }
  catch (e) { console.error("oss-gate: could not list commits in range:", e.message); process.exit(2); }
  const bad = [];
  for (const sha of shas) {
    const found = scanCommitMessage(sh(`git log -1 --format=%B ${sha}`));
    if (found.length) bad.push(`${sha.slice(0, 8)}: ${found.join(", ")}`);
  }
  if (bad.length === 0) { console.log(`✓ oss-gate: ${shas.length} commit message(s) clean in ${range}.`); process.exit(0); }
  console.error(`\n✗ oss-gate: forbidden content in commit message(s):`);
  for (const b of bad) console.error(`  ${b}`);
  console.error(`\nRewrite these messages (no AI/tool attribution, no private markers or secrets).\n`);
  process.exit(1);
}

let files;
try { files = listFiles(mode, range); }
catch (e) { console.error("oss-gate: could not list files (is this a git repo?):", e.message); process.exit(2); }

const violations = [];
for (const f of files) {
  const path = f.replace(/\\/g, "/");

  // 1. Denylist (clear message for known-private paths)
  const denied = DENY_RE.find((d) => d.re.test(path));
  if (denied) {
    violations.push({ path, kind: "PRIVATE PATH", detail: `matches denied pattern "${denied.glob}" — this belongs in the private repo` });
    continue;
  }
  // 2. Allowlist (authoritative)
  if (!ALLOW_RE.some((re) => re.test(path))) {
    violations.push({ path, kind: "NOT ALLOWLISTED", detail: "no ALLOW pattern matches. If this is OSS content, add it to ALLOW in scripts/oss-gate.mjs; if it is private, do not commit it here." });
    continue;
  }
  // 3a. Blocked codenames in the path itself
  const lowerPath = path.toLowerCase();
  const pathTerm = BLOCKED_TERMS.find((t) => lowerPath.includes(t));
  if (pathTerm) {
    violations.push({ path, kind: "BLOCKED TERM", detail: `path references private project codename "${pathTerm}" — must not appear in the public repo` });
    continue;
  }
  // 3b. Content scans
  const content = readContent(mode, path);
  if (!content || isBinary(content)) continue;
  const lowerContent = content.toLowerCase();
  const term = BLOCKED_TERMS.find((t) => lowerContent.includes(t));
  if (term) {
    violations.push({ path, kind: "BLOCKED TERM", detail: `references private project codename "${term}" — must not appear in the public repo` });
    continue;
  }
  for (const { name, re } of PERSONAL_OR_PRIVATE_PATTERNS) {
    const m = content.match(re);
    if (m) {
      violations.push({ path, kind: "PERSONAL OR PRIVATE CONTENT", detail: `${name}: ${m[0]}` });
      break;
    }
  }
  for (const sig of PRIVATE_DOC_SIGNATURES) {
    if (content.includes(sig)) {
      violations.push({ path, kind: "PRIVATE CONTENT", detail: `contains private-doc signature "${sig}"` });
      break;
    }
  }
  for (const { name, re } of SECRET_PATTERNS) {
    const m = content.match(re);
    if (m && !PLACEHOLDER.test(m[0])) {
      violations.push({ path, kind: "SECRET", detail: `possible ${name}: ${m[0].slice(0, 24)}…` });
      break;
    }
  }
}

const scope = mode === "staged" ? "staged for commit" : mode === "range" ? `in ${range}` : "tracked in the tree";
if (violations.length === 0) {
  console.log(`✓ oss-gate: ${files.length} file(s) ${scope} — all clear for the open-source repo.`);
  process.exit(0);
}

console.error(`\n✗ oss-gate: ${violations.length} violation(s) — this content must NOT enter the public repo.\n`);
for (const v of violations) console.error(`  [${v.kind}] ${v.path}\n      ${v.detail}`);
console.error(`\nThe Scopebond OSS repo is public. Private design docs live in the separate private repo.`);
console.error(`If a block is wrong, adjust ALLOW/DENY in scripts/oss-gate.mjs (and say why in the commit).\n`);
process.exit(1);
