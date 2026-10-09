// Secrets typed into PowerShell, or carried in a URL whose password holds an "@", are removed from what a receipt
// records (the shell.exec command head, a git.push remote), whatever the spelling: an environment variable set through
// the Env: drive, .NET or setx, a plain variable or hashtable entry, a plain-text secure string in any parameter order or
// piped in, and URL userinfo up to its last "@". Ordinary values of the same commands stay readable, a setter's value is
// not taken for a file it writes, and a scrubbed path still shows where it leads. Every secret is built at run time (no
// literal token in this file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate every home-like location before the hook is loaded (one test runs the hook with the shipped starter policy).
const SANDBOX = mkdtempSync(join(tmpdir(), "sb-shell-secrets-"));
for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SCOPEBOND_HOME", "XDG_CONFIG_HOME"]) process.env[k] = join(SANDBOX, "home");
mkdirSync(join(SANDBOX, "home"), { recursive: true });
const { createHookRuntime, mapClaudeToolUse, scaffold, scrubParam, scrubSecrets, redactCommand, useDigestKey } = await import("../dist/index.js");

useDigestKey("33".repeat(32));

let seed = 0x5ec2e7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
const ALNUM = "ghijkmnpqrstuvwxyzGHJKLMNPQRSTUVWXYZ0123456789";
const secret = (n = 14) => "Qz" + Array.from({ length: n }, () => ALNUM[rnd() % ALNUM.length]).join("");

const mapped = (command, tool) => mapClaudeToolUse({ tool_name: tool, tool_input: { command }, cwd: "/repo" });
const recorded = (command, tool) => JSON.stringify(mapped(command, tool).map((m) => m.intent.params));

/** Neither the whole value nor any 8-character piece of it is left in the scrubbed text or the mapped receipt params
 *  (with `commandsOnly`, the recorded command texts). */
function assertGone(command, value, tool = "PowerShell", commandsOnly = false) {
  const params = commandsOnly ? JSON.stringify(mapped(command, tool).map((m) => m.intent.params.command ?? "")) : recorded(command, tool);
  for (const [label, out] of [["scrubSecrets", scrubSecrets(command)], ["redactCommand", redactCommand(command, 4096)], ["receipt params", params]]) {
    for (let i = 0; i + 8 <= value.length; i++) {
      assert.ok(!out.includes(value.slice(i, i + 8)), `${label} kept part of the secret of ${JSON.stringify(command.replace(value, "<SECRET>"))}: ${out.split(value).join("<SECRET>")}`);
    }
  }
}

test("a secret set as a PowerShell environment variable without '=' is removed", () => {
  for (const make of [
    (s) => `Set-Item Env:DB_PASSWORD '${s}'`,
    (s) => `Set-Item -Path Env:DB_PASSWORD -Value '${s}'`,
    (s) => `Set-Item -Path "Env:\\API_TOKEN" -Value "${s}"`,
    (s) => `Set-Item -Value '${s}' -Path Env:DB_PASSWORD`,
    (s) => `si Env:GH_TOKEN -Value:'${s}'`,
    (s) => `New-Item -Path Env: -Name SERVICE_KEY -Value '${s}' -Force`,
    (s) => `Set-Content Env:GH_TOKEN ${s}`,
    (s) => `[Environment]::SetEnvironmentVariable('DB_PASSWORD','${s}')`,
    (s) => `[System.Environment]::SetEnvironmentVariable("DB_PASSWORD", "${s}", "User")`,
    (s) => `[Environment]::SetEnvironmentVariable('API_TOKEN', '${s}', [EnvironmentVariableTarget]::User)`,
    (s) => `setx DB_PASSWORD ${s}`,
    (s) => `setx /M API_TOKEN "${s}"`,
  ]) {
    const s = secret();
    assertGone(make(s), s);
  }
});

test("a secret in a PowerShell variable, hashtable entry or plain-text secure string is removed", () => {
  for (const make of [
    (s) => `$token = '${s}'`,
    (s) => `$apiKey = '${s}'`,
    (s) => `$secret = "${s}"`,
    (s) => `$DbPass = '${s}'`,
    (s) => `$password = "${s}"`,
    (s) => `$script:ClientSecret = '${s}'`,
    (s) => `$p = ConvertTo-SecureString -AsPlainText -Force -String '${s}'`,
    (s) => `$p = ConvertTo-SecureString -String:'${s}' -AsPlainText -Force`,
    (s) => `$p = ConvertTo-SecureString '${s}' -AsPlainText -Force`,
    (s) => `$c = New-Object PSCredential("svc", (ConvertTo-SecureString "${s}" -AsPlainText -Force))`,
    (s) => `$p = '${s}' | ConvertTo-SecureString -AsPlainText -Force`,
    (s) => `$headers = @{ Authorization = 'Bearer ${s}' }`,
    (s) => `$body = @{ client_id = 'app'; client_secret = '${s}' }`,
    (s) => `Invoke-RestMethod -Uri https://api.example.test/v1/me -Headers @{Authorization="Bearer ${s}"}`,
    (s) => `$h = @{ 'X-Api-Key' = '${s}' }`,
  ]) {
    const s = secret();
    assertGone(make(s), s);
  }
});

test("a secret piped into a program that reads it from standard input is removed", () => {
  const s = secret();
  assertGone(`echo "${s}" | docker login -u bob --password-stdin reg.example.test`, s, "Bash");
  const t = secret();
  assertGone(`printf '%s' ${t} | helm registry login reg.example.test --username bob --password-stdin`, t, "Bash");
  // A literal that is the whole first part of the pipeline, alone or in a group: every recorded command text drops it.
  const u = secret();
  assertGone(`'${u}' | ConvertTo-SecureString -AsPlainText -Force | Set-Variable p`, u, "PowerShell", true);
  const v = secret();
  assertGone(`New-LocalUser -Name svc -Password ("${v}" | ConvertTo-SecureString -AsPlainText -Force)`, v, "PowerShell", true);
});

test("a PowerShell setter's value is not recorded as a file it writes", () => {
  const writes = (command) => mapped(command, "PowerShell").filter((m) => m.intent.action_type === "file.write").map((m) => m.intent.params.path);
  assert.deepEqual(writes("Set-Content -Path notes.txt -Value 'x1'"), ["notes.txt"]);
  assert.deepEqual(writes("Add-Content -Value:'x1' notes.txt"), ["notes.txt"]);
  assert.ok(!writes("Set-Content Env:GH_TOKEN x1").includes("x1"));
  assert.ok(!writes("Set-Content -Path Env:GH_TOKEN x1").includes("x1"));
  assert.ok(!writes("New-Item -Path Env: -Name API_TOKEN -Value x1").includes("x1"));
  // Where the value may be a path, the cautious reading stays: a link's target, a path list, a write to Scopebond's folder.
  assert.ok(writes("New-Item -ItemType SymbolicLink -Path l -Value .scopebond/policy.json").includes(".scopebond/policy.json"));
  assert.ok(writes("ni -it SymbolicLink -Path l -Value .scopebond/policy.json").includes(".scopebond/policy.json"));
  assert.ok(writes("Set-Content Env:X, .scopebond/policy.json v").includes(".scopebond/policy.json"));
  assert.ok(writes("Set-Content -Value v .scopebond/policy.json").includes(".scopebond/policy.json"));
});

test("a scrubbed path still shows where it leads, so the path rules still stop it", async () => {
  const dir = join(SANDBOX, "project", ".scopebond");
  scaffold(dir); // the shipped starter policy
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
  });
  for (const [tool, command, path] of [
    ["Bash", "cat token=a/../.scopebond/agent.key", "token=***/../.scopebond/agent.key"],
    ["PowerShell", "Get-Content \"x'token',a/../.scopebond/agent.key\"", "x'token',***/../.scopebond/agent.key"],
    ["PowerShell", "Get-Content 'token = a/../.scopebond/agent.key'", "token = ***/../.scopebond/agent.key"],
  ]) {
    const intents = mapped(command, tool);
    assert.deepEqual(intents.filter((m) => m.intent.action_type === "file.read").map((m) => m.intent.params.path), [path], command);
    assert.equal((await runtime.evaluate(intents, { groupKey: command })).decision, "deny", command);
  }
  runtime.exporter?.stop?.();
});

test("a URL password holding '@' is removed up to the last '@'; the host and path stay", () => {
  const tail = secret();
  const push = mapped(`git push https://deploy:p4ss@${tail}@host.example.test/org/repo.git main`, "Bash").find((m) => m.intent.action_type === "git.push");
  assert.equal(push.intent.params.remote, "https://***@host.example.test/org/repo.git");
  assertGone(`git push https://deploy:p4ss@${tail}@host.example.test/org/repo.git main`, tail, "Bash");
  const t2 = secret();
  assertGone(`curl https://alice:se@${t2}@api.example.test/v1/x`, t2, "Bash");
  assert.match(scrubSecrets(`curl https://alice:se@${t2}@api.example.test/v1/x`), /^curl https:\/\/\*\*\*@api\.example\.test\/v1\/x$/);
  assert.equal(scrubParam("https://u:a@b@c@host.example.test/x"), "https://***@host.example.test/x");
  // An "@" after the host (in the path, query or fragment) is not userinfo: the host stays.
  assert.equal(scrubParam("https://api.example.test/find?email=a@example.test"), "https://api.example.test/find?email=a@example.test");
  assert.equal(scrubParam("https://api.example.test#a@b"), "https://api.example.test#a@b");
  assert.equal(scrubParam("https://cdn.example.test/@scope/pkg"), "https://cdn.example.test/@scope/pkg");
});

test("ordinary values in the same command shapes stay readable", () => {
  assert.equal(scrubSecrets("Set-Item Env:PATH 'C:/tools'"), "Set-Item Env:PATH 'C:/tools'");
  assert.equal(scrubSecrets("[Environment]::SetEnvironmentVariable('Path', 'C:/tools', 'User')"), "[Environment]::SetEnvironmentVariable('Path', 'C:/tools', 'User')");
  assert.equal(scrubSecrets("setx JAVA_HOME C:/jdk"), "setx JAVA_HOME C:/jdk");
  assert.equal(scrubSecrets("$name = 'build'; $path = 'src/app.ts'"), "$name = 'build'; $path = 'src/app.ts'");
  assert.equal(scrubSecrets("if ($token -eq $null) { exit 1 }"), "if ($token -eq $null) { exit 1 }");
  assert.equal(scrubSecrets("token == expected"), "token == expected");
  assert.equal(scrubSecrets("Get-Item Env:GH_TOKEN"), "Get-Item Env:GH_TOKEN");
  assert.equal(scrubSecrets("'hello' | Write-Output"), "'hello' | Write-Output");
  // The label stays; only the value goes.
  assert.equal(scrubSecrets("Set-Item -Path Env:DB_PASSWORD -Value 'x1'"), "Set-Item -Path Env:DB_PASSWORD -Value '***'");
  assert.equal(scrubSecrets("$token = 'x1'"), "$token = '***'");
  assert.equal(scrubSecrets("$p = ConvertTo-SecureString -AsPlainText -Force -String 'x1'"), "$p = ConvertTo-SecureString -AsPlainText -Force -String '***'");
});

/** Run `fn` and fail when it takes a second or more. */
function fast(label, fn) {
  const started = performance.now();
  fn();
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `${label} took ${ms.toFixed(0)} ms`);
}

test("the PowerShell and URL scrubbing stays linear in the command's length", () => {
  const n = 50_000;
  for (const [label, text] of [
    ["many Env: paths", "Set-Item Env:TOKEN ".repeat(n / 19)],
    ["many secure-string calls", "ConvertTo-SecureString ".repeat(n / 23)],
    ["many .NET calls", "[Environment]::SetEnvironmentVariable(".repeat(n / 38)],
    ["unclosed .NET call", "[Environment]::SetEnvironmentVariable('TOKEN', (" + "(".repeat(n)],
    ["a long name before '='", "a".repeat(n) + " = 'x'"],
    ["a long name never assigned", "token".repeat(n / 5)],
    ["blanks before '='", "token" + " ".repeat(n) + "x"],
    ["unclosed here-strings", "$token = @' ".repeat(n / 12)],
    ["unclosed quotes", "$token = ' ".repeat(n / 11)],
    ["many pipes into a reader", "'x' | ".repeat(n / 6) + "ConvertTo-SecureString"],
    ["many setx", "setx TOKEN ".repeat(n / 11)],
    ["userinfo with many '@'", "://" + "a@".repeat(n / 2)],
    ["userinfo with no '@'", "://a:" + "a".repeat(n)],
    ["many schemes", "://".repeat(n / 3)],
  ]) {
    fast(label, () => scrubSecrets(text));
    fast(`${label} (mapped)`, () => mapped(text, "PowerShell"));
  }
});
