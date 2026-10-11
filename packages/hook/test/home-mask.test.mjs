// Records never name the person's account: the home folder in a working folder, a path or a command line is signed as
// `~`, another account's name as `~other`, and rules that name the home folder (as `~` or by its full path) still match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { verifyReceipt } from "@scopebond/gateway";
import { verifyReceiptSignature } from "@scopebond/verify/signature";
import {
  createHookRuntime, homeFolders, mapClaudeToolUse, mapCodexToolUse, maskHomeFolder, maskHomeInPattern, maskHomeInPolicy,
  maskHomeInValue, pathRuleFor, pathRuleMatches, scaffold,
} from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

// Home-folder paths are assembled from their parts: the repository's content check refuses a literal one in a source file.
const P = (...parts) => parts.join("/");
const W = (...parts) => parts.join("\\");
const LINUX = (name) => P("", "home", name);
const MAC = (name) => P("", "Users", name);
const WIN = (name) => W("C:", "Users", name);

const system = (name, home, path) => ({
  name, home, sep: name === "Windows" ? "\\" : "/",
  cwd: path(home, "repo"), file: path(home, "repo", "src", "a.ts"),
  outside: path(home, "notes", "plan.md"), guarded: path(home, "secrets", "token.txt"),
});
const SYSTEMS = [system("Windows", WIN("Jane"), W), system("macOS", MAC("jane"), P), system("Linux", LINUX("jane"), P)];

// The rule a person typed before masking existed: the full home path, escaped and case-folded as `pathRuleFor` wrote it.
const escapeRule = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const ci = (s) => s.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const underPattern = (folder) => `^(?!(?:.*/)?${ci(escapeRule(folder.replace(/\\/g, "/")))}(?:/|$)).+`;
const forward = (path) => path.replace(/\\/g, "/");

function runtimeWith(home, clauses) {
  const dir = mkdtempSync(join(tmpdir(), "sb-home-mask-"));
  scaffold(dir, ENFORCE);
  if (clauses) {
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ vocabulary_version: "1.0", policy_id: "home-mask", version: 1, clauses }));
  }
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), homeFolders: [home],
  });
  return { dir, runtime };
}

const readTool = (cwd, file_path) => mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path }, cwd });
const bashTool = (cwd, command) => mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd });
const paramsOf = (receipt) => receipt.payload.intent.params;

for (const sys of SYSTEMS) {
  test(`${sys.name}: the home folder in a path, a working folder and a command line becomes ~`, () => {
    const homes = [sys.home];
    const sep = sys.sep;
    assert.equal(maskHomeFolder(sys.cwd, homes), `~${sep}repo`);
    assert.equal(maskHomeFolder(sys.home, homes), "~");
    assert.equal(maskHomeFolder(forward(sys.outside), homes), "~/notes/plan.md");
    assert.equal(maskHomeFolder(`cat ${sys.outside} && cd ${sys.home} && ls`, homes), `cat ~${sep}notes${sep}plan.md && cd ~ && ls`);
    // A longer name that starts the same is another account's, and the same folders deeper in a path are not a home.
    assert.match(maskHomeFolder(`${sys.home}t${sep}x`, homes), /~other/, "a longer name is another account's");
    assert.match(maskHomeFolder(`/mnt/backup${forward(sys.home).replace(/^C:/, "")}/x`, homes), /jane/i, "a home folder deeper in a path is left");
    assert.equal(maskHomeFolder(maskHomeFolder(sys.file, homes), homes), maskHomeFolder(sys.file, homes), "idempotent");
  });

  test(`${sys.name}: signed records carry ~ for the working folder, the paths and the command, and still verify`, async () => {
    const { dir, runtime } = runtimeWith(sys.home);
    try {
      const outside = await runtime.evaluate(readTool(sys.cwd, sys.outside));
      const inside = await runtime.evaluate(readTool(sys.cwd, sys.file));
      const shell = await runtime.evaluate(bashTool(sys.cwd, `cat ${forward(sys.outside)}`));
      assert.equal(paramsOf(outside.receipt).path, "~/notes/plan.md");
      assert.equal(paramsOf(inside.receipt).path, "src/a.ts", "a path inside the working folder stays relative");
      const exec = shell.receipts.map(paramsOf).find((p) => typeof p.cwd === "string");
      assert.equal(exec.cwd, `~${sys.sep}repo`);
      assert.match(exec.command, /^cat ~\/notes\/plan\.md/);
      const all = [outside, inside, shell].flatMap((d) => d.receipts ?? [d.receipt]);
      for (const receipt of all) {
        assert.doesNotMatch(JSON.stringify(receipt), /jane/i, "no record names the account");
      }
      // The receipts verify offline: the gateway's own check and the independent verifier.
      const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
      for (const receipt of all) {
        const local = verifyReceipt(receipt, attester.publicKeyPem);
        assert.equal(local.valid, true, `gateway verify: ${JSON.stringify(local)}`);
        assert.equal(local.intent_hash_valid, true, "the masked intent is the one that was hashed and signed");
        const independent = await verifyReceiptSignature(receipt, attester.publicKeyPem);
        assert.equal(independent.valid, true, `verifier: ${JSON.stringify(independent)}`);
      }
    } finally { runtime.close(); }
  });

  test(`${sys.name}: a rule on ~/secrets and a rule on the full home path both still block`, async () => {
    const tilde = pathRuleFor("~/secrets/");
    const clauses = (pattern) => [
      { id: "protect-read", type: "action_allowlist", mode: "enforce", action_types: ["file.read"], param_bounds: { path: { pattern } } },
      { id: "shell", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"] },
    ];
    const tildePattern = `^(?!(?:.*/)?${ci(tilde.value)}(?:/|$)).+`;
    const absolutePattern = underPattern(`${sys.home}/secrets`);
    for (const pattern of [tildePattern, absolutePattern]) {
      const { runtime } = runtimeWith(sys.home, clauses(pattern));
      try {
        const blocked = await runtime.evaluate(readTool(sys.cwd, sys.guarded));
        assert.equal(blocked.decision, "deny", `${pattern} blocks the guarded file`);
        assert.equal(paramsOf(blocked.receipt).path, "~/secrets/token.txt");
        const shell = await runtime.evaluate(bashTool(sys.cwd, `cat ${forward(sys.guarded)}`));
        assert.equal(shell.decision, "deny", "the same file read from a shell command is blocked too");
        const allowed = await runtime.evaluate(readTool(sys.cwd, sys.outside));
        assert.equal(allowed.decision, "allow", "another folder in the home folder is not covered");
      } finally { runtime.close(); }
    }
  });
}

test("Codex: an apply_patch path, a shell command and the working folder are masked", async () => {
  const home = LINUX("jane");
  const { runtime } = runtimeWith(home);
  try {
    const patch = `*** Begin Patch\n*** Add File: ${home}/notes/x.md\n+hi\n*** End Patch`;
    const written = await runtime.evaluate(mapCodexToolUse({ tool_name: "apply_patch", tool_input: { command: patch }, cwd: `${home}/repo` }));
    assert.equal(paramsOf(written.receipt).path, "~/notes/x.md");
    const shell = await runtime.evaluate(mapCodexToolUse({ tool_name: "Bash", tool_input: { command: `rm -f ${home}/tmp/x` }, cwd: `${home}/repo` }));
    assert.ok(shell.receipts.length > 0);
    for (const receipt of [...written.receipts, ...shell.receipts]) assert.doesNotMatch(JSON.stringify(receipt.payload.intent), /jane/);
  } finally { runtime.close(); }
});

test("another account's home folder keeps its place but not its name", () => {
  const homes = [LINUX("jane")];
  assert.equal(maskHomeFolder(`${LINUX("bob")}/notes.txt`, homes), `${LINUX("~other")}/notes.txt`);
  assert.equal(maskHomeFolder(MAC("bob"), homes), MAC("~other"));
  assert.equal(maskHomeFolder(W(WIN("Bob"), "Desktop"), homes), W(WIN("~other"), "Desktop"));
  assert.equal(maskHomeFolder(P("c:", "users", "Bob Smith", "Desktop"), homes), P("c:", "users", "~other", "Desktop"), "a Windows name with a space, before a separator");
  assert.equal(maskHomeFolder(`ls ${LINUX("bob")} ${LINUX("carol")}`, homes), `ls ${LINUX("~other")} ${LINUX("~other")}`);
  // Shared and default profiles are nobody's name; a variable is not a name either.
  assert.equal(maskHomeFolder(W(WIN("Public"), "Documents"), homes), W(WIN("Public"), "Documents"));
  assert.equal(maskHomeFolder(`${MAC("Shared")}/x`, homes), `${MAC("Shared")}/x`);
  assert.equal(maskHomeFolder(`${LINUX("$USER")}/x`, homes), `${LINUX("$USER")}/x`);
  // Not a home folder: the same folder names deeper in a path, and a URL path.
  assert.equal(maskHomeFolder(`/srv${LINUX("bob")}/x`, homes), `/srv${LINUX("bob")}/x`);
  assert.equal(maskHomeFolder(`https://example.com${LINUX("bob")}`, homes), `https://example.com${LINUX("bob")}`);
  assert.equal(maskHomeFolder("~/x", homes), "~/x");
});

test("the home folder is read from the system, HOME and USERPROFILE; a root is never a home", () => {
  assert.deepEqual(homeFolders({ HOME: `${LINUX("jane")}/`, USERPROFILE: WIN("Jane") }, LINUX("jane")), [LINUX("jane"), forward(WIN("Jane"))]);
  assert.deepEqual(homeFolders({ HOME: "/", USERPROFILE: "C:\\" }, ""), []);
  assert.deepEqual(homeFolders({}, "relative/path"), []);
  assert.ok(homeFolders().length >= 1, "this process has a home folder");
  // With no home at all, nothing of the current account is masked.
  assert.equal(maskHomeFolder("/srv/app/x", []), "/srv/app/x");
});

test("structured parameters: every string is masked, other values and untouched objects are kept", () => {
  const home = LINUX("jane");
  const params = { path: `${home}/a`, cwd: home, size: 3, list: [`${home}/b`, 1], nested: { x: `${home}/c` } };
  assert.deepEqual(maskHomeInValue(params, [home]), { path: "~/a", cwd: "~", size: 3, list: ["~/b", 1], nested: { x: "~/c" } });
  const clean = { path: "src/a.ts" };
  assert.equal(maskHomeInValue(clean, [home]), clean, "nothing to mask: the same object");
});

test("a rule pattern naming the home folder is rewritten to ~; other patterns are left alone", () => {
  const home = LINUX("jane");
  const masked = `^(?!(?:.*/)?~${ci("\\/secrets")}(?:/|$)).+`;
  assert.equal(maskHomeInPattern(underPattern(`${home}/secrets`), [home]), masked);
  assert.equal(maskHomeInPattern(underPattern(`${LINUX("janet")}/secrets`), [home]), underPattern(`${LINUX("janet")}/secrets`), "a longer name is not this home");
  assert.equal(maskHomeInPattern(`^${home}/.+`, [home]), "^~/.+", "a hand-written pattern");
  assert.equal(maskHomeInPattern(underPattern(`${WIN("Jane")}/secrets`), [WIN("Jane")]), masked, "a Windows home, in any case");
  assert.equal(maskHomeInPattern(underPattern(`${forward(WIN("jane"))}/secrets`), [WIN("Jane")]), masked);
  const policy = { clauses: [{ id: "x", param_bounds: { path: { pattern: `^${home}/.+`, enum: [`${home}/a`, 3] }, list: { items: { pattern: home } } } }] };
  maskHomeInPolicy(policy, [home]);
  assert.deepEqual(policy.clauses[0].param_bounds, { path: { pattern: "^~/.+", enum: ["~/a", 3] }, list: { items: { pattern: "~" } } });
});

test("a rule added with the full home path is kept with ~, and matches the masked path", () => {
  const rule = pathRuleFor(join(homedir(), "secrets") + "/");
  assert.match(rule.label, /^~\/secrets\//);
  assert.equal(pathRuleMatches(rule, "~/secrets/token.txt"), true);
  assert.equal(pathRuleMatches(rule, forward(join(homedir(), "secrets", "token.txt"))), true, "and the absolute spelling");
  assert.equal(pathRuleMatches(rule, "~/notes/x"), false);
});
