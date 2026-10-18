import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const gate = (...args) => spawnSync(process.execPath, ["scripts/oss-gate.mjs", ...args], { encoding: "utf8" });

test("a commit range is one git revision expression: any letters pass, an option or whitespace is refused", () => {
  const ok = gate("--messages-range", "HEAD..HEAD"); // always a valid range, even in a shallow clone
  assert.equal(ok.status, 0, ok.stderr);
  // Branch names with any letters are ranges too (a mangled validator once refused every range containing "s"). The branch
  // need not exist: the validator must let it through to git, which then reports the unknown revision itself.
  const named = gate("--messages-range", "origin/ci/more-scanners..HEAD");
  assert.equal(named.stderr.includes("not a revision range"), false, named.stderr);
  for (const bad of ["--output=/tmp/x", "-p", "HEAD~1 HEAD", ""]) {
    const r = gate("--messages-range", bad);
    if (bad === "") continue; // an empty argument falls back to the default range
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /not a revision range/, bad);
  }
});

// Runs the gate over a throwaway repository holding exactly the given files (tracked, not committed).
const gateScript = resolve("scripts/oss-gate.mjs");
function gateOver(files) {
  const dir = mkdtempSync(join(tmpdir(), "oss-gate-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    spawnSync("git", ["add", "-A"], { cwd: dir });
    return spawnSync(process.execPath, [gateScript, "--tree"], { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Strings the gate must refuse, assembled so this file's own text stays plain.
const refused = {
  "tracker id in a test name": 'test("SB' + '290: a record waits", () => {});',
  "tracker id in a changelog": "- 5d5724a: Connector hardening (SB" + "68).",
  "decision id in parentheses": "the element-wise array path bound (D" + "67).",
  "decision id leading a test name": 'test("D' + '140: a managed computer", () => {});',
  "decision id before a slash": "// Sanctioned deps (D" + "36/runtime).",
  "decision id after per": "Counted per D" + "27 in the suite.",
  "decision id after the": "infra/prod/** (the D" + "67 element-wise array bound).",
  "work-block id": "Done in W" + "1-03.",
  "milestone label": "Planned for MVP" + "1.",
  "architecture decision record": "Runtime-agnostic (ADR" + "-004).",
  "specification name": "See GATEWAY" + "_SPEC §15.",
  "private document pointer": "Human index: docs/" + "integrations/ACTION_TAXONOMY.md.",
  "Git Bash checkout path": "cd /c/" + "GitHub/project && ls",
  "Windows checkout path": "C:\\" + "GitHub\\project\\README.md",
  "private repository name": "Mirrored from scopebond" + "-private.",
  "co-author trailer": "Co-Authored-" + "By: Claude <noreply@" + "anthropic.com>",
  "generation line": "Generated with [Claude " + "Code](https://claude.com/claude-code)",
};

test("internal references, workstation paths and assistant attribution anywhere in the tree are refused", () => {
  const files = {};
  Object.values(refused).forEach((text, i) => { files[`packages/demo/test/case${i}.mjs`] = `${text}\n`; });
  const r = gateOver(files);
  assert.equal(r.status, 1, r.stdout);
  Object.keys(refused).forEach((label, i) => {
    assert.ok(r.stderr.includes(`packages/demo/test/case${i}.mjs\n`), `${label} was not refused`);
  });
});

test("look-alikes of internal references pass: hex, GUIDs, a D1 binding, versions, ordinary docs paths", () => {
  const r = gateOver({
    "packages/demo/src/a.ts": [
      'const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08D96";',
      "// UpgradeCode={92E9376F-D496-4CBE-A4B5-0E860E488A44}",
      "// The D1 database binding, and a D1 query: env.DB.prepare(sql).",
      'const files = ["docs/readme.md", "docs/x.md"]; // version 1.0.0, PBKDF2, SHA256',
      "cd /c/work/project/packages && cat package.json",
      "// The fixture strings: SBOM, SB-1, W9-01, ADR without a number, MVP2.",
    ].join("\n"),
    // An explicitly listed fixture may hold an assistant's commit trailer.
    "packages/hook/test/self-disable-config-env.test.mjs": "const TRAILER = \"Co-Authored-" + "By: Claude <noreply@" + "anthropic.com>\";\n",
  });
  assert.equal(r.status, 0, r.stderr);
});

// Vendor knowledge belongs in rule packs, not in package source (SCOPE.md). The names are assembled so this file stays plain.
const tool = (...parts) => parts.join("");
test("vendor tool and MCP server knowledge in package source is refused; tests, made-up tools and listed engine code pass", () => {
  const refusedFiles = {
    "packages/hook/src/typed-targets.ts": "export const x = 1;\n",
    "packages/hook/src/reader-a.ts": `export const isTool = (p: string) => p === "${tool("kube", "ctl")}";\n`,
    "packages/hook/src/reader-b.ts": `export const TOOLS = /^(?:${tool("he", "lm")}|${tool("terra", "form")})$/;\n`,
    "packages/mcp/src/reader-c.ts": `export const PUSH = ['${tool("push", "_files")}'];\n`,
    // A listed file may name the program only as often as the engine does.
    "packages/hook/src/typed-wrangler.ts": Array.from({ length: 3 }, () => `"${tool("wran", "gler")}";`).join("\n"),
  };
  const r = gateOver(refusedFiles);
  assert.equal(r.status, 1, r.stdout);
  for (const path of Object.keys(refusedFiles)) assert.ok(r.stderr.includes(`${path}\n`), `${path} was not refused`);
  assert.match(r.stderr, /VENDOR KNOWLEDGE/);
  assert.match(r.stderr, /PRIVATE PATH/);

  const passes = gateOver({
    "packages/hook/test/fixture.test.mjs": `const command = "${tool("kube", "ctl")} delete pod web";\nconst p = "${tool("kube", "ctl")}";\n`,
    "packages/hook/src/example.ts": 'export const EXAMPLE = ["examplectl", "rm", "git", "npm", "curl", "psql"];\n// A comment may name `' + tool("kube", "ctl") + "` in backticks.\n",
    "packages/hook/src/typed-wrangler.ts": `"${tool("wran", "gler")}";\n"${tool("wran", "gler")}";\n`,
    "packages/policy-schema/vectors/example.json": `{ "program": "${tool("kube", "ctl")}" }\n`,
  });
  assert.equal(passes.status, 0, passes.stderr);
});
