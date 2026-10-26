import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { scaffold } from "@scopebond/hook";
import { discoverTools, toolLines, runSelfCheck, selfCheckProof, MAX_MCP_SERVERS, MAX_MCP_NAME } from "../dist/index.js";
import { tomlServerNames, parseVersion, mcpServerName, parseLenientJson, jsonServerNames, programVersion } from "../dist/tools.js";

const ENV_KEYS = ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME", "COPILOT_HOME", "SCOPEBOND_HOME"];

/** Run `fn` with a fresh fixture home as this process's home (and VS Code's and Copilot's folders inside it). */
async function inHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "sb-tools-home-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.SCOPEBOND_HOME = join(home, ".scopebond");
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  delete process.env.COPILOT_HOME;
  try { return await fn(home); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function put(file, content) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

/** Where VS Code keeps Cline's global storage on this platform, inside the fixture home. */
function clineFolder(home) {
  const base = process.platform === "win32" ? process.env.APPDATA
    : process.platform === "darwin" ? join(home, "Library", "Application Support") : process.env.XDG_CONFIG_HOME;
  return join(base, "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
}

const SECRET = ["planted", "value", "0123456789"].join("-"); // must never be reported
const HOOK_ENTRY = { matcher: "*", hooks: [{ type: "command", command: "npx -y @scopebond/hook@0.21.0 claude" }] };

/** Every tool's settings, an MCP config of each format, and a fake global npm folder. */
function fullHome(home) {
  // Claude Code, governed: the Scopebond hook in its user settings; MCP servers in ~/.claude.json.
  put(join(home, ".claude", "settings.json"), { hooks: { PreToolUse: [HOOK_ENTRY] } });
  put(join(home, ".claude.json"), {
    numStartups: 3,
    projects: { [join(home, "repo")]: { mcpServers: { project_only: { command: "x" } } } },
    mcpServers: {
      github: { type: "http", url: "https://api.example.test/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
      "playwright:local": { command: "npx", args: ["@playwright/mcp", "--user-data-dir", join(home, "pw")], env: { TOKEN: SECRET } },
      [join(home, "secret", "server")]: { command: "node" },
      "https://evil.example/mcp": { command: "node" },
      "  spaced  ": { command: "node" },
      "bad\nname": { command: "node" },
    },
  });
  // Cursor: present, not governed (its hooks.json has another tool's hook only); its mcp.json with a comment.
  put(join(home, ".cursor", "hooks.json"), { version: 1, hooks: { beforeShellExecution: [{ command: "other-tool check" }] } });
  put(join(home, ".cursor", "mcp.json"), `{\n  // personal servers\n  "mcpServers": { "linear": { "url": "https://mcp.example.test/sse" }, "org/notes": { "command": "notes" }, },\n}\n`);
  // Codex: config.toml tables (and the nested env table, which is the same server).
  put(join(home, ".codex", "config.toml"), [
    "model = \"x\"",
    "[mcp_servers.context7]",
    "command = \"npx\"",
    `args = ["-y", "@upstash/context7-mcp", "--key", "${SECRET}"]`,
    "[mcp_servers.context7.env]",
    `API_KEY = "${SECRET}"`,
    "[ mcp_servers.\"quoted name\" ]",
    "url = \"https://x.example.test\"",
    "[[mcp_servers_list]]",
    "[profiles.mcp_servers]",
  ].join("\n"));
  // Copilot CLI: its own settings.json, its MCP config.
  put(join(home, ".copilot", "settings.json"), {});
  put(join(home, ".copilot", "mcp-config.json"), { mcpServers: { "azure-devops": { command: "x", env: { PAT: SECRET } } } });
  // Windsurf, Gemini CLI.
  put(join(home, ".codeium", "windsurf", "mcp_config.json"), { mcpServers: { sentry: { serverUrl: "https://mcp.example.test" } } });
  put(join(home, ".gemini", "settings.json"), { theme: "x", mcpServers: { firebase: { command: "x" } } });
  // Cline (VS Code global storage), OpenCode, Aider.
  mkdirSync(clineFolder(home), { recursive: true });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  put(join(home, ".aider.conf.yml"), "model: x\n");
  // A global npm folder with Claude Code and Gemini CLI installed.
  const npmRoot = join(home, "npm-global", "node_modules");
  put(join(npmRoot, "@anthropic-ai", "claude-code", "package.json"), { name: "@anthropic-ai/claude-code", version: "2.1.4" });
  put(join(npmRoot, "@google", "gemini-cli", "package.json"), { name: "@google/gemini-cli", version: "0.9.0-preview.1" });
  return npmRoot;
}

/** No program on PATH but the fake Codex and Aider; `--version` answers recorded. */
function fakePrograms() {
  const ran = [];
  const bin = process.platform === "win32" ? "C:\\fake\\bin" : "/fake/bin";
  const programs = { codex: join(bin, "codex"), aider: join(bin, "aider") };
  return {
    ran,
    findProgram: (name) => programs[name] ?? null,
    runVersion: async (program) => {
      ran.push(program);
      if (program === programs.codex) return "codex-cli 0.46.0\n";
      if (program === programs.aider) return `aider 0.86.1 (${join(bin, "python")})\n`;
      return null;
    },
  };
}

test("a computer without any AI coding tool reports none", async () => {
  await inHome(async () => {
    const found = await discoverTools({ npmRoots: [], findProgram: () => null, runVersion: async () => { throw new Error("must not run"); } });
    assert.deepEqual(found, { tools: [], mcp_servers: [] });
  });
});

test("each tool is found by its settings, its version read cheaply, and governed only where the hook is installed", async () => {
  await inHome(async (home) => {
    const npmRoot = fullHome(home);
    const programs = fakePrograms();
    const found = await discoverTools({ npmRoots: [npmRoot], findProgram: programs.findProgram, runVersion: programs.runVersion });
    assert.deepEqual(found.tools, [
      { id: "claude", version: "2.1.4", governed: true, settings_present: true },
      { id: "cursor", version: null, governed: false, settings_present: true },
      { id: "codex", version: "0.46.0", governed: false, settings_present: true },
      { id: "copilot", version: null, governed: false, settings_present: true },
      { id: "windsurf", version: null, governed: false, settings_present: true },
      { id: "gemini", version: "0.9.0-preview.1", governed: false, settings_present: true },
      { id: "cline", version: null, governed: false, settings_present: true },
      { id: "opencode", version: null, governed: false, settings_present: true },
      { id: "aider", version: "0.86.1", governed: false, settings_present: true },
    ]);
    // A version from the npm manifest never runs the program; only the two found on PATH answered --version.
    assert.deepEqual(programs.ran.sort(), [programs.findProgram("aider"), programs.findProgram("codex")].sort());
    assert.deepEqual(found.mcp_servers, [
      { tool: "claude", name: "github" },
      { tool: "claude", name: "playwright:local" },
      { tool: "claude", name: "spaced" },
      { tool: "cursor", name: "linear" },
      { tool: "cursor", name: "org/notes" },
      { tool: "codex", name: "context7" },
      { tool: "codex", name: "quoted name" },
      { tool: "copilot", name: "azure-devops" },
      { tool: "windsurf", name: "sentry" },
      { tool: "gemini", name: "firebase" },
    ]);
    assert.deepEqual(toolLines(found.tools.slice(0, 2)), ["Claude Code 2.1.4 · governed", "Cursor · present, not governed"]);
  });
});

test("a program on PATH, or an npm install, without the tool's settings is never run and never reported", async () => {
  await inHome(async (home) => {
    const ran = [];
    const npmRoot = join(home, "npm-global", "node_modules");
    put(join(npmRoot, "@anthropic-ai", "claude-code", "package.json"), { version: "2.1.4" });
    const onPath = { gemini: join(home, "bin", "gemini"), claude: join(home, "bin", "claude"), aider: join(home, "bin", "aider"), codex: join(home, "bin", "codex") };
    const found = await discoverTools({ npmRoots: [npmRoot], findProgram: (n) => onPath[n] ?? null, runVersion: async (p) => { ran.push(p); return "1.0.0"; } });
    assert.deepEqual(ran, [], "nothing was executed");
    assert.deepEqual(found, { tools: [], mcp_servers: [] });
    // With ~/.gemini, the same program answers.
    mkdirSync(join(home, ".gemini"), { recursive: true });
    const withSettings = await discoverTools({ npmRoots: [npmRoot], findProgram: (n) => onPath[n] ?? null, runVersion: async (p) => { ran.push(p); return "gemini 0.12.0"; } });
    assert.deepEqual(ran, [onPath.gemini]);
    assert.deepEqual(withSettings.tools, [{ id: "gemini", version: "0.12.0", governed: false, settings_present: true }]);
  });
});

test("programVersion keeps the version a program prints, and null when it fails or runs too long", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-tools-prog-"));
  const script = (name, body) => { const file = join(dir, name); writeFileSync(file, body); return file; };
  const prints = script("prints.mjs", "if (process.argv.includes('--version')) console.log('tool 3.4.5');\n");
  const fails = script("fails.mjs", "console.log('tool 3.4.5'); process.exit(1);\n");
  const hangs = script("hangs.mjs", "setTimeout(() => console.log('tool 3.4.5'), 30000);\n");
  assert.equal(await programVersion(process.execPath, { args: [prints] }), "3.4.5");
  assert.equal(await programVersion(process.execPath, { args: [fails] }), null, "a non-zero exit is no version");
  const started = Date.now();
  assert.equal(await programVersion(process.execPath, { args: [hangs], timeoutMs: 500 }), null, "past the limit is no version");
  assert.ok(Date.now() - started < 10_000, "it does not wait for the program");
  assert.equal(await programVersion(join(dir, "no-such-program")), null);
});

test("the Copilot folder alone (VS Code's Copilot Chat) is not the Copilot CLI; its program on PATH is", async () => {
  await inHome(async (home) => {
    mkdirSync(join(home, ".copilot"), { recursive: true });
    const none = await discoverTools({ npmRoots: [], findProgram: () => null });
    assert.deepEqual(none.tools, []);
    const onPath = await discoverTools({ npmRoots: [], findProgram: (n) => (n === "copilot" ? join(home, "bin", "copilot") : null), runVersion: async () => "1.0.3" });
    assert.deepEqual(onPath.tools, [{ id: "copilot", version: "1.0.3", governed: false, settings_present: true }]);
  });
});

test("the Copilot CLI is governed by Scopebond's own hook file, and COPILOT_HOME moves its folder", async () => {
  await inHome(async (home) => {
    process.env.COPILOT_HOME = join(home, "copilot-elsewhere");
    put(join(home, "copilot-elsewhere", "logs", "x.log"), "");
    put(join(home, "copilot-elsewhere", "hooks", "scopebond.json"), { version: 1, hooks: { preToolUse: [{ type: "command", bash: "npx -y @scopebond/hook copilot", powershell: "npx.cmd -y @scopebond/hook copilot" }] } });
    put(join(home, "copilot-elsewhere", "mcp-config.json"), { mcpServers: { tickets: {} } });
    const found = await discoverTools({ npmRoots: [], findProgram: () => null });
    assert.deepEqual(found.tools, [{ id: "copilot", version: null, governed: true, settings_present: true }]);
    assert.deepEqual(found.mcp_servers, [{ tool: "copilot", name: "tickets" }]);
  });
});

test("at most 100 MCP server names, each at most 120 characters", async () => {
  await inHome(async (home) => {
    const servers = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`server-${i}`, { command: "x" }]));
    servers[`${"n".repeat(300)}`] = {};
    put(join(home, ".cursor", "mcp.json"), { mcpServers: { [`long-${"x".repeat(200)}`]: {}, ...servers } });
    put(join(home, ".gemini", "settings.json"), { mcpServers: { never: {} } });
    const found = await discoverTools({ npmRoots: [], findProgram: () => null });
    assert.equal(found.mcp_servers.length, MAX_MCP_SERVERS);
    assert.ok(found.mcp_servers.every((s) => s.name.length <= MAX_MCP_NAME));
    assert.equal(found.mcp_servers[0].name, `long-${"x".repeat(MAX_MCP_NAME - 5)}`);
    assert.ok(!found.mcp_servers.some((s) => s.tool === "gemini"), "the cap is across all tools");
    assert.equal(found.tools.length, 2, "tools are still all reported");
  });
});

test("no path, command, URL or secret ever appears in what is reported", async () => {
  await inHome(async (home) => {
    const npmRoot = fullHome(home);
    const programs = fakePrograms();
    const found = await discoverTools({ npmRoots: [npmRoot], findProgram: programs.findProgram, runVersion: programs.runVersion });
    const text = JSON.stringify(found);
    for (const banned of [home, home.replace(/\\/g, "\\\\"), SECRET, "npx", "https", "example.test", "fake", "python", "Bearer", "project_only"]) {
      assert.ok(!text.includes(banned), `${banned} leaked into ${text}`);
    }
    // Only these keys, in this shape.
    for (const t of found.tools) assert.deepEqual(Object.keys(t).sort(), ["governed", "id", "settings_present", "version"]);
    for (const s of found.mcp_servers) assert.deepEqual(Object.keys(s).sort(), ["name", "tool"]);
    // A name holding "/", "\" or ":" is reported only where the server is really named so.
    const legit = new Set(["playwright:local", "org/notes"]);
    for (const s of found.mcp_servers) if (/[/\\:]/.test(s.name)) assert.ok(legit.has(s.name), `${s.name} looks like a path`);
    for (const t of found.tools) if (t.version !== null) assert.match(t.version, /^\d+\.\d[0-9A-Za-z.+-]*$/);
  });
});

test("the helpers: version numbers, names, JSON with comments and Codex table headers", () => {
  assert.equal(parseVersion("2.1.4 (Claude Code)"), "2.1.4");
  assert.equal(parseVersion("codex-cli 0.46.0"), "0.46.0");
  assert.equal(parseVersion("/opt/tool/bin/tool has no version"), null);
  assert.equal(parseVersion(42), null);
  // A version-looking part of a path is never taken, and the last line that has a version wins over a notice before it.
  assert.equal(parseVersion("/opt/tool-1.2.3/bin/tool"), null);
  assert.equal(parseVersion("D:\\tools\\tool-1.2.3\\bin"), null);
  assert.equal(parseVersion("running /opt/tool-9.9.9/bin/tool\n2.0.1"), "2.0.1");
  assert.equal(parseVersion("a newer version 9.0.0 is available\ntool 1.4.0\n"), "1.4.0");
  assert.equal(mcpServerName("./local-server"), null);
  assert.equal(mcpServerName("../up/server"), null);
  assert.equal(mcpServerName(".hidden"), ".hidden");
  // A big file that is not plain JSON is not read a second time without its comments.
  assert.equal(parseLenientJson(`{ // c\n "a": "${"x".repeat(1024 * 1024)}" }`), null);
  assert.equal(mcpServerName("D:/data/x"), null);
  assert.equal(mcpServerName("\\\\server\\share"), null);
  assert.equal(mcpServerName("/usr/local/bin/x"), null);
  assert.equal(mcpServerName("~/x"), null);
  assert.equal(mcpServerName("a:b"), "a:b");
  assert.deepEqual(parseLenientJson("{ /* c */ \"a\": \"//not a comment\", }"), { a: "//not a comment" });
  assert.equal(parseVersion("v1.2."), "1.2");
  const bom = join(mkdtempSync(join(tmpdir(), "sb-tools-bom-")), "settings.json");
  writeFileSync(bom, String.fromCharCode(0xfeff) + "{\"mcpServers\":{\"one\":{}}}");
  assert.deepEqual(jsonServerNames(bom, "mcpServers"), ["one"], "a byte-order mark does not hide the servers");
  assert.deepEqual(tomlServerNames("[mcp_servers.a]\n[mcp_servers.a.env]\n[mcp_servers.'b c']\n[mcp_serversx.d]\n# [mcp_servers.e]\n[[mcp_servers.f]]\n"), ["a", "b c"]);
});

test("the self-check sends the tools and MCP server names in its body, and its signature still verifies", async () => {
  await inHome(async (home) => {
    const npmRoot = fullHome(home);
    const programs = fakePrograms();
    const dir = mkdtempSync(join(tmpdir(), "sb-tools-agent-"));
    scaffold(dir);
    const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
    const connection = { url: "https://workspace.example", credential: "sbm_test", credential_id: "cred_1", gateway_id: "gw_1", expires_at: new Date(Date.now() + 80 * 86400_000).toISOString() };
    let posted = null;
    const fetchImpl = async (url, init) => {
      posted = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, signature_verified: true, failed: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const discover = () => discoverTools({ npmRoots: [npmRoot], findProgram: programs.findProgram, runVersion: programs.runVersion });
    const result = await runSelfCheck(dir, connection, ["claude"], "0.8.0", { fetchImpl, discover });
    assert.equal(posted.tools.length, 9);
    assert.deepEqual(posted.tools[0], { id: "claude", version: "2.1.4", governed: true, settings_present: true });
    assert.equal(posted.mcp_servers.length, 10);
    assert.deepEqual(result.tools, posted.tools, "the result keeps them for status");
    assert.deepEqual(result.mcp_servers, posted.mcp_servers);
    // The new fields are part of the one signed self-check body; the signature over the day's proof still verifies.
    assert.ok(verify(null, Buffer.from(selfCheckProof("cred_1", "gw_1", posted.day), "utf8"), createPublicKey(attester.publicKeyPem), Buffer.from(posted.signature, "base64")));
    assert.ok(!JSON.stringify(posted).includes(SECRET));
    // A discovery that fails sends empty arrays; the self-check itself goes on.
    await runSelfCheck(dir, connection, ["claude"], "0.8.0", { fetchImpl, discover: async () => { throw new Error("boom"); } });
    assert.deepEqual([posted.tools, posted.mcp_servers], [[], []]);
  });
});

test("status --json and status show the coding tools on this computer", async () => {
  const { execFile } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  await inHome(async (home) => {
    put(join(home, ".claude", "settings.json"), { hooks: { PreToolUse: [HOOK_ENTRY] } });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const dir = join(home, ".scopebond");
    mkdirSync(dir, { recursive: true });
    const env = { ...process.env, SCOPEBOND_HOME: dir, SCOPEBOND_AGENT_TRAY: "off" };
    const run = (args) => new Promise((resolve) => execFile(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, out: stdout, err: stderr })));
    const json = await run(["status", "--json"]);
    assert.equal(json.code, 0, json.err);
    const status = JSON.parse(json.out);
    const byId = Object.fromEntries(status.tools.map((t) => [t.id, t]));
    assert.equal(byId.claude.governed, true);
    assert.equal(byId.claude.settings_present, true);
    assert.deepEqual([byId.cursor.governed, byId.cursor.settings_present], [false, true]);
    assert.ok(Array.isArray(status.mcp_servers));
    const text = await run(["status"]);
    assert.match(text.out, /coding tools\s+Claude Code[^\n]* · governed/);
    assert.match(text.out, /Cursor · present, not governed/);
  });
});
