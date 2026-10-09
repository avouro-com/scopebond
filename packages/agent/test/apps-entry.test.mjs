// An npm install is listed in Windows Settings -> Apps; its Uninstall runs the agent's own uninstall, then npm's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appsEntryValues, psQuote, uninstallScript, writeUninstallScript, writeAppsEntry, removeAppsEntry, UNINSTALL_KEY } from "../dist/index.js";

test("the entry names Scopebond, Avouro LLC and the version, and its Uninstall runs the script with no administrator rights", () => {
  const values = Object.fromEntries(appsEntryValues({ version: "0.5.3", script: "C:\\Users\\Ann\\.scopebond\\uninstall-agent.ps1", home: "C:\\Users\\Ann\\.scopebond" }).map(([n, t, d]) => [n, { t, d }]));
  assert.equal(UNINSTALL_KEY, "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ScopebondAgent", "per user: no administrator rights");
  assert.deepEqual(values.DisplayName, { t: "REG_SZ", d: "Scopebond Agent" });
  assert.deepEqual(values.Publisher, { t: "REG_SZ", d: "Avouro LLC" });
  assert.deepEqual(values.DisplayVersion, { t: "REG_SZ", d: "0.5.3" });
  assert.equal(values.UninstallString.d, 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\Ann\\.scopebond\\uninstall-agent.ps1"');
  assert.match(values.QuietUninstallString.d, /-WindowStyle Hidden -File "/);
  assert.deepEqual([values.NoModify, values.NoRepair], [{ t: "REG_DWORD", d: "1" }, { t: "REG_DWORD", d: "1" }]);
});

test("a quoted path doubles every quote PowerShell ends a single-quoted string at, ASCII and typographic, and nothing else", () => {
  assert.equal(psQuote("D:\\Apps\\O'Brien\\cli.js"), "'D:\\Apps\\O''Brien\\cli.js'");
  // U+2018, U+2019, U+201A and U+201B are single quotes to PowerShell as well.
  assert.equal(psQuote("O\u2019Brien"), "'O\u2019\u2019Brien'");
  assert.equal(psQuote("a\u2018b\u2019c\u201Ad\u201Be'f"), "'a\u2018\u2018b\u2019\u2019c\u201A\u201Ad\u201B\u201Be''f'");
  // Double quotes, dollars and backticks mean nothing inside single quotes: left as they are.
  assert.equal(psQuote('D:\\Apps\\$x `y "z" \u201Cw\u201D'), "'D:\\Apps\\$x `y \"z\" \u201Cw\u201D'");
});

test("the script runs the agent's uninstall, then npm's, then removes the entry; paths are data, quotes doubled", () => {
  const script = uninstallScript({
    node: "C:\\Program Files\\nodejs\\node.exe",
    cli: "D:\\Apps\\O'Brien\u2019s\\npm\\node_modules\\@scopebond\\agent\\dist\\cli.js",
    npm: "C:\\Program Files\\nodejs\\npm.cmd",
  });
  assert.ok(script.includes("$cli = 'D:\\Apps\\O''Brien\u2019\u2019s\\npm"), script);
  const agent = script.indexOf("$cli uninstall");
  const npm = script.indexOf("& $npm uninstall -g @scopebond/agent");
  const entry = script.indexOf("reg.exe delete 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ScopebondAgent' /f");
  assert.ok(agent > 0 && npm > agent && entry > npm, "agent uninstall, then npm, then the entry");
  assert.ok(script.includes("$cli uninstall\n"), "the Scopebond folder stays unless the person asks (no --purge)");
  assert.doesNotMatch(script, /Invoke-Expression|iex /);
});

test("the script says removed only when the agent's uninstall ran and succeeded; otherwise it says why and exits 1", () => {
  const script = uninstallScript({ node: "C:\\n\\node.exe", cli: "D:\\Apps\\cli.js", npm: "C:\\n\\npm.cmd" });
  // A missing agent is said, not skipped silently.
  assert.match(script, /if \(-not \(Test-Path -LiteralPath \$cli\)\) \{\n {2}\$problems \+= "The agent is not at \$cli, so its own uninstall did not run/);
  // The agent's exit code decides.
  assert.match(script, /if \(\$LASTEXITCODE -eq 0\) \{ \$agentRan = \$true \}\n {4}else \{ \$problems \+= "The agent's own uninstall stopped with exit code \$LASTEXITCODE/);
  // npm's uninstall runs after a successful agent uninstall, or when the agent is already gone, never after a failure
  // (the package stays so the uninstall can be run again).
  assert.match(script, /if \(\$agentRan -or -not \(Test-Path -LiteralPath \$cli\)\) \{\n {2}try \{\n {4}& \$npm uninstall -g @scopebond\/agent/);
  // "removed" is said only with no problems, and the script ends with exit 1 otherwise.
  const removed = script.indexOf("Write-Host 'The Scopebond Agent is removed.'");
  assert.ok(removed > script.indexOf("if ($problems.Count -eq 0) {"));
  assert.ok(script.indexOf("exit 0") > removed);
  assert.match(script, /Write-Host 'The Scopebond Agent is not fully removed:'\n[^\n]*\n[^\n]*\nexit 1\n$/);
});

test("the script is written as UTF-8 with a byte-order mark, so Windows PowerShell 5.1 reads non-ASCII paths as written", () => {
  const home = mkdtempSync(join(tmpdir(), "sb-apps-entry-"));
  const cli = "D:\\Apps\\J\u00F6rg M\u00FCller\\npm\\node_modules\\@scopebond\\agent\\dist\\cli.js";
  const path = writeUninstallScript(home, { node: "C:\\n\\node.exe", cli, npm: "C:\\n\\npm.cmd" });
  const bytes = readFileSync(path);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(bytes.subarray(3).toString("utf8").includes(`$cli = '${cli}'`));
  assert.equal(bytes.subarray(3).toString("utf8").charCodeAt(0), "#".charCodeAt(0), "one mark, not two");
});

// Runs the script the way Windows does (Windows PowerShell 5.1), from a folder whose name has a space, non-ASCII letters
// and a typographic apostrophe, with a stand-in agent and npm. The registry key is one that does not exist.
test("Windows PowerShell runs the script from a non-ASCII folder: removed only when it worked, exit 1 otherwise", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "sb-apps-run-"));
  const person = join(root, "J\u00F6rg O\u2019Br\u00EFen");
  const home = join(person, ".scopebond");
  const pkg = join(person, "npm", "node_modules", "@scopebond", "agent", "dist");
  mkdirSync(home, { recursive: true });
  mkdirSync(pkg, { recursive: true });
  const cli = join(pkg, "cli.js");
  const npm = join(person, "npm", "npm.cmd");
  const agentRan = join(person, "agent-ran.txt");
  const npmRan = join(person, "npm", "npm-ran.txt");
  const fakeCli = `require("node:fs").writeFileSync(${JSON.stringify(agentRan)}, process.argv.slice(2).join(" "));\nprocess.exit(Number(process.env.FAKE_AGENT_EXIT || 0));\n`;
  writeFileSync(npm, "@echo off\r\necho %*> \"%~dp0npm-ran.txt\"\r\nexit /b 0\r\n");
  const run = (agentExit) => {
    for (const f of [agentRan, npmRan]) rmSync(f, { force: true });
    const script = writeUninstallScript(home, { node: process.execPath, cli, npm, key: "HKCU\\Software\\ScopebondTest\\NoSuchEntry" });
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      encoding: "utf8", env: { ...process.env, SCOPEBOND_NO_PAUSE: "1", FAKE_AGENT_EXIT: String(agentExit) }, timeout: 120_000,
    });
    const read = (f) => existsSync(f) ? readFileSync(f, "utf8").trim() : "";
    return { code: r.status, out: `${r.stdout}${r.stderr}`, agent: read(agentRan), npm: read(npmRan) };
  };

  writeFileSync(cli, fakeCli);
  const ok = run(0);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(ok.agent, "uninstall", ok.out);
  assert.equal(ok.npm, "uninstall -g @scopebond/agent", ok.out);
  assert.match(ok.out, /The Scopebond Agent is removed\./);

  const failed = run(3);
  assert.equal(failed.code, 1, failed.out);
  assert.equal(failed.agent, "uninstall");
  assert.equal(failed.npm, "", "the package stays so the uninstall can be run again");
  assert.match(failed.out, /exit code 3/);
  assert.doesNotMatch(failed.out, /is removed\./);

  rmSync(cli);
  const missing = run(0);
  assert.equal(missing.code, 1, missing.out);
  assert.equal(missing.agent, "");
  assert.equal(missing.npm, "uninstall -g @scopebond/agent", "npm's uninstall still runs");
  assert.match(missing.out, /its own uninstall did not run/);
  assert.doesNotMatch(missing.out, /is removed\./);
});

test("off Windows there is no entry to write or remove", () => {
  assert.equal(writeAppsEntry("/tmp/x", { version: "1.0.0", cli: "/x/cli.js" }, "linux"), null);
  assert.equal(removeAppsEntry("/tmp/x", "darwin"), null);
});
