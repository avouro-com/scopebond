// The safe-shell rule judges what a delete reaches, not only the program: a delete whose every target is inside the
// working folder (or is build output, or under the temp folder) runs; anything else that deletes is refused as before.
// Every row is a real signed decision under the starter policy with every rule blocking.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, createHookRuntime, mapClaudeToolUse, compile, defaultRules, starterPolicy } from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const dirs = [];
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* a handle still open on Windows */ } } });

function runtimeAt(cwd, policy) {
  const dir = mkdtempSync(join(tmpdir(), "sb-delete-"));
  dirs.push(dir);
  scaffold(dir, ENFORCE);
  if (policy) writeFileSync(join(dir, "policy.json"), JSON.stringify(policy(JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")))));
  return createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd });
}

const POSIX = "/repo";
const WINDOWS = "C:\\GitHub\\repo";
const posix = runtimeAt(POSIX);
const windows = runtimeAt(WINDOWS);
after(() => { posix.close(); windows.close(); });

const decide = async (command, tool = "Bash") => {
  const cwd = tool === "PowerShell" ? WINDOWS : POSIX;
  const d = await (tool === "PowerShell" ? windows : posix).evaluate(mapClaudeToolUse({ tool_name: tool, tool_input: { command }, cwd }));
  return d.decision === "deny" ? "deny" : "allow";
};

// [command, tool, expected]
const TABLE = [
  // Everyday cleanups inside the working folder.
  ["rm -rf node_modules", "Bash", "allow"],
  ["rm -rf dist build .next coverage target", "Bash", "allow"],
  ["Remove-Item -Recurse -Force node_modules", "PowerShell", "allow"],
  ["rm -f package-lock.json", "Bash", "allow"],
  ["rm -rf ./tmp/cache", "Bash", "allow"],
  ["cd packages/web && rm -rf build", "Bash", "allow"],
  ["rm -rf /tmp/x", "Bash", "allow"],
  ["del /s /q dist", "Bash", "allow"],
  ["rmdir /s /q node_modules", "Bash", "allow"],
  ["rm -rf .turbo .cache tmp *.log", "Bash", "allow"],
  ["rm -rf .claude/worktrees/feature-x", "Bash", "allow"],
  ["Remove-Item -Recurse -Force dist, build -ErrorAction SilentlyContinue", "PowerShell", "allow"],
  ["Remove-Item -LiteralPath coverage -Recurse", "PowerShell", "allow"],
  ["Remove-Item -Recurse $env:TEMP\\sb-test", "PowerShell", "allow"],
  ["rm -rf $TMPDIR/build-cache", "Bash", "allow"],
  ["rm -rf dist/* packages/*/dist", "Bash", "allow"],
  ["rm -rf /repo/dist", "Bash", "allow"],
  ["RM.EXE -rf node_modules", "Bash", "allow"],
  ["rm -rf {dist,build}", "Bash", "allow"],
  ["rm .env.example", "Bash", "allow"],
  ["cd notes/.. && rm -rf notes", "Bash", "allow"],
  // Outside the working folder, the folder itself, or a protected place.
  ["rm -rf ../other-repo", "Bash", "deny"],
  ["rm -rf ~", "Bash", "deny"],
  ["rm -rf /", "Bash", "deny"],
  ["rm -rf C:/GitHub", "Bash", "deny"],
  ["rm -rf .git", "Bash", "deny"],
  ["rm -f .git/index.lock", "Bash", "deny"],
  ["rm -rf .", "Bash", "deny"],
  ["rm -rf ./", "Bash", "deny"],
  ["rm -rf *", "Bash", "deny"],
  ["rm -rf ./*", "Bash", "deny"],
  ["rm -rf .*", "Bash", "deny"],
  ["rm -rf /repo", "Bash", "deny"],
  ["rm -rf /tmp", "Bash", "deny"],
  ["rm -rf /tmp/*", "Bash", "deny"],
  ["Remove-Item -Recurse C:\\Users\\x", "PowerShell", "deny"],
  ["Remove-Item -Recurse -Force .", "PowerShell", "deny"],
  ["del /s /q *.*", "Bash", "deny"],
  ["rm -rf .env", "Bash", "deny"],
  ["rm -f secrets/deploy.pem", "Bash", "deny"],
  ["rm -rf .scopebond", "Bash", "deny"],
  ["rm -rf .github", "Bash", "deny"],
  ["rm .github/workflows/ci.yml", "Bash", "deny"],
  ["rm -rf dist ~/.ssh", "Bash", "deny"],
  ["cd .. && rm -rf x", "Bash", "deny"],
  ["cd ~ && rm -rf .cache/x", "Bash", "deny"],
  ["cd && rm -rf x", "Bash", "deny"],
  ["cd / && rm -rf tmp", "Bash", "deny"],
  ["cd sub && rm -rf ../../x", "Bash", "deny"],
  ["rm -rf dist\\..\\..\\x", "Bash", "deny"],
  ["cd ..\\.. && rm -rf x", "Bash", "deny"],
  // Targets known only at run time, or none.
  ["rm -rf $BUILD_DIR", "Bash", "deny"],
  ["rm -rf \"$(pwd)/dist\"", "Bash", "deny"],
  ["rm -rf `pwd`/dist", "Bash", "deny"],
  ["for d in a b; do rm -rf \"$d\"; done", "Bash", "deny"],
  ["find . -name '*.tmp' -exec rm -rf {} +", "Bash", "deny"],
  ["ls | xargs rm -rf", "Bash", "deny"],
  ["echo / | xargs rm -rf dist", "Bash", "deny"],
  ["parallel rm -rf dist ::: /", "Bash", "deny"],
  ["env -C / rm -rf tmp", "Bash", "deny"],
  ["rm -rf", "Bash", "deny"],
  ["Get-ChildItem *.log | Remove-Item", "PowerShell", "deny"],
  ["Remove-Item @('/')", "PowerShell", "deny"],
  ["Remove-Item (Join-Path $HOME x)", "PowerShell", "deny"],
  ["alias rm='rm -rf /'\nrm x", "Bash", "deny"],
  ["Remove-Item -Recurse HKCU:\\Software\\x", "PowerShell", "deny"],
  ["Set-Location HKLM:\\Software; Remove-Item -Recurse x", "PowerShell", "deny"],
  ["pushd +1 && rm -rf x", "Bash", "deny"],
  // Not deletes of files: blocked whatever their arguments.
  ["sudo rm -rf node_modules", "Bash", "deny"],
  ["rm -rf node_modules && sudo reboot", "Bash", "deny"],
  ["shred -u notes.txt", "Bash", "deny"],
  ["dd if=/dev/zero of=out.bin", "Bash", "deny"],
  ["truncate -s 0 app.log", "Bash", "deny"],
  ["Clear-Content app.log", "PowerShell", "deny"],
];

test("safe-shell allows a delete only when every target is contained", async () => {
  const wrong = [];
  for (const [command, tool, expected] of TABLE) {
    const actual = await decide(command, tool);
    if (actual !== expected) wrong.push(`${tool}: ${JSON.stringify(command)} -> ${actual} (expected ${expected})`);
  }
  assert.deepEqual(wrong, []);
});

test("a contained delete keeps its program and carries the scope safe-shell judges", () => {
  const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "rm -rf node_modules" }, cwd: POSIX });
  const exec = mapped.find((m) => m.intent.action_type === "shell.exec");
  assert.equal(exec.intent.params.program, "rm");
  assert.equal(exec.intent.params.program_scope, "rm/contained");
  assert.ok(mapped.some((m) => m.intent.action_type === "file.write" && m.intent.params.path === "node_modules"), "the target is recorded as a write");
  const outside = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "rm -rf ../x" }, cwd: POSIX }).find((m) => m.intent.action_type === "shell.exec");
  assert.equal(outside.intent.params.program_scope, "rm");
  const other = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: POSIX }).find((m) => m.intent.action_type === "shell.exec");
  assert.equal(other.intent.params.program_scope, "ls");
});

test("a shell intent built without program_scope is judged by its program", async () => {
  const intent = (program) => ({ intent: { action_type: "shell.exec", params: { command: `${program} x`, program } }, evaluated: true, source: "test" });
  assert.equal((await posix.evaluate(intent("rm"))).decision, "deny");
  assert.equal((await posix.evaluate(intent("ls"))).decision, "allow");
});

test("a policy written before program_scope existed is read with the new bound", async () => {
  const old = runtimeAt(POSIX, (policy) => {
    const clause = policy.clauses.find((c) => c.id === "safe-shell");
    clause.param_bounds = { program: clause.param_bounds.program_scope };
    return policy;
  });
  try {
    const run = async (command) => (await old.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: POSIX }))).decision;
    assert.equal(await run("rm -rf node_modules"), "allow");
    assert.equal(await run("rm -rf /"), "deny");
  } finally { old.close(); }
});

test("the rule's description says what a delete may still do, and only for the deleters on the list", () => {
  const clause = (programs) => compile({ ...defaultRules(), destructive_programs: programs }, "k").clauses.find((c) => c.id === "safe-shell");
  assert.match(clause(defaultRules().destructive_programs).description, /is allowed when every target it names is inside the working folder/);
  assert.match(clause(["rm", "sudo"]).description, /A delete \(rm\) is allowed/);
  assert.doesNotMatch(clause(["sudo", "dd"]).description, /A delete/);
  assert.match(starterPolicy("k").clauses.find((c) => c.id === "safe-shell").description, /inside the working folder/);
});

test("judging a delete stays fast on long, adversarial input", () => {
  for (const command of [
    `rm -rf ${"[".repeat(50_000)}`,
    `rm -rf ${"/".repeat(50_000)}x`,
    `cd ${"/".repeat(50_000)}x && rm -rf build`,
    `rm -rf ${"a/".repeat(25_000)}`,
    `del ${"/a".repeat(25_000)} dist`,
    `rm -rf ${"*?".repeat(25_000)}.log`,
    `Remove-Item ${"dist,".repeat(10_000)}`,
  ]) {
    const started = Date.now();
    mapClaudeToolUse({ tool_name: "Bash", tool_input: { command }, cwd: POSIX });
    assert.ok(Date.now() - started < 3000, `${command.slice(0, 20)}… took ${Date.now() - started} ms`);
  }
});

test("a deleter removed from the list is not judged by its targets either", async () => {
  const rules = { ...defaultRules(), ...ENFORCE, destructive_programs: defaultRules().destructive_programs.filter((p) => p !== "rm") };
  const rt = runtimeAt(POSIX, (policy) => compile(rules, policy.clauses.find((c) => c.type === "key_policy").active_keys[0]));
  try {
    const d = await rt.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "rm -rf ../elsewhere" }, cwd: POSIX }));
    assert.equal(d.decision, "allow");
  } finally { rt.close(); }
});

test("a delete that reaches outside the working folder records where, for a workspace's exception to compare", () => {
  const targets = (command, tool = "Bash", cwd = POSIX) => [mapClaudeToolUse({ tool_name: tool, tool_input: { command }, cwd })].flat()
    .find((m) => m.intent.action_type === "shell.exec").intent.params.delete_targets;
  assert.deepEqual(targets("rm -rf ~/scratch/a/../b"), ["~/scratch/b"]);
  assert.deepEqual(targets("rm -rf dist ../shared/cache /srv/x"), ["/shared/cache", "/srv/x"], "a contained target needs no exception and is left out");
  assert.deepEqual(targets("Remove-Item -Recurse -Force C:\\Builds\\old", "PowerShell", WINDOWS), ["c:/Builds/old"]);
  // Nothing an exception could rely on: a protected place, a root, a wildcard, a value known only at run time, another account.
  for (const command of ["rm -rf ~/.ssh", "rm -rf ~/x/../.scopebond", "rm -rf /", "rm -rf ~", "rm -rf ~/x/*", "rm -rf ~/$X", "rm -rf ~other/x", "rm -rf ~/x ~/.aws", "rm -rf dist"]) {
    assert.equal(targets(command), undefined, command);
  }
});
