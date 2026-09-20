// The mapper: a pure function from a coding agent's native tool call to the
// normalized Scopebond actions (Action Taxonomy v1) it represents. Deterministic
// and side-effect free, so it can be conformance-tested directly.
//
// A shell tool call can carry several commands (`a && b`, `$(c)`, `bash -c '…'`);
// the mapper decomposes it and returns one intent per simple command, so the
// runtime evaluates every one and denies if any is out of policy. Non-shell tools
// map to a single intent (a one-element array).

import { digest, redactCommand, scrubParam, scrubSecrets } from "./minimize.js";
import { decomposeShell, parseGitPush, type SimpleCommand } from "./shell.js";

export interface NormalizedIntent {
  action_type: string;
  params: Record<string, unknown>;
}
export interface Mapped {
  intent: NormalizedIntent;
  /** false when no taxonomy type applies (an unknown tool, or a shell command that
   *  could not be parsed): emitted to the observation path (not_evaluated) in normal
   *  mode and denied by the closed allowlist in strict mode — never granted. */
  evaluated: boolean;
  /** The native tool/event name, for diagnostics. */
  source: string;
}

const basename = (t: string): string => t.replace(/^.*[\\/]/, "");

const rel = (value: unknown, cwd?: string): string => {
  const s = String(value ?? "");
  if (cwd && s.startsWith(cwd)) return s.slice(cwd.length).replace(/^[\\/]+/, "");
  return s;
};

/** Map one parsed simple command to a git.push or shell.exec intent. An opaque
 *  (unparseable) command becomes an un-evaluated shell.exec so it fails closed. */
function mapSimpleCommand(sc: SimpleCommand, cwd?: string): Mapped {
  if (sc.opaque) {
    return {
      intent: { action_type: "shell.exec", params: { command: redactCommand(sc.raw), program: "", ...(cwd ? { cwd } : {}) } },
      evaluated: false, source: "shell",
    };
  }
  const push = parseGitPush(sc);
  if (push) {
    const params: Record<string, unknown> = { force: push.force };
    if (push.remote !== undefined) params.remote = scrubParam(push.remote);
    if (push.ref !== undefined) params.ref = scrubParam(push.ref);
    return { intent: { action_type: "git.push", params }, evaluated: true, source: "shell" };
  }
  return {
    intent: {
      action_type: "shell.exec",
      // Scrub before storing: the raw command through the blob-aware scrubber, and
      // the whole first token BEFORE taking its basename, so a bare-secret command
      // containing "/" cannot leak a path-fragment as the program.
      params: { command: redactCommand(sc.raw), program: basename(scrubSecrets(sc.programRaw)), ...(cwd ? { cwd } : {}) },
    },
    evaluated: true, source: "shell",
  };
}

/** Decompose a shell command into one intent per simple command it will run. An
 *  empty command yields a single un-evaluated placeholder (nothing to grant). */
function mapShell(command: string, cwd?: string): Mapped[] {
  const commands = decomposeShell(command);
  if (commands.length === 0) {
    return [{ intent: { action_type: "shell.exec", params: { command: redactCommand(command), program: "" } }, evaluated: false, source: "shell" }];
  }
  return commands.map((sc) => mapSimpleCommand(sc, cwd));
}

function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

function splitUrl(url: string): { host: string; path: string } {
  // The query string is dropped; a token in the path or an unparseable URL is scrubbed.
  try { const u = new URL(url); return { host: u.host, path: scrubParam(u.pathname) }; }
  catch { return { host: scrubParam(url), path: "" }; }
}

const one = (intent: NormalizedIntent, evaluated: boolean, source: string): Mapped[] => [{ intent, evaluated, source }];

/** Map a Claude Code PreToolUse payload to the normalized actions it represents. */
export function mapClaudeToolUse(input: Record<string, unknown>): Mapped[] {
  const name = String(input?.tool_name ?? "");
  const ti = (input?.tool_input ?? {}) as Record<string, unknown>;
  const cwd = input?.cwd ? String(input.cwd) : undefined;
  if (name === "Bash") return mapShell(String(ti.command ?? ""), cwd);
  if (name === "Write" || name === "Edit" || name === "MultiEdit")
    return one({ action_type: "file.write", params: { path: rel(ti.file_path, cwd) } }, true, name);
  if (name === "NotebookEdit")
    return one({ action_type: "file.write", params: { path: rel(ti.notebook_path ?? ti.file_path, cwd) } }, true, name);
  if (name === "Read")
    return one({ action_type: "file.read", params: { path: rel(ti.file_path, cwd) } }, true, name);
  if (name === "WebFetch") {
    const { host, path } = splitUrl(String(ti.url ?? ""));
    return one({ action_type: "net.fetch", params: { host, path, method: "GET" } }, true, name);
  }
  const mcp = parseMcpName(name);
  if (mcp) return one({ action_type: "mcp.tool.call", params: { server: mcp.server, tool: mcp.tool, args_digest: digest(ti) } }, true, name);
  return one({ action_type: `tool.${name.toLowerCase()}`, params: {} }, false, name);
}

/** Map a Cursor hook event to the normalized actions it represents. */
export function mapCursorEvent(event: string, payload: Record<string, unknown>): Mapped[] {
  const p = payload ?? {};
  const cwd = p.cwd ? String(p.cwd) : undefined;
  switch (event) {
    case "beforeShellExecution":
      return mapShell(String(p.command ?? ""), cwd);
    case "beforeReadFile":
      return one({ action_type: "file.read", params: { path: rel(p.path ?? p.file_path, cwd) } }, true, event);
    case "afterFileEdit":
      return one({ action_type: "file.write", params: { path: rel(p.path ?? p.file_path, cwd) } }, true, event);
    case "beforeMCPExecution": {
      const server = String(p.server ?? p.server_name ?? "");
      const tool = String(p.tool ?? p.tool_name ?? "");
      return one({ action_type: "mcp.tool.call", params: { server, tool, args_digest: digest(p.args ?? p.arguments ?? {}) } }, true, event);
    }
    default:
      return one({ action_type: `tool.${event.toLowerCase()}`, params: {} }, false, event);
  }
}
