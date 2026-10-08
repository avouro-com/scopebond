// Typed operations derived from the ACTUAL request the hook is about to let through: the
// shell command line or the tool call input, never a model-written summary. Each function
// returns a closed operation (git, github_resource, package) or null when the request cannot be
// described honestly. A fact that cannot be read stays unknown: an unresolved ref or remote
// is reported as `resolution: "unresolved"`, an unknown package fact is omitted or `unknown`,
// and nothing here claims a complete picture (a bare `npm install` names no packages, so it
// has no package operation at all rather than an empty or guessed one).
//
// Nothing raw leaves this module: remotes, refs, repositories, pull requests and packages
// are reduced to installation-keyed opaque ids, or to public package coordinates (name,
// version, registry host) which are the point of a dependency record. Credentials embedded in
// a URL are stripped before anything is keyed or recorded.
//
// The git and package derivations read only the local working tree (no network, no
// process other than a short `git` call). GitHub pull request updates and merges name the
// pull request only by number, so their head and base commits come from a platform read-back
// that this hook does not perform by default: they are typed only when the caller supplies a
// resolver, and are otherwise left as plain shell actions.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMcpName } from "./map.js";
import { decomposeShell, gitArgs, canonProgram, type SimpleCommand } from "./shell.js";
import { scrubParam } from "./minimize.js";
import { scan, flagValue } from "./scan.js";
import { deriveInfraOperation, fetchOperation, parseDestination, type FileProbe } from "./typed-infra.js";
import type { BindingKey } from "./observation.js";

export type Operation = Record<string, unknown>;

/** Read-only view of the local repository. Injected in tests. */
export interface GitProbe {
  /** HEAD commit id, or null when unreadable. */
  head(cwd: string): string | null;
  /** Current branch short name, or null when detached or unreadable. */
  branch(cwd: string): string | null;
  /** The URL a remote name resolves to for pushing, or null. */
  remoteUrl(cwd: string, remote: string): string | null;
  /** The remote a plain push from this branch uses (`origin` unless configured). */
  defaultRemote(cwd: string, branch: string | null): string;
  /** Commit id a revision resolves to locally, or null. */
  revParse(cwd: string, rev: string): string | null;
}

const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
    return out === "" ? null : out;
  } catch { return null; }
}

export const systemGit: GitProbe = {
  head: (cwd) => { const s = git(cwd, ["rev-parse", "HEAD"]); return s && SHA.test(s) ? s : null; },
  branch: (cwd) => git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  remoteUrl: (cwd, remote) => git(cwd, ["remote", "get-url", "--push", remote]),
  defaultRemote: (cwd, branch) => (branch && git(cwd, ["config", "--get", `branch.${branch}.pushRemote`])) || (branch && git(cwd, ["config", "--get", `branch.${branch}.remote`])) || "origin",
  revParse: (cwd, rev) => { if (rev.startsWith("-")) return null; const s = git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]); return s && SHA.test(s) ? s : null; },
};

export interface GithubRepo { host: string; owner: string; repo: string }

export interface TypedContext {
  key: BindingKey;
  cwd: string;
  /** Keyed id of the workspace repository. */
  repositoryId: string;
  referenceSetVersion: string;
  probe?: GitProbe;
  isProtectedRef?: (ref: string) => boolean;
  /** The required-check policy version the workspace configured, when known. Otherwise
   *  merge and release operations carry `unbound`, which no reference set matches. */
  requiredCheckPolicyVersion?: string;
  /** Platform read-back for a pull request named only by number. Absent by default. */
  resolvePullRequest?: (repo: GithubRepo, number: string) => { head_sha: string; base_sha: string } | null;
  /** The pinned `packageManager` of the project, when it names this manager. */
  packageManagerVersion?: (cwd: string, manager: string) => string | undefined;
  /** Local files and environment the Cloudflare, database and network derivations read. The real ones by default. */
  files?: FileProbe;
  env?: (name: string) => string | undefined;
}

export const UNBOUND = "unbound";

/** The opaque id this installation gives a value, so a reference set (protected refs, approved
 *  remotes and repositories) can be written in the ids observations carry. Null for a value
 *  that cannot be read as that kind. Kinds: ref, remote, ghrepo, repo (a workspace path as the
 *  hook sees it), mcp (server, tool) and mcp-resource (kind, value), net-dest (host, port), cf (resource kind, name) and database (pg or sqlite, key). */
export function keyedIdFor(key: BindingKey, kind: string, values: string[]): string | null {
  const [a, b] = values;
  if (kind === "ref" && a) return key.resourceId("ref", a.replace(/^refs\/heads\//, ""));
  if (kind === "remote" && a) { const n = normalizeRemote(a); return n ? key.resourceId("remote", remoteKey(n)) : null; }
  if (kind === "ghrepo" && a) { const r = parseRepoFlag(a) ?? githubRepoOf(normalizeRemote(a)); return r ? key.resourceId("ghrepo", githubRepoKey(r)) : null; }
  if (kind === "repo" && a) return key.resourceId("repo", a);
  if (kind === "mcp" && a && b) return key.resourceId("mcp", `${a}\0${b}`);
  if (kind === "mcp-resource" && a && b) return key.resourceId(`mcp:${a}`, b);
  // Destinations and Cloudflare resources, as the network, cloudflare_resource and database operations key them.
  if (kind === "net-dest" && a && b && /^[0-9]{1,5}$/.test(b)) { const d = parseDestination(`https://${a}`, false); return d ? key.resourceId("net-dest", `${d.host}:${b}`) : null; }
  if (kind === "cf" && a && b && ["worker", "pages_project", "pages_deployment", "d1_database", "r2_bucket", "r2_object"].includes(a)) return key.resourceId(`cf:${a}`, b);
  if (kind === "database" && a && b && (a === "pg" || a === "sqlite")) return key.resourceId(a, b);
  return null;
}
const defaultProtected = (ref: string): boolean => /^(main|master)$|^release\//i.test(ref);
const probeOf = (ctx: TypedContext): GitProbe => ctx.probe ?? systemGit;

function common(ctx: TypedContext, request: unknown): Operation {
  return {
    environment_class: "unknown", reference_set_version: ctx.referenceSetVersion,
    request_digest: ctx.key.requestDigest(request), digest_key_generation: ctx.key.generation,
  };
}

// ---- remotes and repositories ---------------------------------------------------------------------

/** A remote reduced to `host` and `path`, with credentials, query, fragment and a trailing
 *  `.git` removed. Null for anything that is not readable as a remote (an unexpanded variable,
 *  an empty string). Local paths keep their path and use the host `local`. */
export function normalizeRemote(url: string): { host: string; path: string } | null {
  const text = url.trim();
  if (text === "" || /[$`\s]/.test(text)) return null;
  // Slashes are trimmed by scanning, and the query is cut at its first marker, so no
  // backtracking pattern runs over a remote a caller supplied.
  const strip = (p: string): string => {
    const cut = p.search(/[?#]/);
    const s = (cut === -1 ? p : p.slice(0, cut)).replace(/\\/g, "/");
    let end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
    let start = 0;
    const body = s.slice(0, end).replace(/\.git$/, "");
    while (start < body.length && body.charCodeAt(start) === 47) start++;
    return body.slice(start);
  };
  // Userinfo runs to the LAST "@" before the path, as URL parsers (and npm, pip) read it: a password may contain "@". Found by
  // scanning, not by a pattern, so no input can make it backtrack.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text);
  if (scheme && !/^file$/i.test(text.slice(0, 4))) {
    const rest = text.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    const authority = slash > 0 ? rest.slice(0, slash) : "";
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    const colon = hostPort.indexOf(":");
    const host = colon === -1 ? hostPort : /^\d+$/.test(hostPort.slice(colon + 1)) ? hostPort.slice(0, colon) : "";
    const path = slash > 0 ? rest.slice(slash + 1) : "";
    if (host && path) return { host: host.toLowerCase(), path: strip(path) };
  }
  let m: RegExpExecArray | null;
  m = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)([^\s]+)$/.exec(text);
  if (m && !/^[A-Za-z]$/.test(m[1])) return { host: m[1].toLowerCase(), path: strip(m[2]) };
  // A local path: a drive-letter or POSIX path, absolute or relative.
  const local = strip(text.replace(/^file:\/\/\/?/i, ""));
  if (local === "") return null;
  return { host: "local", path: /^[A-Za-z]:/.test(local) ? local.toLowerCase() : local };
}

const remoteKey = (r: { host: string; path: string }): string => `${r.host}/${r.host === "github.com" ? r.path.toLowerCase() : r.path}`;

function githubRepoOf(remote: { host: string; path: string } | null): GithubRepo | null {
  if (!remote || remote.host === "local") return null;
  const parts = remote.path.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { host: remote.host, owner: parts[0], repo: parts[1] };
}

const githubRepoKey = (r: GithubRepo): string => `${r.host}/${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`;

/** `OWNER/REPO` or `HOST/OWNER/REPO` as `gh --repo` takes it. */
function parseRepoFlag(value: string): GithubRepo | null {
  const parts = value.replace(/\.git$/, "").split("/");
  if (parts.some((p) => p === "" || /[\s$`]/.test(p))) return null;
  if (parts.length === 2) return { host: "github.com", owner: parts[0], repo: parts[1] };
  if (parts.length === 3) return { host: parts[0].toLowerCase(), owner: parts[1], repo: parts[2] };
  return null;
}

// ---- git -----------------------------------------------------------------------------------------------

/** The `git` operation for one dispatched push, from the parameters the hook evaluated
 *  (`ref`, `remote`, `force`, `delete`, `all`) and the local repository. */
export function gitPushOperation(params: Record<string, unknown>, ctx: TypedContext, headSha?: string | null, request?: unknown): Operation | null {
  const probe = probeOf(ctx);
  const head = headSha ?? probe.head(ctx.cwd);
  if (!head || !SHA.test(head)) return null;
  const ref = typeof params.ref === "string" ? params.ref : "";
  const mirror = ref === "--mirror";
  const isDelete = params.delete === true && !mirror;
  const namedRef = ref !== "" && !ref.startsWith("-");
  // Resolve the remote: a name through the local config, a URL directly.
  const remoteArg = typeof params.remote === "string" && params.remote !== "" ? params.remote : undefined;
  const remoteName = remoteArg ?? probe.defaultRemote(ctx.cwd, probe.branch(ctx.cwd));
  const url = /[:/\\]/.test(remoteName) ? remoteName : probe.remoteUrl(ctx.cwd, remoteName);
  const normalized = url ? normalizeRemote(url) : null;
  const remoteId = normalized ? ctx.key.resourceId("remote", remoteKey(normalized)) : ctx.key.resourceId("remote-name", remoteName);
  const isProtected = ctx.isProtectedRef ?? defaultProtected;
  const resolved = namedRef && normalized !== null && !mirror && params.all !== true;
  return {
    type: "git", resource_id: ctx.repositoryId, ...common(ctx, request ?? { action_type: "git.push", params }),
    verb: mirror ? "mirror" : isDelete ? "delete" : "push", repository_id: ctx.repositoryId,
    refs: namedRef ? [{ ref_id: ctx.key.resourceId("ref", ref), protected: isProtected(ref) }] : [],
    force: params.force === true, head_sha: head, resolution: resolved ? "resolved" : "unresolved", remote_id: remoteId,
  };
}

/** `git commit`: the branch it lands on and the HEAD it starts from. */
function gitCommitOperation(sc: SimpleCommand, ctx: TypedContext, request: unknown): Operation | null {
  const g = gitArgs(sc);
  if (!g || g.sub !== "commit" || g.configs.some((c) => /^alias\./i.test(c))) return null;
  if (sc.argv.some((a) => a === "-C" || a === "--git-dir" || a === "--work-tree" || a.startsWith("--git-dir=") || a.startsWith("--work-tree="))) return null;
  if (g.args.includes("--dry-run")) return null;
  const probe = probeOf(ctx);
  const head = probe.head(ctx.cwd);
  if (!head) return null;
  const branch = probe.branch(ctx.cwd);
  const isProtected = ctx.isProtectedRef ?? defaultProtected;
  return {
    type: "git", resource_id: ctx.repositoryId, ...common(ctx, request), verb: "commit", repository_id: ctx.repositoryId,
    refs: branch ? [{ ref_id: ctx.key.resourceId("ref", branch), protected: isProtected(branch) }] : [],
    force: false, head_sha: head, resolution: branch ? "resolved" : "unresolved",
  };
}

// ---- GitHub resources -----------------------------------------------------------------------------------

export interface GithubRequest {
  verb: "pr_create" | "pr_update" | "pr_merge" | "release_create";
  repo?: GithubRepo;
  /** A pull request number, or a URL/branch selector that could not be reduced to one. */
  pr?: string;
  head?: string;
  base?: string;
  matchHead?: string;
  tag?: string;
  target?: string;
}

const PR_URL = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** A `gh` command reduced to what it asks for. Only the four typed verbs; anything else,
 *  including `gh api`, is not described. */
export function parseGh(sc: SimpleCommand): GithubRequest | null {
  if (canonProgram(sc.program) !== "gh") return null;
  const [area, action, ...rest] = sc.argv;
  const s = scan(rest, ["-R", "--repo", "-B", "--base", "-H", "--head", "--match-head-commit", "--target", "-t", "--title", "-b", "--body", "-F", "--body-file", "-a", "--assignee", "-l", "--label", "-r", "--reviewer", "-m", "--milestone", "-n", "--notes", "-d", "--discussion-category", "--notes-file", "--notes-start-tag", "-p", "--project", "--add-label", "--remove-label"]);
  const repoFlag = flagValue(s, "-R", "--repo");
  const request: GithubRequest = {
    verb: "pr_create",
    ...(repoFlag ? { repo: parseRepoFlag(repoFlag) ?? undefined } : {}),
    ...(flagValue(s, "-H", "--head") ? { head: flagValue(s, "-H", "--head") } : {}),
    ...(flagValue(s, "-B", "--base") ? { base: flagValue(s, "-B", "--base") } : {}),
  };
  if (area === "pr" && action === "create") return request;
  if (area === "pr" && (action === "edit" || action === "merge")) {
    request.verb = action === "edit" ? "pr_update" : "pr_merge";
    const selector = s.positionals[0];
    if (selector !== undefined) {
      const url = PR_URL.exec(selector);
      if (url) { request.repo = { host: url[1].toLowerCase(), owner: url[2], repo: url[3] }; request.pr = url[4]; }
      else if (/^\d+$/.test(selector)) request.pr = selector;
    }
    const match = flagValue(s, "--match-head-commit");
    if (match) request.matchHead = match;
    return request;
  }
  if (area === "release" && action === "create") {
    request.verb = "release_create";
    if (s.positionals[0]) request.tag = s.positionals[0];
    const target = flagValue(s, "--target");
    if (target) request.target = target;
    return request;
  }
  return null;
}

/** The known GitHub MCP tools, from the tool call input. Tool names are the ones the GitHub
 *  MCP server publishes; a different server keeps its plain MCP operation. */
export function parseGithubMcp(server: string, tool: string, input: Record<string, unknown>): GithubRequest | null {
  if (server !== "github") return null;
  const str = (k: string): string | undefined => (typeof input[k] === "string" && input[k] !== "" ? (input[k] as string) : undefined);
  const owner = str("owner");
  const repo = str("repo");
  const number = typeof input.pullNumber === "number" ? String(input.pullNumber) : str("pullNumber");
  const base: GithubRequest = { verb: "pr_create", ...(owner && repo ? { repo: { host: "github.com", owner, repo } } : {}) };
  switch (tool) {
    case "create_pull_request": return { ...base, ...(str("head") ? { head: str("head") } : {}), ...(str("base") ? { base: str("base") } : {}) };
    case "update_pull_request": return { ...base, verb: "pr_update", ...(number && /^\d+$/.test(number) ? { pr: number } : {}) };
    case "merge_pull_request": return { ...base, verb: "pr_merge", ...(number && /^\d+$/.test(number) ? { pr: number } : {}), ...(str("sha") ? { matchHead: str("sha") } : {}) };
    default: return null;
  }
}

/** The `github_resource` operation for a request, or null when a field the closed schema
 *  requires cannot be read from the request and the local repository. */
export function githubOperation(req: GithubRequest, ctx: TypedContext, request: unknown): Operation | null {
  const probe = probeOf(ctx);
  const workspaceRemote = normalizeRemote(probe.remoteUrl(ctx.cwd, probe.defaultRemote(ctx.cwd, probe.branch(ctx.cwd))) ?? "");
  const workspaceRepo = githubRepoOf(workspaceRemote);
  const repo = req.repo ?? workspaceRepo;
  if (!repo) return null;
  // Local commit ids describe the workspace repository only.
  const isWorkspace = workspaceRepo !== null && githubRepoKey(workspaceRepo) === githubRepoKey(repo);
  const repositoryId = ctx.key.resourceId("ghrepo", githubRepoKey(repo));
  const policyVersion = ctx.requiredCheckPolicyVersion ?? UNBOUND;
  const base = { type: "github_resource", resource_id: repositoryId, ...common(ctx, request), verb: req.verb, repository_id: repositoryId };
  if (req.verb === "pr_create") {
    if (!isWorkspace) return null;
    const branch = (req.head ?? probe.branch(ctx.cwd) ?? "").replace(/^[^:]*:/, "");
    if (branch === "" || (req.head?.includes(":") ?? false)) return null;
    const headSha = probe.revParse(ctx.cwd, `refs/heads/${branch}`);
    const baseSha = req.base ? probe.revParse(ctx.cwd, `refs/remotes/origin/${req.base}`) : probe.revParse(ctx.cwd, "refs/remotes/origin/HEAD");
    return headSha && baseSha ? { ...base, base_sha: baseSha, head_sha: headSha } : null;
  }
  if (req.verb === "release_create") {
    if (!isWorkspace) return null;
    const target = req.tag ? probe.revParse(ctx.cwd, `refs/tags/${req.tag}`) ?? (req.target ? (SHA.test(req.target) ? req.target : probe.revParse(ctx.cwd, req.target)) : null) : null;
    return target ? { ...base, release_digest: target, required_check_policy_version: policyVersion } : null;
  }
  // pr_update / pr_merge: the request names a pull request by number only.
  if (!req.pr) return null;
  const resolved = ctx.resolvePullRequest?.(repo, req.pr) ?? null;
  if (!resolved || !SHA.test(resolved.head_sha) || !SHA.test(resolved.base_sha)) return null;
  if (req.matchHead && SHA.test(req.matchHead) && req.matchHead !== resolved.head_sha) return null;
  return {
    ...base, pr_id: ctx.key.resourceId("pr", `${githubRepoKey(repo)}#${req.pr}`), base_sha: resolved.base_sha, head_sha: resolved.head_sha,
    ...(req.verb === "pr_merge" ? { required_check_policy_version: policyVersion } : {}),
  };
}

// ---- package managers -----------------------------------------------------------------------------------------

type Manager = "npm" | "pnpm" | "yarn" | "pip" | "uv";
const EXACT_VERSION = /^\d+(?:\.\d+){0,3}(?:[-+.][0-9A-Za-z.+-]+)?$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

const JS_VALUED = ["--registry", "--prefix", "--workspace", "--tag", "--cache", "--userconfig", "--loglevel", "-F", "--filter", "-C", "--dir", "--cwd", "--reporter", "--fetch-timeout", "--store-dir", "--network-concurrency"];
const PY_VALUED = ["-r", "--requirement", "--requirements", "-e", "--editable", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "-t", "--target", "--prefix", "--root", "--python", "-p", "--platform", "--abi", "--python-version", "--implementation", "--only-binary", "--no-binary", "-c", "--constraint", "--progress-bar", "--proxy", "--cert", "--client-cert", "--retries", "--timeout", "--trusted-host", "--config-settings", "-C", "--global-option", "--with", "--group", "--extra", "--index", "--default-index", "--directory", "--project", "--resolution", "--prerelease", "--exclude-newer"];

/** The registry host a spec or index URL points to, or undefined. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const n = normalizeRemote(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
  return n && n.host !== "local" && HOST.test(n.host) ? n.host : undefined;
}

const clip = (s: string): string => (s.length > 200 ? s.slice(0, 200) : s);

function jsPackage(spec: string): { name: string; version?: string; host?: string } | null {
  if (spec === "" || spec === "." || spec === "..") return { name: "local:project" };
  if (/^(?:https?|git\+https?|git\+ssh|git|ssh|git\+file|file):/i.test(spec)) {
    if (/^file:/i.test(spec)) return { name: clip(`local:${spec.replace(/^file:/i, "").replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "project"}`) };
    const n = normalizeRemote(spec.replace(/^git\+/i, ""));
    return n ? { name: clip(`url:${n.host}/${n.path}`), host: n.host } : null;
  }
  if (/^(?:github|gitlab|bitbucket):/i.test(spec)) {
    const [kind, path] = spec.split(":", 2);
    return { name: clip(`git:${kind.toLowerCase()}.${kind.toLowerCase() === "bitbucket" ? "org" : "com"}/${path.replace(/#.*$/, "")}`) };
  }
  if (/^(?:\.{1,2}[\\/]|\/|~|[A-Za-z]:[\\/])/.test(spec)) return { name: clip(`local:${spec.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "project"}`) };
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec) && !spec.startsWith("@")) return { name: clip(`git:github.com/${spec.replace(/#.*$/, "")}`) };
  const m = /^((?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+)(?:@(.+))?$/.exec(spec);
  if (!m) return null;
  return { name: m[1], ...(m[2] && EXACT_VERSION.test(m[2]) ? { version: m[2] } : {}) };
}

function pyPackage(spec: string): { name: string; version?: string; host?: string } | null {
  if (spec === "." || spec === ".." || /^(?:\.{1,2}[\\/]|\/|~|[A-Za-z]:[\\/])/.test(spec)) return { name: clip(`local:${spec === "." || spec === ".." ? "project" : spec.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "project"}`) };
  if (/^(?:https?|git\+https?|git\+ssh|git\+file|file):/i.test(spec)) {
    const n = normalizeRemote(spec.replace(/^git\+/i, ""));
    return n ? { name: clip(`url:${n.host}/${n.path}`), host: n.host } : null;
  }
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\[[^\]]*\])?\s*(?:(===?)\s*([0-9A-Za-z.+!*-]+))?(?:\s*[;<>!~,@].*)?$/.exec(spec);
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/[._]+/g, "-");
  return { name, ...(m[2] && m[3] && !m[3].includes("*") ? { version: m[3] } : {}) };
}

function readPackageManager(cwd: string, manager: string): string | undefined {
  try {
    const file = join(cwd, "package.json");
    if (!existsSync(file)) return undefined;
    const field = (JSON.parse(readFileSync(file, "utf8")) as { packageManager?: unknown }).packageManager;
    if (typeof field !== "string") return undefined;
    const m = /^([a-z]+)@(\d[0-9A-Za-z.+-]*?)(?:\+.*)?$/.exec(field);
    return m && m[1] === manager ? m[2] : undefined;
  } catch { return undefined; }
}

/** `python -m pip …` and `uv pip …` read as the pip they run. */
function managerCommand(sc: SimpleCommand): { manager: Manager; argv: string[] } | null {
  const program = canonProgram(sc.program);
  if (program === "npm" || program === "pnpm" || program === "yarn") return { manager: program, argv: sc.argv };
  if (program === "pip" || program === "pip3") return { manager: "pip", argv: sc.argv };
  if (program === "uv") return { manager: "uv", argv: sc.argv };
  if (/^(?:python[0-9.]*|py)$/.test(program)) {
    const at = sc.argv.indexOf("-m");
    const mod = at >= 0 ? sc.argv[at + 1] : undefined;
    if (mod === "pip") return { manager: "pip", argv: sc.argv.slice(at + 2) };
    if (mod === "uv") return { manager: "uv", argv: sc.argv.slice(at + 2) };
  }
  return null;
}

/** The `package` operation for an install, add or update that names its packages. A command
 *  that installs whatever a lockfile or requirements file lists (`npm ci`, `pnpm install`,
 *  `pip install -r …`, `uv sync`) has no package operation: its package set is not in the
 *  request, and an empty or guessed list would read as a complete one. */
export function packageOperation(sc: SimpleCommand, ctx: TypedContext, request: unknown): Operation | null {
  const found = managerCommand(sc);
  if (!found) return null;
  const { manager } = found;
  const js = manager === "npm" || manager === "pnpm" || manager === "yarn";
  const s = scan(found.argv, js ? (manager === "npm" ? [...JS_VALUED, "-w"] : JS_VALUED) : PY_VALUED);
  const [sub, second, ...others] = s.positionals;
  let verb: "install" | "add" | "update";
  let specs: string[];
  if (js) {
    const map: Record<string, "install" | "add" | "update"> = { install: "install", i: "install", add: "add", update: "update", up: "update", upgrade: "update" };
    if (sub === undefined || !Object.hasOwn(map, sub)) return null;
    verb = map[sub];
    specs = [second, ...others].filter((x): x is string => x !== undefined);
  } else if (manager === "pip") {
    if (sub !== "install") return null;
    verb = s.flags.has("-U") || s.flags.has("--upgrade") ? "update" : "install";
    specs = [second, ...others].filter((x): x is string => x !== undefined);
  } else if (sub === "add") {
    verb = "add";
    specs = [second, ...others].filter((x): x is string => x !== undefined);
  } else if (sub === "pip" && second === "install") {
    verb = s.flags.has("-U") || s.flags.has("--upgrade") ? "update" : "install";
    specs = others;
  } else return null;
  // Packages taken from a file or an editable path are not named in the request.
  if (!js && ["-r", "--requirement", "--requirements", "-e", "--editable"].some((f) => s.flags.has(f))) return null;
  if (specs.length === 0) return null;
  const registry = js ? hostOf(flagValue(s, "--registry")) : hostOf(flagValue(s, "-i", "--index-url", "--default-index"));
  const ignore = s.flags.get("--ignore-scripts");
  const noScripts = ignore === true || ignore === "true";
  const lifecycle = js ? (noScripts ? "blocked" : "unknown") : "not_supported";
  const packages: Array<Record<string, unknown>> = [];
  for (const spec of specs.slice(0, 100)) {
    const parsed = js ? jsPackage(spec) : pyPackage(spec);
    if (!parsed || scrubParam(parsed.name) !== parsed.name) return null;
    const host = parsed.host ?? (parsed.name.startsWith("local:") || parsed.name.startsWith("git:") ? undefined : registry);
    packages.push({ name: parsed.name, integrity_status: "unknown", ...(parsed.version ? { resolved_version: parsed.version } : {}), ...(host ? { registry_host: host } : {}) });
  }
  if (specs.length > 100) return null; // a larger install is not truncated; it stays a shell action
  const names = packages.map((p) => String(p.name)).sort();
  const versionOf = ctx.packageManagerVersion ?? readPackageManager;
  return {
    type: "package", resource_id: ctx.key.resourceId("package-set", names.join("\0")), ...common(ctx, request),
    manager, manager_version: versionOf(ctx.cwd, manager) ?? "unknown", verb, packages, lifecycle_scripts: lifecycle,
  };
}

// ---- deriving operations for one dispatched call ----------------------------------------------------------------------

/** The request a tool call was dispatched with, as the harness sent it: a shell tool's raw command or an MCP tool's input. */
export interface CallRequest { command?: string; dialect?: "posix" | "powershell"; fetch?: { url: string }; mcp?: { server: string; tool: string; input: Record<string, unknown> } }

/** The tool call as the harness sent it, for typed operations: a shell tool's raw command
 *  (Claude Code, Codex and Cursor each name it differently) or an MCP tool's actual input. */
export function callRequestOf(input: Record<string, unknown>): CallRequest | undefined {
  const name = typeof input.tool_name === "string" ? input.tool_name : "";
  const ti = (input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {}) as Record<string, unknown>;
  const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  if (name === "PowerShell") { const command = text(ti.command ?? ti.cmd); return command === undefined ? undefined : { command, dialect: "powershell" }; }
  if (name === "Bash" || name === "Shell" || name === "exec_command" || name === "unified_exec") { const command = text(ti.command ?? ti.cmd); return command === undefined ? undefined : { command }; }
  if (name === "WebFetch") { const url = text(ti.url); return url === undefined ? undefined : { fetch: { url } }; }
  const mcp = parseMcpName(name);
  if (mcp) return { mcp: { ...mcp, input: ti } };
  // Cursor's shell hook carries the command at the top level.
  if (name === "" && typeof input.command === "string") return { command: input.command };
  // Cursor's MCP hook names the server and tool and carries the arguments (an object, or JSON text).
  if (name === "" && typeof (input.server ?? input.server_name) === "string" && typeof (input.tool ?? input.tool_name) === "string") {
    const raw = input.args ?? input.arguments ?? input.tool_input;
    let parsed: unknown = raw;
    if (typeof raw === "string") { try { parsed = JSON.parse(raw); } catch { parsed = {}; } }
    return { mcp: { server: String(input.server ?? input.server_name), tool: String(input.tool ?? input.tool_name), input: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} } };
  }
  return undefined;
}

export interface DispatchedItem { action: { action_type: string; params: Record<string, unknown> } }

export interface DeriveInput {
  /** The raw command of a shell tool call, as sent. */
  command?: string;
  dialect?: "posix" | "powershell";
  /** A WebFetch tool call: the URL as sent. */
  fetch?: { url: string };
  /** MCP tool call: server and tool names with the actual input. */
  mcp?: { server: string; tool: string; input: Record<string, unknown> };
  dispatched: DispatchedItem[];
  /** The redaction the mapper applied to a simple command, to find its dispatched item. */
  redact: (raw: string) => string;
}

/**
 * Typed operations for the dispatched items of one tool call, by item index. A shell item is
 * matched to its simple command by the same redacted text the mapper recorded, so an operation
 * is always about the command that was evaluated. A `cd` earlier in the same command line moves
 * later commands away from the workspace, so repository-dependent operations are skipped after
 * one (they stay plain shell actions).
 */
export function deriveTypedOperations(input: DeriveInput, ctx: TypedContext): Map<number, Operation> {
  const out = new Map<number, Operation>();
  if (input.mcp) {
    const at = input.dispatched.findIndex((d) => d.action.action_type === "mcp.tool.call");
    const req = parseGithubMcp(input.mcp.server, input.mcp.tool, input.mcp.input);
    if (at >= 0 && req) {
      const op = githubOperation(req, ctx, { action_type: "mcp.tool.call", params: { server: input.mcp.server, tool: input.mcp.tool, arguments: input.mcp.input } });
      if (op) out.set(at, op);
    }
    return out;
  }
  if (input.fetch) {
    const at = input.dispatched.findIndex((d) => d.action.action_type === "net.fetch");
    if (at >= 0) {
      const op = fetchOperation(input.fetch.url, { key: ctx.key, cwd: ctx.cwd, referenceSetVersion: ctx.referenceSetVersion }, { action_type: "net.fetch", params: { url: input.fetch.url, method: "GET" } });
      if (op) out.set(at, op);
    }
    return out;
  }
  if (input.command === undefined) return out;
  const src = input.dialect === "powershell" ? input.command.replace(/`(.)/g, "$1").replace(/\\/g, "/") : input.command;
  const commands = decomposeShell(src);
  const used = new Set<number>();
  let moved = false;
  for (const sc of commands) {
    if (sc.opaque) continue;
    const program = canonProgram(sc.program);
    if (/^(?:cd|pushd|chdir|set-location|sl)$/.test(program)) { moved = true; continue; }
    // After a `cd` the workspace is not where later commands run: only the destination of a fetch, which does not
    // depend on it, is still read.
    const redacted = input.redact(sc.raw);
    const at = input.dispatched.findIndex((d, i) => !used.has(i) && d.action.action_type === "shell.exec" && d.action.params.command === redacted);
    if (at < 0) continue;
    const request = { action_type: "shell.exec", params: { command: sc.raw, cwd: ctx.cwd } };
    const gh = parseGh(sc);
    const op = (moved ? null : (gh ? githubOperation(gh, ctx, request) : null) ?? gitCommitOperation(sc, ctx, request) ?? packageOperation(sc, ctx, request))
      ?? deriveInfraOperation(sc, { key: ctx.key, cwd: ctx.cwd, referenceSetVersion: ctx.referenceSetVersion, ...(ctx.files ? { files: ctx.files } : {}), ...(ctx.env ? { env: ctx.env } : {}) }, request, input.dialect ?? "posix", moved);
    if (op) { out.set(at, op); used.add(at); }
  }
  return out;
}

/** A repository the fixtures describe: deterministic, no git process, no network. */
export const fixtureProbe: GitProbe = {
  head: () => "1".repeat(40), branch: () => "feature/fixture",
  remoteUrl: () => "https://github.com/example/fixture.git", defaultRemote: () => "origin",
  revParse: (_cwd, rev) => (rev === "refs/heads/feature/fixture" ? "1".repeat(40) : rev.startsWith("refs/remotes/origin/") ? "2".repeat(40) : null),
};

/** Capability cells for typed operations. These describe observations, not receipts, so a
 *  proof for one has no receipt of its own action type to name and is never sent to a workspace. */
export const TYPED_ACTION_TYPES: ReadonlySet<string> = new Set(["git.commit", "package.install", "github.resource", "github.pr_change", "deploy.run", "network.request", "cloudflare.resource", "database.exec", "browser.action", "communication.send", "visibility.change"]);
