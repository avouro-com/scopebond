// MCP server profiles: what a known MCP tool call does, read from the ACTUAL tool name and arguments.
//
// A coding agent calls an MCP tool by server and tool name with JSON arguments. Today every such call is recorded as
// `mcp.tool.call` with a digest of its arguments. For the servers below, the call is also described as the taxonomy action
// it performs, so the rule that governs a push, a pull request, a file write, a SQL statement or a fetch governs it however
// it is reached:
//
//   github           create_pull_request → pr.open, merge_pull_request → pr.merge, push_files → git.push and a file.write
//                    per file, create_or_update_file → file.write and git.push, delete_file → file.write (delete) and git.push
//   filesystem       write_file, edit_file, create_directory, move_file → file.write; read_file, read_text_file,
//                    read_media_file, read_multiple_files, list_directory, directory_tree, search_files, get_file_info → file.read
//   postgres, sqlite, mysql
//                    query tools → db.exec, classified by the SQL classifier (verb, predicate class, risk) without its text
//   slack            post or reply → communication.send
//   playwright, puppeteer
//                    navigate → net.fetch (host only)
//   fetch            fetch → net.fetch (host, GET)
//   linear, jira     create or update an issue → work.item.create / work.item.update
//
// A server is recognised by a word of its configured name (`github`, `github-mcp`, `plugin_github_github`) or, when that names
// none, of what else names it (Cursor's server URL or launch command: `api.githubcopilot.com`, `server-github`), and a call is
// described only when its tool is one listed for that server. Any other server or tool stays the plain `mcp.tool.call` it
// always was. Only the named arguments are read (a path, a branch, a repository, an owner, a URL's host, the SQL to
// classify); everything else, file contents and message text included, is never read and stays only in the call's
// `args_digest`. Names are digested; SQL text, message text and URLs' paths and queries are never recorded.

import { digest, scrubParam } from "./minimize.js";
import { classifySql } from "./sql-classify.js";
import type { TargetOperation } from "./typed-targets.js";

type Args = Record<string, unknown>;

/** The profile a configured server name belongs to, by its words. */
export function mcpProfileOf(server: string): string | undefined {
  const words = new Set(server.toLowerCase().split(/[^a-z0-9]+/));
  for (const [profile, names] of PROFILE_WORDS) if (names.some((n) => words.has(n))) return profile;
  return undefined;
}

const PROFILE_WORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["github", ["github", "githubcopilot"]],
  ["filesystem", ["filesystem"]],
  ["postgres", ["postgres", "postgresql", "pg"]],
  ["sqlite", ["sqlite", "sqlite3"]],
  ["mysql", ["mysql", "mariadb"]],
  ["slack", ["slack"]],
  ["browser", ["playwright", "puppeteer"]],
  ["fetch", ["fetch"]],
  ["linear", ["linear"]],
  ["jira", ["jira", "atlassian"]],
];

const text = (args: Args, ...keys: string[]): string | undefined => {
  for (const k of keys) { const v = args[k]; if (typeof v === "string" && v !== "") return v; if (typeof v === "number" && Number.isFinite(v)) return String(v); }
  return undefined;
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** `owner/repo` from the arguments, only when both are plain names. */
const repoOf = (args: Args): string | undefined => {
  const owner = text(args, "owner");
  const repo = text(args, "repo");
  return owner && repo && NAME.test(owner) && NAME.test(repo) ? `${owner}/${repo}` : undefined;
};
/** A branch or base name as the push rules read it: scrubbed like every recorded ref. */
const refOf = (value: string | undefined): string | undefined => (value === undefined ? undefined : scrubParam(value));
const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : undefined;
  } catch { return undefined; }
};
const keyed = (...parts: string[]): string => digest(["scopebond:target/v1", ...parts]);

function act(action_type: string, params: Args): TargetOperation {
  const out: Args = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined) out[k] = v;
  return { action_type, params: out };
}

function github(tool: string, args: Args): TargetOperation[] {
  const repo = repoOf(args);
  const branch = refOf(text(args, "branch"));
  // A file written through the GitHub API is a commit on that branch: the push rules see it as a push to the branch.
  const push = (): TargetOperation[] => (branch ? [act("git.push", { repo, ref: branch, force: false })] : []);
  switch (tool) {
    case "create_pull_request":
      return repo ? [act("pr.open", { repo, base: refOf(text(args, "base")), head: refOf(text(args, "head")) })] : [];
    case "merge_pull_request":
      return repo ? [act("pr.merge", { repo })] : [];
    case "push_files": {
      const files = Array.isArray(args.files) ? args.files : [];
      const paths = files.map((f) => (f && typeof f === "object" ? text(f as Args, "path") : undefined)).filter((p): p is string => p !== undefined);
      return [...push(), ...paths.map((path) => act("file.write", { path, repo }))];
    }
    case "create_or_update_file": {
      const path = text(args, "path");
      return path ? [act("file.write", { path, repo }), ...push()] : [];
    }
    case "delete_file": {
      const path = text(args, "path");
      return path ? [act("file.write", { path, repo, delete: true }), ...push()] : [];
    }
    default: return [];
  }
}

const FS_READ = new Set(["read_file", "read_text_file", "read_media_file", "list_directory", "list_directory_with_sizes", "directory_tree", "search_files", "get_file_info"]);
const FS_WRITE = new Set(["write_file", "edit_file", "create_directory"]);

function filesystem(tool: string, args: Args): TargetOperation[] {
  if (FS_READ.has(tool)) { const path = text(args, "path"); return path ? [act("file.read", { path })] : []; }
  if (tool === "read_multiple_files") {
    const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string" && p !== "") : [];
    return paths.map((path) => act("file.read", { path }));
  }
  if (FS_WRITE.has(tool)) { const path = text(args, "path"); return path ? [act("file.write", { path })] : []; }
  if (tool === "move_file") {
    return [text(args, "source"), text(args, "destination")].filter((p): p is string => p !== undefined).map((path) => act("file.write", { path }));
  }
  if (tool === "delete_file" || tool === "delete") { const path = text(args, "path"); return path ? [act("file.write", { path, delete: true })] : []; }
  return [];
}

const SQL_TOOLS: Readonly<Record<string, readonly string[]>> = {
  postgres: ["query", "execute_sql", "run_query", "execute_query"],
  sqlite: ["read_query", "write_query", "create_table", "query", "execute_sql"],
  mysql: ["query", "mysql_query", "execute_sql", "run_query", "execute_query"],
};

function sql(profile: string, tool: string, args: Args): TargetOperation[] {
  if (!(SQL_TOOLS[profile] ?? []).includes(tool)) return [];
  const statement = text(args, "sql", "query", "statement");
  const c = statement === undefined ? null : classifySql(statement);
  // SQL the classifier cannot place is recorded as unknown, never as an ordinary statement.
  const risk = c === null ? "unknown" : c.destructive || (c.verb === "update" && c.predicate_class === "all") ? "destructive" : "ordinary";
  return [act("db.exec", { provider: profile, verb: c?.verb ?? "unknown", scope: "unknown", risk, ...(c ? { predicate_class: c.predicate_class } : {}) })];
}

function slack(server: string, tool: string, args: Args): TargetOperation[] {
  if (!["slack_post_message", "slack_reply_to_thread", "post_message", "send_message", "chat_post_message", "reply_to_thread"].includes(tool)) return [];
  const channel = text(args, "channel_id", "channel", "conversation_id");
  return [act("communication.send", { provider: "slack", channel_digest: channel ? keyed("slack", server, channel) : undefined, risk_class: "sensitive" })];
}

function navigate(tool: string, args: Args): TargetOperation[] {
  if (!["browser_navigate", "puppeteer_navigate", "navigate", "playwright_navigate"].includes(tool)) return [];
  const host = hostOf(text(args, "url"));
  return host ? [act("net.fetch", { host, method: "GET" })] : [];
}

function fetchTool(tool: string, args: Args): TargetOperation[] {
  if (tool !== "fetch" && tool !== "fetch_url") return [];
  const host = hostOf(text(args, "url"));
  return host ? [act("net.fetch", { host, method: "GET" })] : [];
}

function tracker(provider: "linear" | "jira", server: string, tool: string, args: Args): TargetOperation[] {
  const create = ["create_issue", "createJiraIssue", "jira_create_issue", "linear_create_issue"].includes(tool);
  const update = ["update_issue", "editJiraIssue", "jira_update_issue", "linear_update_issue"].includes(tool);
  if (!create && !update) return [];
  const project = text(args, "projectKey", "project", "projectId", "team", "teamId");
  return [act(create ? "work.item.create" : "work.item.update", {
    provider, project_digest: project ? keyed(provider, server, project) : undefined, risk_class: "routine",
  })];
}

/**
 * The taxonomy actions a known MCP tool call performs, or none. Pure and deterministic. File paths are returned as the
 * call names them; the mapper resolves them against the working folder like every other path. Each action carries
 * `via` (the profile) and `derived_from: "mcp.tool.call"`.
 */
export function deriveMcpOperations(server: string, tool: string, args: unknown, hint?: string): TargetOperation[] {
  // The configured name first; then, when it names no profile, what else names the server (its URL or launch command).
  const profile = mcpProfileOf(server) ?? (hint ? mcpProfileOf(hint) : undefined);
  if (!profile) return [];
  const input: Args = args && typeof args === "object" && !Array.isArray(args) ? (args as Args) : {};
  let ops: TargetOperation[];
  try {
    switch (profile) {
      case "github": ops = github(tool, input); break;
      case "filesystem": ops = filesystem(tool, input); break;
      case "postgres": case "sqlite": case "mysql": ops = sql(profile, tool, input); break;
      case "slack": ops = slack(server, tool, input); break;
      case "browser": ops = navigate(tool, input); break;
      case "fetch": ops = fetchTool(tool, input); break;
      case "linear": case "jira": ops = tracker(profile, server, tool, input); break;
      default: ops = [];
    }
  } catch { return []; }
  return ops.map((op) => ({ action_type: op.action_type, params: { ...op.params, via: profile === "browser" ? "browser" : profile, derived_from: "mcp.tool.call" } }));
}
