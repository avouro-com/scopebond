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

// Normalize Windows backslash separators to "/" so a path guard written with "/"
// (the hook's own .scopebond/**, .claude/settings*, *.key rules) cannot be bypassed
// on Windows by a backslash path. The taxonomy path space is "/"-separated.
const normPath = (s: string): string => s.replace(/\\/g, "/");

const rel = (value: unknown, cwd?: string): string => {
  const s = normPath(String(value ?? ""));
  const c = cwd ? normPath(cwd) : undefined;
  if (c && s.startsWith(c)) return s.slice(c.length).replace(/^\/+/, "");
  return s;
};

// Shell programs that READ a file given as an operand. A read of the signing keys
// or a secret file through the shell (`cat .scopebond/attester.key`) must reach the
// same file.read guard as the Read tool, or the cooperative protection is a fiction.
const READERS = new Set([
  "cat", "tac", "less", "more", "head", "tail", "nl", "od", "xxd", "hexdump",
  "strings", "base64", "bat", "type", "get-content", "gc",
]);

/** Derive the additional file.read / file.write intents a simple shell command
 *  implies: operands of a reader program, and the targets of `>`/`>>` redirections.
 *  These flow through the same protect-read / protect-write clauses as the native
 *  file tools. A false positive (a non-protected operand) is a harmless extra
 *  receipt that the starter policy allows. */
function fileOpsFromShell(sc: SimpleCommand, cwd?: string): Mapped[] {
  const ops: Mapped[] = [];
  if (READERS.has(sc.program.toLowerCase())) {
    for (const t of sc.argv) {
      if (t.startsWith("-") || /^\d+$/.test(t)) continue; // skip flags and flag values (head -n 5)
      ops.push({ intent: { action_type: "file.read", params: { path: rel(scrubParam(t), cwd) } }, evaluated: true, source: "shell" });
    }
  }
  for (let i = 0; i < sc.argv.length; i++) {
    // `> file`, `>>file`, `2>file`, `&>file` — the token after the redirection op is a write target.
    const m = /^(?:\d|&)?(>>?)(.*)$/.exec(sc.argv[i]);
    if (!m) continue;
    const target = m[2] || sc.argv[i + 1];
    if (target && !target.startsWith("-") && !/^(?:\d|&)?>>?/.test(target))
      ops.push({ intent: { action_type: "file.write", params: { path: rel(scrubParam(target), cwd) } }, evaluated: true, source: "shell" });
  }
  return ops;
}

/** Map one parsed simple command to the intents it implies: the git.push or
 *  shell.exec itself, plus any file reads/writes it performs. An opaque
 *  (unparseable) command becomes a single un-evaluated shell.exec so it fails closed. */
function mapSimpleCommand(sc: SimpleCommand, cwd?: string): Mapped[] {
  if (sc.opaque) {
    return [{
      intent: { action_type: "shell.exec", params: { command: redactCommand(sc.raw), program: "", ...(cwd ? { cwd } : {}) } },
      evaluated: false, source: "shell",
    }];
  }
  const push = parseGitPush(sc);
  if (push) {
    const params: Record<string, unknown> = { force: push.force };
    if (push.remote !== undefined) params.remote = scrubParam(push.remote);
    if (push.ref !== undefined) params.ref = scrubParam(push.ref);
    return [{ intent: { action_type: "git.push", params }, evaluated: true, source: "shell" }];
  }
  const exec: Mapped = {
    intent: {
      action_type: "shell.exec",
      // Scrub before storing: the raw command through the blob-aware scrubber, and
      // the whole first token BEFORE taking its basename, so a bare-secret command
      // containing "/" cannot leak a path-fragment as the program.
      params: { command: redactCommand(sc.raw), program: basename(scrubSecrets(sc.programRaw)), ...(cwd ? { cwd } : {}) },
    },
    evaluated: true, source: "shell",
  };
  return [exec, ...fileOpsFromShell(sc, cwd)];
}

/** Decompose a shell command into the intents it will run. An empty command yields
 *  a single un-evaluated placeholder (nothing to grant). */
function mapShell(command: string, cwd?: string): Mapped[] {
  const commands = decomposeShell(command);
  if (commands.length === 0) {
    return [{ intent: { action_type: "shell.exec", params: { command: redactCommand(command), program: "" } }, evaluated: false, source: "shell" }];
  }
  return commands.flatMap((sc) => mapSimpleCommand(sc, cwd));
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

/** Extract every path changed by an apply_patch call. Codex sends the patch in
 *  `tool_input.command`; recording one file.write per path lets the same protected-
 *  path rules cover file edits made by Claude Code, Cursor and Codex. A patch with
 *  no recognizable path is deliberately not evaluated so strict mode can deny it. */
function mapApplyPatch(command: string, cwd?: string): Mapped[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const prefixes = ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"];
  for (const line of command.split(/\r?\n/)) {
    const prefix = prefixes.find((candidate) => line.startsWith(candidate));
    if (!prefix) continue;
    const path = rel(scrubParam(line.slice(prefix.length).trim()), cwd);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  if (paths.length === 0) {
    return one({ action_type: "file.write", params: { path: "" } }, false, "apply_patch");
  }
  return paths.map((path) => ({
    intent: { action_type: "file.write", params: { path } },
    evaluated: true,
    source: "apply_patch",
  }));
}

const one = (intent: NormalizedIntent, evaluated: boolean, source: string): Mapped[] => [{ intent, evaluated, source }];

/** A bare `git push` (no ref) pushes the current branch. The mapper cannot know it,
 *  so the runtime resolves it and fills it in here, before evaluation — otherwise the
 *  starter policy's ref bound would fail-closed on every plain push. Only git.push
 *  intents with no ref are touched. */
export function fillPushBranch(mapped: Mapped[], branch: string | null | undefined): Mapped[] {
  if (!branch) return mapped;
  return mapped.map((m) =>
    m.intent.action_type === "git.push" && m.intent.params.ref === undefined
      ? { ...m, intent: { ...m.intent, params: { ...m.intent.params, ref: scrubParam(branch) } } }
      : m);
}

/** Map a Claude Code PreToolUse payload to the normalized actions it represents. */
export function mapClaudeToolUse(input: Record<string, unknown>): Mapped[] {
  const name = String(input?.tool_name ?? "");
  const ti = (input?.tool_input ?? {}) as Record<string, unknown>;
  const cwd = input?.cwd ? String(input.cwd) : undefined;
  // Every shell-executing tool decomposes the same way. Claude Code exposes Bash;
  // some hosts/agents expose PowerShell or a generic Shell tool — mapping only Bash
  // let a PowerShell command (e.g. `Remove-Item -Recurse -Force .`) fall through to
  // an un-evaluated tool.<name> and be allowed.
  if (name === "Bash" || name === "PowerShell" || name === "Shell")
    return mapShell(String(ti.command ?? ""), cwd);
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

/** Map an OpenAI Codex PreToolUse payload. Codex reports shell and unified-exec
 *  calls as `Bash`, file patches as `apply_patch`, and MCP calls by their native
 *  `mcp__server__tool` name. Other local tools remain visible but unevaluated. */
export function mapCodexToolUse(input: Record<string, unknown>): Mapped[] {
  const name = String(input?.tool_name ?? "");
  const ti = (input?.tool_input ?? {}) as Record<string, unknown>;
  const cwd = input?.cwd ? String(input.cwd) : undefined;
  if (name === "Bash" || name === "PowerShell" || name === "Shell" || name === "exec_command" || name === "unified_exec")
    return mapShell(String(ti.command ?? ti.cmd ?? ""), cwd);
  if (name === "apply_patch" || name === "Edit" || name === "Write")
    return mapApplyPatch(String(ti.command ?? ti.patch ?? ""), cwd);
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
