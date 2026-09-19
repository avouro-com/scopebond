// The mapper: a pure function from a coding agent's native tool call to a
// normalized Scopebond action (Action Taxonomy v1). This is the connector's core
// — deterministic and side-effect free, so it can be conformance-tested directly.

import { digest, redactCommand } from "./minimize.js";

export interface NormalizedIntent {
  action_type: string;
  params: Record<string, unknown>;
}
export interface Mapped {
  intent: NormalizedIntent;
  /** false when no taxonomy type applies: emitted as tool.<name> and routed to the
   *  observation path (not_evaluated), never granted. */
  evaluated: boolean;
  /** The native tool/event name, for diagnostics. */
  source: string;
}

const rel = (value: unknown, cwd?: string): string => {
  const s = String(value ?? "");
  if (cwd && s.startsWith(cwd)) return s.slice(cwd.length).replace(/^[\\/]+/, "");
  return s;
};

/** The invoked program's basename, after stripping sudo and `env VAR=val` prefixes. */
function programOf(command: string): string {
  const stripped = command.trim().replace(/^sudo\s+/, "").replace(/^(?:env\s+[^\s=]+=\S+\s+)+/, "");
  const first = stripped.split(/\s+/)[0] ?? "";
  return first.replace(/^.*[\\/]/, "");
}

// Best-effort `git push [--force|-f] [remote] [ref]` parse. Ambiguous pushes omit
// the ref, which a ref bound then denies (fail closed).
function parseGitPush(command: string): Record<string, unknown> | null {
  const t = command.trim().replace(/^sudo\s+/, "");
  if (!/^git\s+push(\s|$)/.test(t)) return null;
  const force = /(?:^|\s)(?:--force\b|--force-with-lease\b|-f\b)/.test(t);
  const rest = t.replace(/^git\s+push\b/, "").trim();
  const positional = rest.split(/\s+/).filter((a) => a && !a.startsWith("-"));
  const params: Record<string, unknown> = { force };
  if (positional[0]) params.remote = positional[0];
  if (positional[1]) params.ref = positional[1].replace(/^[^:]*:/, ""); // src:dst → dst
  return params;
}

function mapShell(command: string, cwd?: string): Mapped {
  const push = parseGitPush(command);
  if (push) return { intent: { action_type: "git.push", params: push }, evaluated: true, source: "shell" };
  return {
    intent: {
      action_type: "shell.exec",
      params: { command: redactCommand(command), program: programOf(command), ...(cwd ? { cwd } : {}) },
    },
    evaluated: true, source: "shell",
  };
}

function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__");
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

function splitUrl(url: string): { host: string; path: string } {
  try { const u = new URL(url); return { host: u.host, path: u.pathname }; }
  catch { return { host: url, path: "" }; }
}

/** Map a Claude Code PreToolUse payload to a normalized taxonomy action. */
export function mapClaudeToolUse(input: Record<string, unknown>): Mapped {
  const name = String(input?.tool_name ?? "");
  const ti = (input?.tool_input ?? {}) as Record<string, unknown>;
  const cwd = input?.cwd ? String(input.cwd) : undefined;
  if (name === "Bash") return mapShell(String(ti.command ?? ""), cwd);
  if (name === "Write" || name === "Edit" || name === "MultiEdit")
    return { intent: { action_type: "file.write", params: { path: rel(ti.file_path, cwd) } }, evaluated: true, source: name };
  if (name === "NotebookEdit")
    return { intent: { action_type: "file.write", params: { path: rel(ti.notebook_path ?? ti.file_path, cwd) } }, evaluated: true, source: name };
  if (name === "Read")
    return { intent: { action_type: "file.read", params: { path: rel(ti.file_path, cwd) } }, evaluated: true, source: name };
  if (name === "WebFetch") {
    const { host, path } = splitUrl(String(ti.url ?? ""));
    return { intent: { action_type: "net.fetch", params: { host, path, method: "GET" } }, evaluated: true, source: name };
  }
  const mcp = parseMcpName(name);
  if (mcp) return { intent: { action_type: "mcp.tool.call", params: { server: mcp.server, tool: mcp.tool, args_digest: digest(ti) } }, evaluated: true, source: name };
  return { intent: { action_type: `tool.${name.toLowerCase()}`, params: {} }, evaluated: false, source: name };
}

/** Map a Cursor hook event to a normalized taxonomy action. */
export function mapCursorEvent(event: string, payload: Record<string, unknown>): Mapped {
  const p = payload ?? {};
  const cwd = p.cwd ? String(p.cwd) : undefined;
  switch (event) {
    case "beforeShellExecution":
      return mapShell(String(p.command ?? ""), cwd);
    case "beforeReadFile":
      return { intent: { action_type: "file.read", params: { path: rel(p.path ?? p.file_path, cwd) } }, evaluated: true, source: event };
    case "afterFileEdit":
      return { intent: { action_type: "file.write", params: { path: rel(p.path ?? p.file_path, cwd) } }, evaluated: true, source: event };
    case "beforeMCPExecution": {
      const server = String(p.server ?? p.server_name ?? "");
      const tool = String(p.tool ?? p.tool_name ?? "");
      return { intent: { action_type: "mcp.tool.call", params: { server, tool, args_digest: digest(p.args ?? p.arguments ?? {}) } }, evaluated: true, source: event };
    }
    default:
      return { intent: { action_type: `tool.${event.toLowerCase()}`, params: {} }, evaluated: false, source: event };
  }
}
