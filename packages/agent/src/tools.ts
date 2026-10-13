// Which AI coding tools this computer has, and which of them the Scopebond hook checks. The daily self-check sends the
// result to the workspace, so it can show the tools a computer last reported and the ones running without the hook.
//
// What is reported, and nothing else: per tool, its id, its installed version when that can be read cheaply, whether the
// hook is installed for it, and whether its user-level settings exist; and the NAMES of the MCP servers in each tool's
// user-level MCP configuration. Never a path, a user name, a command, an argument, an environment value or a URL.
//
// A tool is never started in a way that opens a session: a version comes from the package manifest of a global npm
// install, or from `<program> --version` for the programs known to answer it and exit (with a 3 s limit), else null.

import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessConfigured, userHarnessFile, type Harness } from "@scopebond/hook";
import { findProgram } from "@scopebond/gateway/node";
import { ownNpm, npmOnPath } from "./update.js";

export type ToolId = "claude" | "cursor" | "codex" | "copilot" | "windsurf" | "gemini" | "cline" | "opencode" | "aider";

/** Every tool the agent looks for, in the order it reports them. */
export const TOOL_IDS: readonly ToolId[] = ["claude", "cursor", "codex", "copilot", "windsurf", "gemini", "cline", "opencode", "aider"];

/** The name a person knows each tool by (`status`). */
export const TOOL_LABELS: Readonly<Record<ToolId, string>> = {
  claude: "Claude Code", cursor: "Cursor", codex: "Codex", copilot: "GitHub Copilot CLI", windsurf: "Windsurf",
  gemini: "Gemini CLI", cline: "Cline", opencode: "OpenCode", aider: "Aider",
};

export interface ToolReport { id: ToolId; version: string | null; governed: boolean; settings_present: boolean }
export interface McpServerReport { tool: ToolId; name: string }
export interface ToolDiscovery { tools: ToolReport[]; mcp_servers: McpServerReport[] }

export const MAX_TOOLS = 20;
export const MAX_MCP_SERVERS = 100;
export const MAX_MCP_NAME = 120;
/** A configuration file larger than this is not read (`~/.claude.json` also holds per-project history and grows). */
const MAX_CONFIG_BYTES = 32 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 3_000;

/** The tools the hook can be installed for. The others are reported present, never governed. */
const HOOK_HARNESSES: Partial<Record<ToolId, Harness>> = { claude: "claude", cursor: "cursor", codex: "codex", copilot: "copilot" };

/** The npm package of each tool that is published to npm; its version is read from the global install's package.json. */
export const NPM_PACKAGES: Partial<Record<ToolId, string>> = {
  claude: "@anthropic-ai/claude-code", codex: "@openai/codex", copilot: "@github/copilot", gemini: "@google/gemini-cli", opencode: "opencode-ai",
};

/** The programs that print their version for `--version` and exit, without starting a session. */
export const VERSION_PROGRAMS: Partial<Record<ToolId, string>> = { claude: "claude", codex: "codex", copilot: "copilot", gemini: "gemini", aider: "aider" };

export interface DiscoveryOptions {
  /** The global npm package folders to read manifests from (default: the usual ones and `npm root -g`). */
  npmRoots?: string[];
  /** Finds a program on PATH by its bare name (default: PATH's absolute folders only; on Windows only `.com`/`.exe`). */
  findProgram?: (name: string) => string | null;
  /** Prints a program's version (default: `<program> --version`, 3 s limit). */
  runVersion?: (program: string) => Promise<string | null>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const VERSION_PATTERN = /\d{1,9}\.\d[0-9A-Za-z.+-]{0,60}/;

/** The version number in a program's output or a manifest's `version`, or null: from the last line that has one (a notice
 *  printed before it does not count), the first whitespace-separated token there that holds one. A token joined to a path
 *  separator (`/opt/tool-1.2/bin`, or the same with backslashes) is skipped. Only digits, dots and a short pre-release
 *  tag ever leave this function: never a path or other text from the output. */
export function parseVersion(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const lines = text.slice(0, 4096).split(/\r?\n/).reverse();
  for (const line of lines) {
    for (const token of line.split(/\s+/)) {
      if (!token || token.includes("/") || token.includes("\\")) continue;
      const m = VERSION_PATTERN.exec(token);
      if (!m) continue;
      let version = m[0];
      while (version && ".+-".includes(version[version.length - 1])) version = version.slice(0, -1);
      if (version) return version;
    }
  }
  return null;
}

/** An MCP server name as reported: trimmed, at most 120 characters, and never anything that reads as a path or an
 *  address (an absolute path, a home- or folder-relative one, a backslash, a URL) or holds a control character. */
export function mcpServerName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name) return null;
  for (const ch of name) { const c = ch.codePointAt(0) ?? 0; if (c < 0x20 || c === 0x7f) return null; }
  if (name.includes("\\") || name.includes("://") || name.startsWith("/") || name.startsWith("~") || name.startsWith("./") || name.startsWith("../") || /^[A-Za-z]:[\\/]/.test(name)) return null;
  return [...name].slice(0, MAX_MCP_NAME).join("");
}

function readText(file: string): string | null {
  let fd: number | undefined;
  try {
    // One handle for the size check and the read, so the file checked is the file read. The read itself stops one byte
    // past the bound, so a file that grows past it after the check is refused too.
    fd = openSync(file, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_CONFIG_BYTES + 1 - total));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      chunks.push(n === chunk.length ? chunk : chunk.subarray(0, n));
      total += n;
      if (total > MAX_CONFIG_BYTES) return null;
    }
    const text = Buffer.concat(chunks, total).toString("utf8");
    // A byte-order mark (Windows PowerShell 5.1 writes one) would make JSON.parse refuse the whole file.
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch { return null; } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to release */ } }
  }
}

/** Above this size a file that is not plain JSON is not read again without its comments. */
const MAX_LENIENT_CHARS = 1024 * 1024;

/** JSON, or (up to 1 MiB) JSON with `//` and block comments and trailing commas, which some tools write or accept. */
export function parseLenientJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* try without comments */ }
  if (text.length > MAX_LENIENT_CHARS) return null;
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += text[i + 1] ?? ""; i++; } else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (ch === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 1; continue; }
    out += ch;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")); } catch { return null; }
}

/** The keys of the object under `key` in a JSON file: the server names, never their settings. */
export function jsonServerNames(file: string, key: string): string[] {
  const text = readText(file);
  if (text === null) return [];
  const parsed = parseLenientJson(text);
  if (!isRecord(parsed)) return [];
  const servers = parsed[key];
  return isRecord(servers) ? Object.keys(servers) : [];
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+/;

/** The server names of Codex's `config.toml`: the `<name>` of each `[mcp_servers.<name>]` table header (and of the nested
 *  `[mcp_servers.<name>.env]` ones), bare or quoted. A table-header scan, not a TOML parser: nothing else is read. */
export function tomlServerNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[") || trimmed.startsWith("[[")) continue;
    const head = trimmed.slice(1).trimStart();
    if (!head.startsWith("mcp_servers")) continue;
    let rest = head.slice("mcp_servers".length).trimStart();
    if (!rest.startsWith(".")) continue;
    rest = rest.slice(1).trimStart();
    let name: string | null = null;
    const quote = rest[0];
    if (quote === "\"" || quote === "'") {
      const end = rest.indexOf(quote, 1);
      if (end > 0) name = rest.slice(1, end);
    } else {
      const m = TOML_BARE_KEY.exec(rest);
      if (m) name = m[0];
    }
    if (name !== null && !names.includes(name)) names.push(name);
  }
  return names;
}

function codexServerNames(file: string): string[] {
  const text = readText(file);
  return text === null ? [] : tomlServerNames(text);
}

function exists(path: string): boolean {
  try { return existsSync(path); } catch { return false; }
}

/** The VS Code user data folders (stable and Insiders) whose `User/globalStorage` holds extension state. */
function vscodeUserDirs(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const base = platform === "win32" ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
    : platform === "darwin" ? join(home, "Library", "Application Support")
      : (env.XDG_CONFIG_HOME || join(home, ".config"));
  return ["Code", "Code - Insiders"].map((product) => join(base, product, "User"));
}

interface Places { home: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; copilotHome: string }

/** Whether each tool's user-level settings (file or folder) exist. */
function settingsPresent(id: ToolId, p: Places, programOnPath: (name: string) => boolean): boolean {
  const { home } = p;
  switch (id) {
    // Claude Code: user settings in ~/.claude/settings.json, inside ~/.claude.
    // https://code.claude.com/docs/en/settings
    case "claude": return exists(join(home, ".claude", "settings.json")) || exists(join(home, ".claude"));
    // Cursor: ~/.cursor (its hooks.json and mcp.json). https://cursor.com/docs/context/mcp
    case "cursor": return exists(join(home, ".cursor"));
    // Codex: ~/.codex (config.toml). https://developers.openai.com/codex/mcp
    case "codex": return exists(join(home, ".codex"));
    // GitHub Copilot CLI: as the hook detects it (copilotDetected): the CLI's own settings.json or logs in its folder, or the
    // `copilot` program on PATH. The folder alone is not enough: VS Code's Copilot Chat creates it too.
    // https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
    case "copilot": return exists(join(p.copilotHome, "settings.json")) || exists(join(p.copilotHome, "logs")) || programOnPath("copilot");
    // Windsurf: ~/.codeium/windsurf (mcp_config.json). Best effort: not confirmed against Windsurf's current documentation.
    case "windsurf": return exists(join(home, ".codeium", "windsurf"));
    // Gemini CLI: ~/.gemini (settings.json). https://geminicli.com/docs/reference/configuration/
    case "gemini": return exists(join(home, ".gemini"));
    // Cline: the VS Code extension's global storage folder (best effort: the folder is VS Code's, named for the extension
    // id), or the Cline CLI's ~/.cline (https://docs.cline.bot/mcp/configuring-mcp-servers).
    case "cline": return vscodeUserDirs(home, p.platform, p.env).some((dir) => exists(join(dir, "globalStorage", "saoudrizwan.claude-dev"))) || exists(join(home, ".cline"));
    // OpenCode: ~/.config/opencode (https://opencode.ai/docs/config/), or ~/.opencode.
    case "opencode": return exists(join(p.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")) || exists(join(home, ".config", "opencode")) || exists(join(home, ".opencode"));
    // Aider: any ~/.aider* (its ~/.aider.conf.yml, https://aider.chat/docs/config/aider_conf.html, and its ~/.aider folder).
    case "aider": try { return readdirSync(home).some((name) => name.startsWith(".aider")); } catch { return false; }
  }
}

/** The MCP server names in each tool's user-level MCP configuration, where that is a plain JSON (or TOML) file. Project
 *  files (`.mcp.json` and the like) are not read. */
function mcpNames(id: ToolId, p: Places): string[] {
  const { home } = p;
  switch (id) {
    // https://code.claude.com/docs/en/mcp: user-scoped servers in ~/.claude.json, `mcpServers`.
    case "claude": return jsonServerNames(join(home, ".claude.json"), "mcpServers");
    // https://cursor.com/docs/context/mcp: ~/.cursor/mcp.json, `mcpServers`.
    case "cursor": return jsonServerNames(join(home, ".cursor", "mcp.json"), "mcpServers");
    // https://developers.openai.com/codex/mcp: ~/.codex/config.toml, `[mcp_servers.<name>]`.
    case "codex": return codexServerNames(join(home, ".codex", "config.toml"));
    // https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers: ~/.copilot/mcp-config.json.
    case "copilot": return jsonServerNames(join(p.copilotHome, "mcp-config.json"), "mcpServers");
    // ~/.codeium/windsurf/mcp_config.json, `mcpServers` (best effort, see above).
    case "windsurf": return jsonServerNames(join(home, ".codeium", "windsurf", "mcp_config.json"), "mcpServers");
    // https://geminicli.com/docs/reference/configuration/: ~/.gemini/settings.json, `mcpServers`.
    case "gemini": return jsonServerNames(join(home, ".gemini", "settings.json"), "mcpServers");
    default: return [];
  }
}

function manifestVersion(roots: string[], pkg: string): string | null {
  for (const root of roots) {
    const text = readText(join(root, ...pkg.split("/"), "package.json"));
    if (text === null) continue;
    try {
      const version = parseVersion((JSON.parse(text) as { version?: unknown }).version);
      if (version) return version;
    } catch { /* not a manifest */ }
  }
  return null;
}

/** `<program> --version`, with no input, a 3 s limit and a neutral working folder (a project's own settings never apply).
 *  Null when it cannot start, exits with an error or runs past the limit. `args` go before `--version` (tests run a script). */
export function programVersion(program: string, options: { timeoutMs?: number; args?: string[] } = {}): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
  return new Promise((resolve) => {
    try {
      const child = execFile(program, [...(options.args ?? []), "--version"], { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024, cwd: tmpdir() },
        (error, stdout) => resolve(error ? null : parseVersion(stdout)));
      child.stdin?.end();
    } catch { resolve(null); }
  });
}

let npmRootMemo: Promise<string | null> | null = null;

/** `npm root -g`, once per process (3 s limit): the global folder an npm with another prefix installs into. */
function npmGlobalRoot(): Promise<string | null> {
  npmRootMemo ??= new Promise((resolve) => {
    try {
      const own = ownNpm();
      const run = own ? { program: own[0], args: [...own[1], "root", "-g"], shell: false as string | false } : npmOnPath(["root", "-g"]);
      if (!run) { resolve(null); return; }
      const child = execFile(run.program, run.args, { shell: run.shell || undefined, timeout: VERSION_TIMEOUT_MS, windowsHide: true, encoding: "utf8", cwd: tmpdir() },
        (error, stdout) => resolve(error ? null : (stdout.trim().split(/\r?\n/).pop() ?? "").trim() || null));
      child.stdin?.end();
    } catch { resolve(null); }
  });
  return npmRootMemo;
}

/** The usual global npm package folders, without asking npm. */
function defaultNpmRoots(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  if (env.npm_config_prefix) roots.push(platform === "win32" ? join(env.npm_config_prefix, "node_modules") : join(env.npm_config_prefix, "lib", "node_modules"));
  if (platform === "win32") roots.push(join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm", "node_modules"));
  else roots.push(join(home, ".npm-global", "lib", "node_modules"), "/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules", "/usr/lib/node_modules");
  return roots;
}

/** Which AI coding tools are on this computer: each one whose user-level settings exist (the Copilot CLI: as the hook
 *  detects it), or that the hook is installed for. A version alone never makes a tool present. At most 20 tools and 100 MCP server names. Never throws. */
export async function discoverTools(options: DiscoveryOptions = {}): Promise<ToolDiscovery> {
  const home = homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const places: Places = { home, platform, env, copilotHome: env.COPILOT_HOME || join(home, ".copilot") };
  const find = options.findProgram ?? ((name: string) => { try { return findProgram(name, { env, platform }); } catch { return null; } });
  const programOnPath = (name: string) => (platform === "win32" ? [name, `${name}.cmd`] : [name]).some((n) => find(n) !== null);
  const runVersion = options.runVersion ?? ((program: string) => programVersion(program));

  // Presence first, from settings alone (the Copilot CLI: also its program on PATH, as the hook detects it). Nothing is
  // run, and no version looked for, for a tool that is not present: a program of the same name elsewhere on PATH is never
  // executed and never makes a tool count as present.
  const present = new Map<ToolId, boolean>();
  const governed = new Map<ToolId, boolean>();
  for (const id of TOOL_IDS) {
    let found = false;
    try { found = settingsPresent(id, places, programOnPath); } catch { /* not present */ }
    present.set(id, found);
    const harness = HOOK_HARNESSES[id];
    let on = false;
    try { on = harness ? isHarnessConfigured(userHarnessFile(harness)) : false; } catch { /* not governed */ }
    governed.set(id, on);
  }
  const reported = TOOL_IDS.filter((id) => present.get(id) || governed.get(id));

  let roots = options.npmRoots ?? defaultNpmRoots(home, platform, env);
  const versions = new Map<ToolId, string | null>();
  for (const id of reported) { const pkg = NPM_PACKAGES[id]; versions.set(id, pkg ? manifestVersion(roots, pkg) : null); }
  // A present tool published to npm and not in the usual folders: ask npm where its global folder is, once.
  if (!options.npmRoots && reported.some((id) => NPM_PACKAGES[id] && versions.get(id) === null)) {
    const root = await npmGlobalRoot();
    if (root && !roots.includes(root)) {
      roots = [root];
      for (const id of reported) { const pkg = NPM_PACKAGES[id]; if (pkg && versions.get(id) === null) versions.set(id, manifestVersion(roots, pkg)); }
    }
  }
  // Otherwise the programs that answer `--version` and exit, for a tool whose settings are present only. On Windows the
  // lookup finds only real programs (.exe, .com), never a .cmd that would need a shell.
  await Promise.all(reported.map(async (id) => {
    const name = VERSION_PROGRAMS[id];
    if (!name || !present.get(id) || versions.get(id) !== null) return;
    const program = find(name);
    if (!program) return;
    try { versions.set(id, parseVersion(await runVersion(program))); } catch { /* null */ }
  }));

  const tools: ToolReport[] = [];
  const servers: McpServerReport[] = [];
  for (const id of reported) {
    if (tools.length < MAX_TOOLS) tools.push({ id, version: versions.get(id) ?? null, governed: governed.get(id) ?? false, settings_present: present.get(id) ?? false });
    let names: string[] = [];
    try { names = mcpNames(id, places); } catch { /* none */ }
    for (const raw of names) {
      if (servers.length >= MAX_MCP_SERVERS) break;
      const name = mcpServerName(raw);
      if (name && !servers.some((s) => s.tool === id && s.name === name)) servers.push({ tool: id, name });
    }
  }
  return { tools, mcp_servers: servers };
}

/** One line per tool for `status`: "Claude Code 2.1.4 · governed", "Cursor · present, not governed". */
export function toolLines(tools: ToolReport[]): string[] {
  return tools.map((t) => `${TOOL_LABELS[t.id] ?? t.id}${t.version ? ` ${t.version}` : ""} · ${t.governed ? "governed" : "present, not governed"}`);
}
