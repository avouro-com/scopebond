// A command that only prints its help or version, or rehearses (`--help`, `-h` alone, `--version`, `--dry-run`, a `help`
// subcommand), changes nothing: it is recorded, never refused as the destructive program or push it names. Read generically,
// the way the program itself would: a POSIX program reads its options up to its first operand, `-h` counts only on its own
// (`shutdown -h` halts), and an option's value is never taken for one of these.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { mapClaudeToolUse, createHookRuntime, scaffold, fillPushBranch, derivePackTargets } from "../dist/index.js";
import { decomposeShell } from "../dist/shell.js";
import { ENFORCE } from "./enforce-all.mjs";

const dir = mkdtempSync(join(tmpdir(), "sb-hook-describe-"));
scaffold(dir, ENFORCE);
const rt = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: ":memory:" });
after(() => rt.close());

const decide = async (tool, command) => (await rt.evaluate(fillPushBranch(mapClaudeToolUse({ tool_name: tool, tool_input: { command } }), "feature/work"))).decision;

const DESCRIBES = [
  "rm --help",
  "rm --version",
  "rm -h",
  "rm -i --help",
  "shred --help",
  "truncate --version",
  "dd --help",
  "sudo --help",
  "git push --dry-run origin main",
  "git push origin main --dry-run",
  "git push --force --dry-run origin main",
  "git push --help",
  "git push --dry-run=true origin main",
  "cd repo && git push --dry-run origin main",
];

for (const command of DESCRIBES) {
  test(`only describes or rehearses, so it is not refused: ${command}`, async () => {
    assert.notEqual(await decide("Bash", command), "deny", command);
  });
}

test("the command is still recorded, with its program", () => {
  const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "rm --help" } });
  assert.deepEqual(mapped.map((m) => [m.intent.action_type, m.intent.params.program]), [["shell.exec", "rm"]]);
});

const STILL_REFUSED = [
  // `-h` is help only on its own: `shutdown -h` halts.
  "shutdown -h now",
  "shutdown -h",
  "halt -h",
  // A POSIX program stops reading options at its first operand: there `--help` is a file to remove (BSD rm).
  "rm -rf ../build --help",
  "rm -- ../--help",
  "rm ../help",
  // An option's value is not one of its own options.
  "git push -o --dry-run origin main",
  "git push --repo --dry-run origin main",
  "git push origin main -- --dry-run",
  "git push --dry-run=false origin main",
  "git push --dry-run=none origin main",
  // A program after a wrapper's own help is still judged.
  "sudo --help rm -rf /",
  "rm -rf ../x; git --help",
];

for (const command of STILL_REFUSED) {
  test(`still refused: ${command}`, async () => {
    assert.equal(await decide("Bash", command), "deny", command);
  });
}

test("in PowerShell `rm --help` is Remove-Item given a path named --help: still refused", async () => {
  assert.equal(await decide("PowerShell", "rm --help"), "deny");
  assert.equal(await decide("PowerShell", "Remove-Item --help"), "deny");
  assert.notEqual(await decide("PowerShell", "git push --dry-run origin main"), "deny");
});

// A rule pack's grammar without its own `skip` list: the generic reading still derives nothing from help or a dry run.
const require = createRequire(import.meta.url);
const example = JSON.parse(require("node:fs").readFileSync(require.resolve("@scopebond/policy-schema/vectors/example-pack.json"), "utf8"));
const bare = structuredClone(example);
for (const g of bare.grammars) delete g.skip;
const derive = (command) => decomposeShell(command).flatMap((sc) => derivePackTargets(sc, {}, [bare]).map((a) => a.action_type));

test("a pack-read command that only describes or rehearses derives nothing, even without the grammar's own skip list", () => {
  assert.deepEqual(derive("examplectl bucket delete ex://x"), ["cloud.resource.delete"], "the command itself is read");
  for (const command of [
    "examplectl bucket delete ex://x --help",
    "examplectl --help bucket delete ex://x",
    "examplectl bucket delete ex://x --dry-run",
    "examplectl bucket delete ex://x --dry-run=client",
    "examplectl help bucket delete",
    "examplectl -h",
    "examplectl --version",
  ]) assert.deepEqual(derive(command), [], command);
});

test("a pack-read command whose help-looking word is something else is still read", () => {
  for (const command of [
    "examplectl bucket delete ex://x --dry-run=none",
    "examplectl bucket delete ex://x --dry-run=false",
    // The value of an option the grammar knows takes a value.
    "examplectl bucket delete ex://x --profile --help",
    // `--version` is a version only with nothing else to do; `-h` only on its own.
    "examplectl bucket delete ex://x --version",
    "examplectl bucket delete ex://x -h",
    // After `--`, words are operands.
    "examplectl bucket delete ex://x -- --help",
  ]) assert.deepEqual(derive(command), ["cloud.resource.delete"], command);
});
