// A command that cannot be read is treated as switching Scopebond off when it names Scopebond. Two things made that too broad:
// the POSIX quote-splicing idiom ('"'"') inside a command substitution inside double quotes made a readable command unreadable,
// and any text containing the word (a repository name, a checkout folder, the website) counted as naming Scopebond itself.
// Each allow case below was denied before; each deny case must stay denied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold, createHookRuntime, mapClaudeToolUse, decomposeShell, useDigestKey } from "../dist/index.js";

useDigestKey("45".repeat(32));

const base = mkdtempSync(join(tmpdir(), "sb-opaque-name-"));
const HOME = join(base, "home");
const REPO = join(base, "repo");
mkdirSync(join(HOME, ".scopebond"), { recursive: true });
mkdirSync(REPO, { recursive: true });
const sb = join(base, "sb");
scaffold(sb, {}); // Monitor by default: only the always-on floor is in force.
const rt = createHookRuntime({
  policyPath: join(sb, "policy.json"), keyPath: join(sb, "agent.key"), attesterPath: join(sb, "attester.key"),
  dbPath: join(sb, "receipts.db"), cwd: REPO, homeFolders: [HOME],
});
test.after(() => { rt.close(); rmSync(base, { recursive: true, force: true, maxRetries: 5 }); });

const bash = (command) => mapClaudeToolUse({ cwd: REPO, tool_name: "Bash", tool_input: { command } });
const isOpaque = (m) => m.intent.action_type === "shell.exec" && m.intent.params.program === "";
const switchesOff = (m) => m.intent.action_type === "file.write" && m.intent.params.path === ".scopebond/policy.json";

const SPLICED = `gh pr create --repo acme/scopebond-docs --title x --body "$(printf '%s\\n' 'it'"'"'s')"`;

test("'\"'\"' inside a command substitution inside double quotes reads as one word, not an unreadable command", () => {
  const commands = decomposeShell(SPLICED);
  assert.ok(!commands.some((c) => c.opaque), JSON.stringify(commands));
  const printf = commands.find((c) => c.program === "printf");
  assert.deepEqual(printf?.argv, ["%s\\n", "it's"]);
  assert.equal(commands.find((c) => c.program === "gh")?.argv[3], "acme/scopebond-docs");
  // The same splice nested one level deeper, and a quoted `)` inside a substitution.
  for (const command of [`echo "$(echo "$(echo 'a'"'"'b')")"`, `echo "$(echo ")")"`, `echo $(echo 'a'"'"'b')`]) {
    assert.ok(!decomposeShell(command).some((c) => c.opaque), command);
  }
  // A substitution that never closes is still unreadable.
  assert.ok(decomposeShell(`echo "$(echo 'a'"'"'b'"`).some((c) => c.opaque));
});

test("the spliced pull-request command is allowed", async () => {
  const mapped = bash(SPLICED);
  assert.ok(!mapped.some(isOpaque));
  assert.ok(!mapped.some(switchesOff));
  const d = await rt.evaluate(mapped);
  assert.equal(d.decision, "allow", `${d.decision} ${d.clauseId ?? ""}`);
});

// Unreadable commands (a program only known at run time) that contain the word only inside the name of something else.
for (const command of [
  `eval "$X acme/scopebond-docs"`,
  `eval "$X https://github.com/acme/scopebond-examples.git"`,
  `eval "$X https://scopebond.com/docs"`,
  `eval "$X https://api.scopebond.com/v1/status"`,
  `eval "$X acme/scopebond"`,
  `eval "$X github.com/acme/scopebond.git"`,
  `eval "$X ~/code/acme/scopebond"`,
  `eval "$X ~/code/acme/scopebond/README.md"`,
  `bash -c "$Y --repo acme/scopebond-docs"`,
]) {
  test(`an unreadable command naming something else is allowed: ${command}`, async () => {
    const mapped = bash(command);
    assert.ok(mapped.some(isOpaque), "the command is unreadable");
    assert.ok(!mapped.some(switchesOff));
    const d = await rt.evaluate(mapped);
    assert.equal(d.decision, "allow", `${d.decision} ${d.clauseId ?? ""}`);
  });
}

// Unreadable commands that do name Scopebond itself: its folder, programs, packages, launchd labels, install folders, settings.
for (const command of [
  `eval "$X ~/.scopebond/policy.json"`,
  `eval "$X $HOME/.scopebond"`,
  `eval "$(echo scopebond-agent autostart off)"`,
  `bash -c "$Y @scopebond/hook uninstall"`,
  `eval "$X scopebond off"`,
  `eval "$X Scopebond"`,
  `eval "$X npx -y @scopebond/agent stop"`,
  `eval "$X scopebond-hook init --force"`,
  `eval "$X scopebond-tray"`,
  `eval "$X pkill -f scopebond-ag"`,
  `eval "$X pkill -f scopebond-a.ent"`,
  `eval "$X pkill -f 'scopebond-*'"`,
  `eval "$X launchctl bootout gui/501/com.scopebond.agent"`,
  `eval "$X '/Library/Application Support/Scopebond/uninstall.sh'"`,
  `eval "$X C:/Program Files/Scopebond/scopebond-agent.exe"`,
  `eval "$X $LOCALAPPDATA/Programs/Scopebond"`,
  `eval "$X ~/code/acme/scopebond/node_modules/.bin/scopebond off"`,
  `eval "$X ~/code/acme/scopebond/.scopebond/policy.json"`,
  `eval "$X ~/scopebond"`,
  `eval "$X $HOME/scopebond"`,
  `eval "$X SCOPEBOND_HOME=/tmp/elsewhere"`,
  `eval "$X Avouro.Scopebond"`,
  `eval "$X .claude/settings.json.scopebond-backup"`,
  `eval "$X .github/hooks/scopebond.json"`,
  `eval "$X SCOPEB~1"`,
  `eval "$X scopebond-{docs,agent}"`,
  `eval "$X scopebond-docs$Y"`,
  `eval "$X scopebond.com.example"`,
]) {
  test(`an unreadable command naming Scopebond itself is still denied: ${command}`, async () => {
    const mapped = bash(command);
    assert.ok(mapped.some(isOpaque), "the command is unreadable");
    const d = await rt.evaluate(mapped);
    assert.equal(d.decision, "deny", `${d.decision} ${d.clauseId ?? ""}`);
    assert.match(String(d.clauseId), /^protect-scopebond-(read|write)$/);
  });
}
