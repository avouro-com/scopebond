// Managed tool settings: the agent applies a signed `tool_settings` section to the AI coding tools' user-level settings,
// reports applied / drifted / refused per tool, and never applies a section no trusted key signed. Every test runs under its
// own temporary HOME and USERPROFILE, so the real ~/.claude/settings.json and ~/.cursor/cli-config.json are never read or
// written; keys are made at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { digestToolSettings, signedPolicyBytes, MANAGED_DOC_FILE } from "@scopebond/hook";
import { applyToolSettings, toolSettingsReport, TOOL_SETTINGS_STATE_FILE } from "../dist/index.js";

const WORKSPACE = "org-ts-1";
const INSTALLATION = "gw-ts-1";
const NOW = new Date("2026-10-20T00:00:00Z");
const pair = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const KEYS = [{ key_id: "ws-1", public_key: pair.publicKey.export({ type: "spki", format: "pem" }), not_before: "2026-10-01T00:00:00Z", not_after: "2027-10-01T00:00:00Z" }];
const ENV_KEYS = ["HOME", "USERPROFILE", "SCOPEBOND_POLICY_KEYS_JSON", "CLAUDE_CONFIG_DIR"];

/** Run `fn` with a fresh fixture home as this process's home, and a Scopebond folder connected to a workspace. */
async function inHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "sb-toolsettings-home-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.SCOPEBOND_POLICY_KEYS_JSON;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    // The guard this file exists for: nothing below may touch the real home.
    assert.equal(homedir(), home);
    const dir = join(home, "sb");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: WORKSPACE, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
    return await fn({ home, dir });
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function section(harnesses, { revision = 1, mode = "enforce" } = {}) {
  const s = { type: "scopebond:tool-settings", version: 1, revision, mode, harnesses };
  return { ...s, settings_digest: digestToolSettings(s) };
}
function signed(s, { key = pair.privateKey, keyId = "ws-1", issuedAt = "2026-10-15T00:00:00Z", computer = INSTALLATION, workspace = WORKSPACE, kind = "tool_settings" } = {}) {
  const payload = { v: 1, workspace, computer, revision: s.revision, rules_digest: s.settings_digest, local_changes: false, managed: true, issued_at: issuedAt, ...(kind ? { kind } : {}) };
  return { ...s, workspace_id: workspace, issued_at: issuedAt, key_id: keyId, signature: cryptoSign(null, signedPolicyBytes(payload), key).toString("base64") };
}
/** The workspace document in force, as the hook installs it, carrying `tool_settings`. */
function install(dir, toolSettings) {
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify({ type: "scopebond:managed-rules", version: 1, revision: 3, installation_id: INSTALLATION, rules: {}, rules_digest: "0".repeat(64), tool_settings: toolSettings }));
}
function put(file, content) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
}
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const apply = (dir, now = NOW) => applyToolSettings(dir, { keys: KEYS, now });
const claudeFile = (home) => join(home, ".claude", "settings.json");
const cursorFile = (home) => join(home, ".cursor", "cli-config.json");

const CLAUDE = { permissions_deny: ["Bash(rm -rf:*)", "Read(./.env)"], permissions_allow: ["Bash(npm test)"], mcp_denied: ["evil"], mcp_allowed: ["github"] };

test("managed settings cannot write outside the selected profile", () => inHome(({ dir }) => {
  const other = mkdtempSync(join(tmpdir(), "other-tool-profile-"));
  process.env.CLAUDE_CONFIG_DIR = other;
  const file = join(other, "settings.json"); put(file, { theme: "dark" });
  const before = readFileSync(file, "utf8");
  install(dir, signed(section({ claude: CLAUDE })));
  assert.equal(apply(dir).harnesses.claude.reason, "profile_boundary");
  assert.equal(readFileSync(file, "utf8"), before);
}));

test("managed settings cannot follow a linked configuration ancestor", () => inHome(({ home, dir }) => {
  const other = mkdtempSync(join(tmpdir(), "linked-tool-profile-"));
  const file = join(other, "settings.json"); put(file, { theme: "dark" });
  const before = readFileSync(file, "utf8");
  symlinkSync(other, join(home, ".claude"), process.platform === "win32" ? "junction" : "dir");
  install(dir, signed(section({ claude: CLAUDE })));
  assert.equal(apply(dir).harnesses.claude.reason, "symlink");
  assert.equal(readFileSync(file, "utf8"), before);
}));

test("managed settings accept an alias of the selected profile without following links inside it", () => inHome(({ home, dir }) => {
  const alias = join(home, "selected-alias");
  symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
  put(cursorFile(home), {}); put(join(home, "claude-config", "settings.json"), {});
  process.env.HOME = alias; process.env.USERPROFILE = alias;
  process.env.CLAUDE_CONFIG_DIR = join(alias, "claude-config");
  install(dir, signed(section({ claude: CLAUDE, cursor: { permissions_deny: ["Shell(rm)"] } })));
  const report = apply(dir);
  assert.equal(report.harnesses.claude.state, "applied");
  assert.equal(report.harnesses.cursor.state, "applied");
}));

test("a signed section is applied to Claude Code's user settings; every other key and entry stays", () => inHome(({ home, dir }) => {
  put(claudeFile(home), { theme: "dark", hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "x" }] }] }, permissions: { allow: ["Read(*)"], defaultMode: "default" }, deniedMcpServers: [{ serverUrl: "https://x.example/*" }] });
  install(dir, signed(section({ claude: CLAUDE })));
  const report = apply(dir);
  assert.equal(report.result, "applied");
  assert.deepEqual(report.harnesses.claude, { state: "applied", keys: [], reason: null, restored_at: null, restored_keys: [] });
  const after = read(claudeFile(home));
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.hooks.PreToolUse[0].hooks[0].command, "x");
  assert.equal(after.permissions.defaultMode, "default");
  assert.deepEqual(after.permissions.allow, ["Read(*)", "Bash(npm test)"]);
  assert.deepEqual(after.permissions.deny, ["Bash(rm -rf:*)", "Read(./.env)"]);
  assert.deepEqual(after.deniedMcpServers, [{ serverUrl: "https://x.example/*" }, { serverName: "evil" }]);
  assert.deepEqual(after.allowedMcpServers, [{ serverName: "github" }]);
  // The file as it was is kept once.
  assert.equal(read(`${claudeFile(home)}.scopebond-backup`).permissions.deny, undefined);
  // Applied again: nothing changes, the file is not rewritten.
  const text = readFileSync(claudeFile(home), "utf8");
  assert.equal(apply(dir).harnesses.claude.state, "applied");
  assert.equal(readFileSync(claudeFile(home), "utf8"), text);
}));

test("the file's indentation and line endings are kept", () => inHome(({ home, dir }) => {
  put(claudeFile(home), "{\r\n    \"theme\": \"dark\"\r\n}\r\n");
  install(dir, signed(section({ claude: { permissions_deny: ["Bash(curl:*)"] } })));
  apply(dir);
  const text = readFileSync(claudeFile(home), "utf8");
  assert.match(text, /^\{\r\n {4}"theme": "dark",\r\n {4}"permissions": \{\r\n {8}"deny": \[/);
  assert.ok(text.endsWith("}\r\n"));
}));

test("an unsigned section is refused and nothing is written, in either mode", () => inHome(({ home, dir }) => {
  put(claudeFile(home), { theme: "dark" });
  const before = readFileSync(claudeFile(home), "utf8");
  for (const mode of ["enforce", "report"]) {
    install(dir, section({ claude: CLAUDE }, { mode }));
    const report = apply(dir);
    assert.equal(report.result, "refused");
    assert.equal(report.reason, "unsigned");
    assert.deepEqual(report.harnesses.claude, { state: "refused", keys: [], reason: "unsigned", restored_at: null, restored_keys: [] });
  }
  assert.equal(readFileSync(claudeFile(home), "utf8"), before);
  assert.equal(existsSync(`${claudeFile(home)}.scopebond-backup`), false);
  assert.equal(JSON.parse(toolSettingsReport(dir)).reason, "unsigned");
}));

test("with no pinned key, even a correctly signed section is refused as unsigned", () => inHome(({ home, dir }) => {
  put(claudeFile(home), { theme: "dark" });
  install(dir, signed(section({ claude: CLAUDE })));
  // The release's own keys (none are pinned yet) and no test keys.
  const report = applyToolSettings(dir, { now: NOW });
  assert.equal(report.result, "refused");
  assert.equal(report.reason, "unsigned");
  assert.deepEqual(read(claudeFile(home)), { theme: "dark" });
}));

test("a section signed by another key, for another computer, or altered after signing is refused", () => inHome(({ home, dir }) => {
  put(claudeFile(home), { theme: "dark" });
  install(dir, signed(section({ claude: CLAUDE }), { key: stranger.privateKey }));
  assert.equal(apply(dir).reason, "bad_signature");
  install(dir, signed(section({ claude: CLAUDE }), { computer: "gw-other" }));
  assert.equal(apply(dir).reason, "bad_signature");
  // A list changed after signing no longer matches its digest.
  const tampered = signed(section({ claude: CLAUDE }));
  tampered.harnesses = { claude: { permissions_allow: ["Bash(*)"] } };
  install(dir, tampered);
  assert.equal(apply(dir).reason, "invalid");
  // A rules signature cannot pass for tool settings, even over the very same revision and digest: its payload has no kind.
  install(dir, signed(section({ claude: CLAUDE }), { kind: null }));
  assert.equal(apply(dir).reason, "bad_signature");
  assert.deepEqual(read(claudeFile(home)), { theme: "dark" });
}));

test("an older section than the one applied is refused as a replay", () => inHome(({ dir }) => {
  install(dir, signed(section({ claude: CLAUDE }, { revision: 2 }), { issuedAt: "2026-10-16T00:00:00Z" }));
  assert.equal(apply(dir).result, "applied");
  install(dir, signed(section({ claude: CLAUDE }, { revision: 1 }), { issuedAt: "2026-10-15T00:00:00Z" }));
  assert.equal(apply(dir).reason, "bad_signature");
}));

test("a file that does not parse, or whose lists are not lists, is never overwritten", () => inHome(({ home, dir }) => {
  install(dir, signed(section({ claude: CLAUDE })));
  put(claudeFile(home), "{ \"theme\": \"dark\", // a comment\n}");
  assert.deepEqual(apply(dir).harnesses.claude, { state: "refused", keys: [], reason: "unparseable", restored_at: null, restored_keys: [] });
  assert.equal(readFileSync(claudeFile(home), "utf8"), "{ \"theme\": \"dark\", // a comment\n}");
  put(claudeFile(home), { permissions: { deny: "Bash(rm:*)" } });
  assert.equal(apply(dir).harnesses.claude.reason, "unparseable");
  assert.deepEqual(read(claudeFile(home)), { permissions: { deny: "Bash(rm:*)" } });
  put(claudeFile(home), "[]");
  assert.equal(apply(dir).harnesses.claude.reason, "unparseable");
}));

test("drift is reported by setting name only, and left alone in report mode", () => inHome(({ home, dir }) => {
  put(claudeFile(home), {});
  install(dir, signed(section({ claude: CLAUDE }, { mode: "report" })));
  assert.equal(apply(dir).harnesses.claude.state, "applied");
  const changed = read(claudeFile(home));
  changed.deniedMcpServers = [];
  changed.permissions.deny = ["Read(./.env)"];
  put(claudeFile(home), changed);
  const report = apply(dir);
  assert.deepEqual(report.harnesses.claude, { state: "drifted", keys: ["deniedMcpServers", "permissions.deny"], reason: null, restored_at: null, restored_keys: [] });
  // Names only: the report never carries a value.
  const sent = toolSettingsReport(dir);
  assert.ok(!sent.includes("evil") && !sent.includes("rm -rf"));
  assert.deepEqual(read(claudeFile(home)).deniedMcpServers, []);
}));

test("drift is put back in enforce mode, and the restore is reported", () => inHome(({ home, dir }) => {
  put(claudeFile(home), {});
  install(dir, signed(section({ claude: CLAUDE })));
  apply(dir);
  const changed = read(claudeFile(home));
  changed.deniedMcpServers = [];
  put(claudeFile(home), changed);
  const report = apply(dir);
  assert.equal(report.harnesses.claude.state, "applied");
  assert.equal(report.harnesses.claude.restored_at, NOW.toISOString());
  assert.deepEqual(report.harnesses.claude.restored_keys, ["deniedMcpServers"]);
  assert.deepEqual(read(claudeFile(home)).deniedMcpServers, [{ serverName: "evil" }]);
}));

test("entries Scopebond placed are taken out when the workspace drops them; a person's own entries stay", () => inHome(({ home, dir }) => {
  put(claudeFile(home), { permissions: { deny: ["Bash(mine)"] } });
  install(dir, signed(section({ claude: { permissions_deny: ["Bash(a)", "Bash(b)"] } })));
  apply(dir);
  assert.deepEqual(read(claudeFile(home)).permissions.deny, ["Bash(mine)", "Bash(a)", "Bash(b)"]);
  install(dir, signed(section({ claude: { permissions_deny: ["Bash(b)"] } }, { revision: 2 }), { issuedAt: "2026-10-16T00:00:00Z" }));
  apply(dir);
  assert.deepEqual(read(claudeFile(home)).permissions.deny, ["Bash(mine)", "Bash(b)"]);
  // The workspace stops naming Claude Code: what it placed goes, and the tool is no longer reported.
  install(dir, signed(section({}, { revision: 3 }), { issuedAt: "2026-10-17T00:00:00Z" }));
  const report = apply(dir);
  assert.deepEqual(read(claudeFile(home)).permissions.deny, ["Bash(mine)"]);
  assert.equal(report.harnesses.claude, undefined);
}));

test("Cursor CLI: permission lists and denied MCP servers go to cli-config.json; a permitted-server list is unsupported", () => inHome(({ home, dir }) => {
  put(cursorFile(home), { version: 1, editor: { vimMode: false }, permissions: { allow: ["Shell(ls)"], deny: [] } });
  install(dir, signed(section({ cursor: { permissions_deny: ["Shell(rm)"], mcp_denied: ["evil"] } })));
  assert.equal(apply(dir).harnesses.cursor.state, "applied");
  const after = read(cursorFile(home));
  assert.deepEqual(after.editor, { vimMode: false });
  assert.deepEqual(after.permissions, { allow: ["Shell(ls)"], deny: ["Shell(rm)", "Mcp(evil:*)"] });
  install(dir, signed(section({ cursor: { mcp_allowed: ["github"] } }, { revision: 2 }), { issuedAt: "2026-10-16T00:00:00Z" }));
  assert.equal(apply(dir).harnesses.cursor.reason, "unsupported");
}));

test("Codex and GitHub Copilot have no documented user-level lists: refused as unsupported, nothing written", () => inHome(({ home, dir }) => {
  put(join(home, ".codex", "config.toml"), "model = \"x\"\n");
  install(dir, signed(section({ codex: { mcp_denied: ["evil"] }, copilot: { permissions_deny: ["shell(rm)"] }, claude: { permissions_deny: ["Bash(rm:*)"] } })));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const report = apply(dir);
  assert.equal(report.harnesses.codex.reason, "unsupported");
  assert.equal(report.harnesses.copilot.reason, "unsupported");
  assert.equal(report.harnesses.claude.state, "applied");
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), "model = \"x\"\n");
  assert.equal(existsSync(join(home, ".copilot")), false);
}));

test("a tool that is not installed is reported, and its folder is not created", () => inHome(({ home, dir }) => {
  install(dir, signed(section({ cursor: { permissions_deny: ["Shell(rm)"] } })));
  assert.equal(apply(dir).harnesses.cursor.reason, "not_installed");
  assert.equal(existsSync(join(home, ".cursor")), false);
}));

test("a document without tool settings changes nothing and reports nothing", () => inHome(({ dir }) => {
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify({ type: "scopebond:managed-rules", version: 1 }));
  assert.equal(apply(dir), null);
  assert.equal(existsSync(join(dir, TOOL_SETTINGS_STATE_FILE)), false);
  assert.equal(toolSettingsReport(dir), null);
}));

test("once a computer had tool settings, a document without them is reported as not delivered, and the file is left alone", () => inHome(({ home, dir }) => {
  put(claudeFile(home), {});
  install(dir, signed(section({ claude: CLAUDE })));
  apply(dir);
  const text = readFileSync(claudeFile(home), "utf8");
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify({ type: "scopebond:managed-rules", version: 1 }));
  const report = apply(dir);
  assert.equal(report.result, "not_delivered");
  assert.deepEqual(report.harnesses, {});
  assert.equal(JSON.parse(toolSettingsReport(dir)).result, "not_delivered");
  assert.equal(readFileSync(claudeFile(home), "utf8"), text);
}));

test("a list Scopebond created is removed when it ends empty: no empty permitted-server list is left to stop every server", () => inHome(({ home, dir }) => {
  put(claudeFile(home), { theme: "dark" });
  install(dir, signed(section({ claude: { mcp_allowed: ["github"], permissions_deny: ["Bash(rm:*)"] } })));
  apply(dir);
  assert.deepEqual(read(claudeFile(home)).allowedMcpServers, [{ serverName: "github" }]);
  install(dir, signed(section({ claude: { permissions_deny: ["Bash(rm:*)"] } }, { revision: 2 }), { issuedAt: "2026-10-16T00:00:00Z" }));
  apply(dir);
  assert.equal("allowedMcpServers" in read(claudeFile(home)), false);
  // The workspace stops naming Claude Code: the permissions object Scopebond created goes too.
  install(dir, signed(section({}, { revision: 3 }), { issuedAt: "2026-10-17T00:00:00Z" }));
  apply(dir);
  assert.deepEqual(read(claudeFile(home)), { theme: "dark" });
}));

test("a person's own permitted-server list stays even when Scopebond's entries leave it", () => inHome(({ home, dir }) => {
  put(claudeFile(home), { allowedMcpServers: [{ serverName: "mine" }] });
  install(dir, signed(section({ claude: { mcp_allowed: ["github"] } })));
  apply(dir);
  install(dir, signed(section({}, { revision: 2 }), { issuedAt: "2026-10-16T00:00:00Z" }));
  apply(dir);
  assert.deepEqual(read(claudeFile(home)).allowedMcpServers, [{ serverName: "mine" }]);
}));

test("an entry a person already had is never taken out when the workspace stops listing it", () => inHome(({ home, dir }) => {
  put(claudeFile(home), { permissions: { deny: ["Bash(rm:*)"] } });
  install(dir, signed(section({ claude: { permissions_deny: ["Bash(rm:*)", "Bash(curl:*)"] } })));
  apply(dir);
  assert.deepEqual(read(claudeFile(home)).permissions.deny, ["Bash(rm:*)", "Bash(curl:*)"]);
  install(dir, signed(section({}, { revision: 2 }), { issuedAt: "2026-10-16T00:00:00Z" }));
  apply(dir);
  assert.deepEqual(read(claudeFile(home)).permissions.deny, ["Bash(rm:*)"]);
}));

test("a settings file that is a link is refused, never replaced", (t) => inHome(({ home, dir }) => {
  const real = join(home, "dotfiles", "settings.json");
  put(real, { theme: "dark" });
  mkdirSync(join(home, ".claude"), { recursive: true });
  try { symlinkSync(real, claudeFile(home), "file"); } catch { t.skip("this system does not let the test create a link"); return; }
  install(dir, signed(section({ claude: CLAUDE })));
  assert.equal(apply(dir).harnesses.claude.reason, "symlink");
  assert.equal(lstatSync(claudeFile(home)).isSymbolicLink(), true);
  assert.deepEqual(read(real), { theme: "dark" });
}));

test("CLAUDE_CONFIG_DIR moves Claude Code's settings file, as Claude Code reads it", () => inHome(({ home, dir }) => {
  const config = join(home, "claude-config");
  put(join(config, "settings.json"), {});
  process.env.CLAUDE_CONFIG_DIR = config;
  install(dir, signed(section({ claude: { permissions_deny: ["Bash(rm:*)"] } })));
  assert.equal(apply(dir).harnesses.claude.state, "applied");
  assert.deepEqual(read(join(config, "settings.json")).permissions.deny, ["Bash(rm:*)"]);
  assert.equal(existsSync(join(home, ".claude")), false);
}));

test("the replay mark is kept per workspace: moving to another workspace and back does not reopen older sections", () => inHome(({ dir }) => {
  const connect = (workspace) => writeFileSync(join(dir, "cloud.json"), JSON.stringify({ url: "https://cloud.example.test", credential: "sbm_x", credential_id: "c", organization_id: workspace, environment_id: "env-1", gateway_id: INSTALLATION, attester_kid: "k", scopes: [], expires_at: "2099-01-01T00:00:00Z" }));
  install(dir, signed(section({ claude: CLAUDE }, { revision: 5 }), { issuedAt: "2026-10-16T00:00:00Z" }));
  assert.equal(apply(dir).result, "applied");
  connect("org-ts-2");
  install(dir, signed(section({ claude: CLAUDE }), { workspace: "org-ts-2", issuedAt: "2026-10-10T00:00:00Z" }));
  assert.equal(apply(dir).result, "applied");
  connect(WORKSPACE);
  install(dir, signed(section({ claude: CLAUDE }, { revision: 4 }), { issuedAt: "2026-10-15T00:00:00Z" }));
  assert.equal(apply(dir).reason, "bad_signature");
}));

test("a newer section version is refused as unsupported", () => inHome(({ dir }) => {
  install(dir, { ...signed(section({ claude: CLAUDE })), version: 2 });
  assert.equal(apply(dir).reason, "unsupported");
}));
