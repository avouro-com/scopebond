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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// CONFIG — edit ALLOW/DENY here. ALLOW is authoritative: a path must match an
// ALLOW glob or it is rejected. DENY gives a clearer message for known-private
// paths (and is redundant belt-and-suspenders on top of ALLOW).
// Glob syntax: `*` = one path segment, `**` = any depth (incl. none).
// ---------------------------------------------------------------------------

const ALLOW = [
  // Root project & OSS-hygiene files
  "README.md", "LICENSE", "NOTICE", "CHANGELOG.md",
  "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md", "SUPPORT.md",
  "GOVERNANCE.md", "MAINTAINERS.md", "SCOPE.md", "CLA.md", "RELEASING.md",
  "CITATION.cff", "llms.txt", "architecture.svg", "SPEC.md",
  ".claude-plugin/**",
  ".changeset/**",
  ".gitleaks.toml",
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
  // The vendor readers that rule packs replaced (SCOPE.md: knowledge lives in Scopebond Cloud rule packs).
  "packages/hook/src/typed-targets.ts", "packages/hook/src/mcp-profiles.ts",
  // The learning system is closed (SCOPE.md, "Closed components"): no package for it, no training code, notebooks,
  // data sets or model files.
  "packages/intel/**", "packages/*-intel/**",
  "**/*.py", "**/*.ipynb", "**/requirements*.txt", "**/pyproject.toml", "**/Pipfile", "**/*.parquet", "**/*.onnx",
  "**/*.joblib", "**/*.pkl", "**/*.pickle", "**/*.lgb", "**/*.safetensors", "**/*.npy", "**/*.npz",
];

// The closed learning system (SCOPE.md, "Closed components"). The public engine reaches it only through the generic
// plugin interface (`packages/hook/src/intel-plugin.ts`): it never imports the closed module by name, never depends on a
// machine-learning or model-provider library, and never names the closed system's features, tables, artifacts or
// methods. Those names are checked by salted digest, so this file does not publish them: a source token, and every run of
// up to four of its words (split at `_`, `-` and camelCase), is normalised (lower case, separators removed) and hashed.
// OSS_GATE_EXTRA_INTEL_TERMS (comma-separated plain terms) adds terms for one run, as a private check may.
const CLOSED_MODULE = "@scopebond" + "/intel";
const ML_DEPENDENCIES = [
  CLOSED_MODULE, "onnxruntime-node", "onnxruntime-web", "onnxruntime-common", "lightgbm", "xgboost", "brain.js", "synaptic",
  "natural", "@anthropic-ai/sdk", "openai", "@xenova/transformers", "@huggingface/transformers", "@huggingface/inference",
  "@duckdb/node-api", "duckdb", "apache-arrow", "parquetjs", "parquetjs-lite", "hyparquet", "@dsnp/parquetjs",
];
const ML_DEPENDENCY_PREFIXES = ["@tensorflow/", "ml-", "@mlc-ai/", "@langchain/", "langchain"];
const INTEL_TERM_SALT = "scopebond-intel-gate:v1";
const INTEL_TERM_DIGESTS = new Set([
  "022674b7cbfe", "034e64ef703f", "03b1c9374a15", "0418e1b614c8", "04dbf3e7c68c", "06c87ba4d492",
  "070ddd18c70d", "0843e30f4c00", "0856f74747fa", "089fcad75aa2", "08cf74265afb", "08f3be80e668",
  "09ffd53100c5", "0af7234a6f2c", "0cce096751f4", "0d43010094af", "0e2a02d83dc1", "109be5f6b7f4",
  "10db2f10a652", "14e3c3126dc4", "151280b57691", "15b09912aad0", "1772b8c0a371", "17f34a74ae02",
  "1aaf2e58e235", "1ae28e0eb15d", "1c0deb884154", "1d5af1e2c3f9", "1d9374b75408", "1e28bec23ddd",
  "1f682ada3830", "20ace9719535", "20d629c9c539", "217af8b09641", "2182936eff5a", "228fa8fb880e",
  "2354046acaea", "2357c442c138", "25633c6e34dc", "25cfa82cab8f", "2673a3ae7ed9", "2731f186a4e7",
  "2734d0af9ea6", "2838cd82a7f3", "290f162e9807", "2ae21cccc122", "2b3dbdc69518", "2b9aa5d6cc3e",
  "2c062db4d7b9", "2c6e6d6caf4e", "2cffa6b1aa6b", "2d6ba4080d5f", "2ded0a02cce6", "2eb443d5a40c", "2f4a3b62cdd1",
  "2f65294c99d7", "3015f2c22a4a", "3235fe78e5c1", "33493dd0a34e", "36bc8960157d", "36be8f4daa89",
  "370d80eebead", "37a5e9f2ed02", "39c98170a641", "3b5bb82cb5ce", "3bc495dbb732", "3d9364ba042b", "3dbc9debd3d0",
  "3e0cba37bc7c", "3e52e5090b0a", "3f61aa6f8665", "40167eddfebb", "408c1d499b56", "414e662912ed",
  "4195ad5bc381", "43aab7169b0d", "43f7542ec1b3", "44325989af99", "4571763bdb7c", "45de860f5fb2",
  "46d42954bb44", "46dad4173db9", "48fd7ff9f337", "4b02b1a349fd", "4c397dc71ce7", "4ca43dc2ba97", "4ce96fea7ce6",
  "4d346c7dd55b", "4d4c6813cb81", "4d575994e1b4", "4dffdc8f8667", "4ef714099d8a", "4fb9685aa471",
  "502a092230a4", "51214520d561", "51882e2ffa47", "54766824c0f7", "55e67c91b839", "5609addc27da",
  "561129938fdf", "566d8126cee9", "584c126e8682", "5bce66d81f59", "5d522ac90d97", "5dd88fe30238",
  "60447fab1eeb", "613b70ab0e82", "64b73272e362", "64fa90702350", "658fe8939f00", "66d5405ba318",
  "670d680fabd5", "670e44a0ec38", "68149cc38311", "692f3faf3449", "69b73c4033c6", "6b653ab6bd1c",
  "6b69fa089081", "6c8ee4275e3c", "6cd8d69aa9e9", "6d2c0101bbea", "6ea5b3a522e3", "6fb70982d693",
  "7467cb19d85b", "769e82f390e6", "77ed696cecfc", "79e9a6dca8b2", "7a8370ee2698", "7aee28febd42", "7b61c0b76540",
  "7cabbe67f963", "7dc7bfa5532a", "7f3f436b8fd8", "7f4b0187da1b", "802441045c66", "813c29c81743",
  "8301684461c0", "8361f5dff242", "83b1d7d8a0f9", "83bbfbd1b0a1", "840d22096ec2", "852ac58b9953", "859e18167d9e",
  "8699307ce490", "87816cc8218c", "87bec969b31b", "87e63e7b68da", "88b3a33a359d", "896985bf4bb8",
  "8a90497fd240", "8af5771b9259", "8b8f43c4c31e", "8bd1a068f030", "8be9e2ecf02b", "8c57b918e76b",
  "8cc992fb4a74", "8ce496e7eaf7", "8d2aa43a30a2", "8d89b7534173", "929dc4c35f9b", "93cf0e40507e",
  "94c45b976d91", "950976a9ce11", "95da506afb7d", "95dc8d6226c2", "9646c5eac1ca", "966b8e104385",
  "9689f2da21c6", "99d4c64a50fc", "99dabe134823", "9ad2551eb482", "9ef058c3cc48", "9fe8977cfa44",
  "a06177073598", "a0cca1b7ce87", "a0dca60f1b19", "a1639aaaf9fa", "a2c569130693", "a3c6f0b07b7d",
  "a6befcd11e64", "a749ad495cd7", "a8f177abf6f2", "a980b1f1e210", "aba0b8e872ad", "aeff40a50283",
  "b05dc0c79528", "b14a233345a5", "b28094081dcf", "b3aaa8fb16f3", "b4c38a158f30", "baed9d766914",
  "bd5b0a475151", "bd9ce7a2379a", "bdf5d4329da9", "bf482dc0efeb", "c0a031f72a5c", "c1c63b872ccc",
  "c486d6227a02", "c4ea56f8788f", "c6e91523c9dd", "c82ba7141a6b", "c8d1c7fd38d6", "caab28371678",
  "cbb6e86b2c86", "ccd46faa7b6b", "ccf15305a3b2", "cfbbdf949d4e", "d1d9febf9f64", "d385cadb2fe1",
  "d39cc7a4eb56", "d58af96d874d", "d5a1a277b1d8", "d60f8374c6d3", "d61e0c1cc050", "d766555acbe3",
  "d7ec83f66aa2", "d9e5c558bf0a", "dcaca1796839", "dcfa13ce6f3e", "e0ce3892bea5", "e3367719f7d1",
  "e3d04aeb7d4d", "e4455807b282", "e4f3e70bd444", "e659b0885f40", "e6ed835648d3", "e8cdc72bc1d1",
  "e932197d511f", "e9ad7dee553c", "ec28593623b3", "ed121a52d220", "edbe5dcc334d", "ef930d3ac611",
  "f384e8233357", "f4a4029995ae", "f4cd94a71431", "f57676d18418", "f62e55deb1b2", "f65e2ab53cd7",
  "f7276b252991", "f7ad6f4a9ddb", "f834cda98e1e", "fa221db2136d", "fb188e6c6462", "fb3cac5360b8",
  "fce6345ae786", "fe75fe812b67", "ff3aaa726d6b",
  "98809d57cdb9", "a28d47f4ce59",
]);
const normaliseTerm = (t) => t.toLowerCase().replace(/[_-]/g, "");
const termDigest = (t) => createHash("sha256").update(INTEL_TERM_SALT + normaliseTerm(t)).digest("hex").slice(0, 12);
for (const t of (process.env.OSS_GATE_EXTRA_INTEL_TERMS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  INTEL_TERM_DIGESTS.add(termDigest(t));
}
/** Closed-system terms in a text file, as `term` (the source spelling); empty when there are none. */
function intelTermsIn(content) {
  const found = new Set();
  const seen = new Set();
  for (const token of content.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? []) {
    if (seen.has(token)) continue;
    seen.add(token);
    const words = token.split(/[_-]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= 4 && i + n <= words.length; n++) {
        const run = words.slice(i, i + n).join("_");
        if (run.length >= 6 && INTEL_TERM_DIGESTS.has(termDigest(run))) found.add(run);
      }
    }
  }
  return [...found];
}
/** Machine-learning or model-provider dependencies a package manifest declares. */
function mlDependenciesIn(path, content) {
  if (!/(?:^|\/)package\.json$/.test(path)) return [];
  let manifest;
  try { manifest = JSON.parse(content); } catch { return []; }
  const names = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies"]
    .flatMap((k) => (manifest && typeof manifest[k] === "object" && !Array.isArray(manifest[k]) ? Object.keys(manifest[k]) : []));
  return names.filter((n) => ML_DEPENDENCIES.includes(n) || ML_DEPENDENCY_PREFIXES.some((p) => n.startsWith(p)));
}

// Vendor knowledge (SCOPE.md, "engine or knowledge?"): what a vendor's command-line tool or MCP server does belongs in a rule
// pack, not in package source. A source file under packages/*/src that names one of these programs or MCP tools as a string
// literal (`"kubectl"`, `'push_files'`) or as an alternative in a pattern (`(?:helm|kubectl)`) is refused, unless the file
// and the name are listed in VENDOR_NAME_ALLOW with how many times the engine names it there. Tests and fixtures are outside
// packages/*/src and are not checked. Keep both lists current: add a program or tool here when a pack starts describing it.
const VENDOR_PROGRAMS = [
  "aws", "gcloud", "az", "wrangler", "vercel", "fly", "flyctl", "gh", "eb", "serverless", "heroku", "vault", "doppler",
  "kubectl", "helm", "terraform", "tofu", "terragrunt", "pulumi", "cdk", "sst",
  "prisma", "drizzle-kit", "rails", "rake", "alembic", "flyway", "knex", "sequelize",
];
const VENDOR_MCP_TOOLS = [
  "create_pull_request", "merge_pull_request", "push_files", "create_or_update_file", "delete_file",
  "slack_post_message", "slack_reply_to_thread", "post_message", "send_message", "browser_navigate", "puppeteer_navigate",
  "create_issue", "update_issue", "createJiraIssue", "editJiraIssue", "read_query", "write_query", "execute_sql",
];
const VENDOR_NAMES = [...VENDOR_PROGRAMS, ...VENDOR_MCP_TOOLS];
// Engine code that names a vendor program for a reason that is not a pack's knowledge, with the count allowed in that file.
const VENDOR_NAME_ALLOW = new Map([
  // Programs that can send a file elsewhere (the starter protections: a secret file read by an uploader), and the copy
  // commands whose file effects are read like `cp`, and the credential folders the starter protections keep from reads.
  ["packages/hook/src/map.ts", { aws: 1, gcloud: 2, az: 1, gh: 2, kubectl: 1 }],
  // The observation readers the pack format cannot express yet (it has no observation output): GitHub's CLI and API calls,
  // and Wrangler's resource and D1 operations.
  ["packages/hook/src/typed-ops.ts", { gh: 1, create_pull_request: 1, merge_pull_request: 1 }],
  ["packages/hook/src/typed-wrangler.ts", { wrangler: 2 }],
  // The remote-database guard falls back to a deny for a command that names a database tool when its reader fails.
  ["packages/hook/src/cli-main.ts", { wrangler: 1 }],
  // Package installs through GitHub's CLI extensions (install detection), and the Copilot CLI's own session (`gh copilot`).
  ["packages/hook/src/typed-install.ts", { gh: 2 }],
  ["packages/hook/src/session-budgets.ts", { gh: 1 }],
]);
const SOURCE_FILE = /^packages\/[^/]+\/src\/.*\.(?:ts|tsx|js|mjs|cjs)$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VENDOR_ALTERNATIVES = VENDOR_NAMES.map(escapeRe).join("|");
// A quoted string that is exactly the name, or the name as one alternative of a pattern group (`(?:name|…)`, `…|name)`).
// eslint-disable-next-line security/detect-non-literal-regexp -- built once from the constant lists above
const VENDOR_NAME_RE = new RegExp(`(?:["'](${VENDOR_ALTERNATIVES})["'])|(?:(?:\\(\\?:|\\|)(${VENDOR_ALTERNATIVES})(?=[|)]))`, "g");
/** The vendor names a source file carries beyond what VENDOR_NAME_ALLOW lets it name, as `name ×count`. */
function vendorNamesIn(path, content) {
  if (!SOURCE_FILE.test(path)) return [];
  const counts = new Map();
  for (const m of content.matchAll(VENDOR_NAME_RE)) {
    const name = m[1] ?? m[2];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const allowed = VENDOR_NAME_ALLOW.get(path) ?? {};
  return [...counts].filter(([name, n]) => n > (allowed[name] ?? 0)).map(([name, n]) => `${name} ×${n}`);
}

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
  { name: "private repository name", re: new RegExp("scopebond-(?:" + "internal|" + "private)\\b", "i") },
  { name: "Windows workstation checkout path", re: /\b[A-Za-z]:[\\/]GitHub[\\/]/i },
  { name: "Git Bash workstation checkout path", re: /(?:^|[\s"'`(=])\/[a-z]\/GitHub\//i },
];

// Internal planning references: readers of this repository cannot look them up, so they appear nowhere in the tree
// (code, tests, fixtures, docs, changelogs, workflows). Each pattern is written so the text of this file does not
// match it.
const INTERNAL_REFERENCE_PATTERNS = [
  // A backlog id: "SB" and two or more digits.
  { name: "internal tracker id", re: /\bSB\d{2,}\b/ },
  // A decision id used as a reference: "(D67)", "D140: …", "D36/…", "per D27", "the D67 bound", "D65 §2",
  // "D33 — …". A "D" and digits anywhere else (a hex digest, a GUID part, a D1 database binding) is left alone.
  { name: "internal decision id", re: /(?<![\w.#{}/-])D\d{2,3}(?![\w.-])(?=\s*(?:[):,;/§]|—|\())|\b(?:per|see|under|the) D\d{2,3}\b/ },
  { name: "internal work-block id", re: /\bW[1-8]-\d{2}\b/ },
  { name: "internal milestone label", re: /\bMVP1\b/ },
  { name: "internal architecture decision record", re: /\bADR-\d+/ },
  { name: "internal specification name", re: new RegExp("GATEWAY" + "_SPEC") },
  { name: "pointer to a private document", re: /\bdocs\/(?:integrations|architecture|decisions|ops|strategy|legal|product)\// },
];

// Assistant attribution pasted into a tracked file: a co-author trailer or a "generated with" line.
const CONTENT_ATTRIBUTION_PATTERNS = [
  { name: "AI co-author trailer", re: /co-authored-by:.*(?:claude|anthropic)/i },
  { name: "AI generation attribution", re: /generated with \[?claude code/i },
];

// Files that legitimately hold text the internal-reference or attribution checks look for. Keep this list short and
// say why for each entry; a path here skips only the checks named for it.
const CONTENT_CHECK_EXCEPTIONS = new Map([
  // The gate and its tests spell out the patterns they enforce, and sample strings that must trip them.
  ["scripts/oss-gate.mjs", ["internal", "attribution", "intel"]],
  ["scripts/oss-gate.test.mjs", ["internal", "attribution", "intel"]],
  // Describes, with made-up examples, the id shapes it removes from comments.
  ["scripts/strip-ticket-ids.mjs", ["internal"]],
  // A hook test: an agent's commit trailer and PR body that mention the assistant must not read as switching Scopebond off.
  ["packages/hook/test/self-disable-config-env.test.mjs", ["attribution"]],
]);
const exempt = (path, check) => (CONTENT_CHECK_EXCEPTIONS.get(path) ?? []).includes(check);

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
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
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
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from this script's own ALLOW/DENY globs with every regex metacharacter escaped above
  return new RegExp("^" + re + "$");
}
const ALLOW_RE = ALLOW.map(globToRegex);
const DENY_RE = DENY.map((g) => ({ glob: g, re: globToRegex(g) }));

/** Run git with arguments, never through a shell: file names and ranges are data, not shell text. */
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
/** A revision range from the command line: one git revision expression, never an option. */
const safeRange = (range) => {
  if (typeof range !== "string" || !/^[^-\s]\S*$/.test(range)) { console.error(`oss-gate: not a revision range: ${range}`); process.exit(2); }
  return range;
};

function listFiles(mode, range) {
  if (mode === "staged") {
    return git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split("\0").filter(Boolean);
  }
  if (mode === "range") {
    return git("diff", "--name-only", "--diff-filter=ACMR", "-z", safeRange(range)).split("\0").filter(Boolean);
  }
  return git("ls-files", "-z").split("\0").filter(Boolean);
}

function readContent(mode, path) {
  try {
    if (mode === "staged") return git("show", `:${path}`);
    try { return readFileSync(path, "utf8"); } catch { /* not in the working tree: read it from HEAD */ }
    return git("show", `HEAD:${path}`);
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
  let msg = "";
  if (msgFile) { try { msg = readFileSync(msgFile, "utf8"); } catch { /* no message file: nothing to scan */ } }
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
  try { shas = git("log", "--format=%H", safeRange(range)).split(/\r?\n/).filter(Boolean); }
  catch (e) { console.error("oss-gate: could not list commits in range:", e.message); process.exit(2); }
  const bad = [];
  for (const sha of shas) {
    const found = scanCommitMessage(git("log", "-1", "--format=%B", sha));
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
  if (!exempt(path, "internal")) {
    for (const { name, re } of INTERNAL_REFERENCE_PATTERNS) {
      const m = content.match(re);
      if (m) {
        violations.push({ path, kind: "PRIVATE CONTENT", detail: `${name} "${m[0].trim()}" (readers of this repository cannot look it up)` });
        break;
      }
    }
  }
  if (!exempt(path, "attribution")) {
    for (const { name, re } of CONTENT_ATTRIBUTION_PATTERNS) {
      const m = content.match(re);
      if (m) {
        violations.push({ path, kind: "TOOL ATTRIBUTION", detail: `${name}: "${m[0]}"` });
        break;
      }
    }
  }
  if (!exempt(path, "intel")) {
    const ml = mlDependenciesIn(path, content);
    if (ml.length) {
      violations.push({ path, kind: "CLOSED COMPONENT", detail: `depends on ${ml.join(", ")}: machine-learning and model-provider libraries are not part of the open engine (SCOPE.md, "Closed components")` });
    }
    if (content.includes(CLOSED_MODULE)) {
      violations.push({ path, kind: "CLOSED COMPONENT", detail: `names the closed learning module; the engine reaches it only through the generic plugin interface (SCOPE.md, "Closed components")` });
    }
    const terms = intelTermsIn(content);
    if (terms.length) {
      violations.push({ path, kind: "CLOSED COMPONENT", detail: `names ${terms.slice(0, 5).join(", ")}${terms.length > 5 ? ` and ${terms.length - 5} more` : ""}: identifiers of the closed learning system stay out of the open engine (SCOPE.md, "Closed components")` });
    }
  }
  const vendor = vendorNamesIn(path, content);
  if (vendor.length) {
    violations.push({ path, kind: "VENDOR KNOWLEDGE", detail: `names ${vendor.join(", ")}: what a vendor's tool or MCP server does belongs in a Scopebond Cloud rule pack (SCOPE.md). If this is engine code, list it in VENDOR_NAME_ALLOW in scripts/oss-gate.mjs and say why.` });
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
