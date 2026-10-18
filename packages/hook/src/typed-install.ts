// Install detection: software a coding agent installs or runs from outside the project, read from the ACTUAL request, as
// `software.install` actions (Action Taxonomy 1.2) beside the command or file write that does it.
//
// Routes:
//   packages        npm, pnpm, yarn and bun (install, add, update, create, dlx), npx and bunx; pip (also `python -m pip`),
//                   uv (add, pip install, tool install, uvx, tool run, sync), poetry, pipx; cargo (install, add), go (install,
//                   get, run), gem and bundle, brew
//   scripts         a fetched script fed to a shell or interpreter (`curl … | sh`, `wget -qO- … | bash`, `sh -c "$(curl …)"`,
//                   `bash <(curl …)`, `iwr … | iex`)
//   downloads       a file fetched with an output name that the same command line makes executable or runs (`wget …` then
//                   `chmod +x`), or that is a program or installer by its name (`.exe`, `.msi`, `.pkg`, `.deb`, `.sh`, …)
//   repositories    `git clone` (and `gh repo clone`), and the same clone when the command line goes on to run what is in it
//   containers      `docker`/`podman` `pull`, `run`, `create`, and `compose pull/up/run`
//   MCP servers     `claude mcp add`/`add-json`, `codex mcp add`, `code --add-mcp`, and a write to a coding tool's MCP settings
//                   file (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `~/.claude.json`, `.codex/config.toml`,
//                   `.copilot/mcp-config.json`): one action per server it configures, described by its launch command or URL
//
// Detection only: nothing here judges a package, a site or a repository, and no list of good or bad ones is consulted. Each
// action says what is installed, from where and how, so a rule (or a verdict service) can decide.
//
// The rules this module keeps (as every other reader does):
//   - Deterministic and pure: the same request gives the same actions, with no network, no clock and no file read.
//   - No content and no secrets: names, versions and hosts are what a registry or a URL makes public. A URL keeps only its
//     scheme, host and path (credentials, query and fragment removed, token-like path parts masked). A file's contents, an
//     environment value or a header given to an MCP server is never read. Local paths are never recorded as names.
//   - Unknown is not guessed: a fact the request does not show is left out (no default registry is assumed).

import { canonProgram, decomposeShell, gitArgs, shellScriptArg, splitCommandLine, type SimpleCommand } from "./shell.js";
import { scrubParam, scrubUrlPath } from "./minimize.js";
import { scan, flagValue } from "./scan.js";
import { launched, skipOptions } from "./launchers.js";

export interface InstallAction { action_type: "software.install"; params: Record<string, unknown> }

type Route = "npm" | "pnpm" | "yarn" | "bun" | "npx" | "pip" | "uv" | "poetry" | "pipx" | "cargo" | "go" | "gem" | "brew"
  | "curl_pipe_shell" | "download_exec" | "git_clone" | "git_clone_run" | "docker_pull" | "docker_run" | "mcp_settings";
type Ecosystem = "npm" | "pypi" | "cargo" | "go" | "rubygems" | "homebrew" | "container" | "git" | "script" | "binary" | "remote" | "unknown";
type Verb = "install" | "add" | "update" | "run" | "clone" | "pull" | "download" | "configure";

interface Facts {
  route: Route;
  ecosystem: Ecosystem;
  verb: Verb;
  name?: string;
  version?: string;
  source_url?: string;
  source_domain?: string;
  from_manifest?: true;
  global?: true;
  lifecycle_scripts?: "blocked" | "unknown";
  auto_confirm?: true;
  executed?: boolean;
  mcp_server?: string;
  via: string;
}

/** Most actions one request records; capDerived (map.ts) folds beyond its own limit. */
const MAX_ACTIONS = 100;
const SUBST = "__sb_subst";
/** A spec longer than this is not a package name a registry takes; it is skipped rather than read. */
const MAX_SPEC = 500;

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
/** A value fit to record: scrubbed of anything token-shaped, never an unexpanded variable, bounded. */
function word(value: string | undefined, max = 200): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "" || v.includes(SUBST) || v.includes("$") || /[\s`]/.test(v)) return undefined;
  return clip(scrubParam(v), max);
}

const isLocalPath = (spec: string): boolean => /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|~|[A-Za-z]:[\\/]|file:)/i.test(spec);

/** A URL reduced to scheme, host and path: no credentials, query or fragment; token-like path parts masked. */
function sourceOf(raw: string | undefined): { source_url: string; source_domain: string } | undefined {
  if (!raw) return undefined;
  let text = raw.trim().replace(/^git\+/i, "");
  if (text.includes(SUBST) || text.includes("$")) return undefined;
  // `git@host:owner/repo` reads as ssh.
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; the user part cannot cross `@`, the host cannot cross `:` or `/`
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^\s]+)$/.exec(text);
  if (scp && !/^[A-Za-z]$/.test(scp[1]) && !/^https?$/i.test(scp[1])) text = `ssh://${scp[1]}/${scp[2]}`;
  let u: URL;
  try { u = new URL(text); } catch { return undefined; }
  if (!["http:", "https:", "ssh:", "git:"].includes(u.protocol)) return undefined;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(host)) return undefined;
  const path = scrubUrlPath(u.pathname).replace(/\/{2,}/g, "/");
  return { source_url: clip(`${u.protocol}//${host}${u.port ? `:${u.port}` : ""}${path === "/" ? "" : path}`, 300), source_domain: host };
}

const hostOf = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  return sourceOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)?.source_domain;
};

/** The command's own `NAME=value` (prefix or `env`), first of the names given. */
function assigned(sc: SimpleCommand, ...names: string[]): string | undefined {
  for (const name of names) for (const w of sc.assigns ?? []) if (w.startsWith(`${name}=`)) return w.slice(name.length + 1);
  return undefined;
}

// ---- package specs ------------------------------------------------------------------------------------------------------

type Spec = { name?: string; version?: string; source_url?: string; source_domain?: string };

/** An npm, pnpm, yarn or bun spec: `name`, `name@range`, `@scope/name@tag`, `alias@npm:real@1`, a git or tarball URL,
 *  `owner/repo` (GitHub). Null for a local path or a workspace link (not an install from outside). */
function jsSpec(spec: string): Spec | null {
  if (spec === "" || spec.length > MAX_SPEC || isLocalPath(spec) || /^(?:workspace|link|portal|patch|exec):/i.test(spec)) return null;
  // An alias: `my-alias@npm:real-name@1.2.3`.
  const alias = /^(?:@[^@/\s]+\/)?[^@/\s]+@npm:(.+)$/.exec(spec);
  if (alias) return jsSpec(alias[1]);
  if (/^(?:https?|git|git\+https?|git\+ssh|ssh):/i.test(spec) || /^[^@/\s]+@[^:/\s]+:/.test(spec)) {
    const src = sourceOf(spec.replace(/#.*$/, ""));
    return src ? { ...src } : null;
  }
  const hosted = /^(github|gitlab|bitbucket):([^#\s]+)/i.exec(spec);
  if (hosted) {
    const host = `${hosted[1].toLowerCase()}.${hosted[1].toLowerCase() === "bitbucket" ? "org" : "com"}`;
    return sourceOf(`https://${host}/${hosted[2]}`) ?? null;
  }
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; `/` and `#` separate the repeats
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec) && !spec.startsWith("@")) return sourceOf(`https://github.com/${spec.replace(/#.*$/, "")}`) ?? null;
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; the name repeat cannot cross the `@` that starts the version
  const m = /^((?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+)(?:@(.*))?$/.exec(spec);
  if (!m) return null;
  const name = word(m[1]);
  if (!name) return null;
  const version = m[2] ? word(m[2], 100) : undefined;
  return { name, ...(version ? { version } : {}) };
}

/** A pip requirement: `name`, `name==1.2`, `name[extra]>=1,<2`, `name @ https://…`, a URL or VCS spec. Null for a local path. */
function pySpec(spec: string): Spec | null {
  const s = spec.trim();
  if (s === "" || s.length > MAX_SPEC || isLocalPath(s)) return null;
  if (/^(?:https?|git\+[a-z]+|hg\+[a-z]+|svn\+[a-z]+|bzr\+[a-z]+):/i.test(s)) {
    const egg = /#egg=([A-Za-z0-9._-]+)/.exec(s)?.[1];
    const src = sourceOf(s.replace(/#.*$/, "").replace(/@[^/@]*$/, (tail) => (tail.includes(":") ? tail : "")));
    if (!src) return null;
    return { ...(egg ? { name: egg.toLowerCase().replace(/[._]+/g, "-") } : {}), ...src };
  }
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; the name class excludes every character that starts the tail
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,200}[A-Za-z0-9])?)(?:\[[^\]]{0,200}\])?\s*(.*)$/.exec(s);
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/[._]+/g, "-");
  const tail = m[2].replace(/;.*$/, "").trim();
  if (tail.startsWith("@")) {
    const src = sourceOf(tail.slice(1).trim());
    return { name, ...(src ?? {}) };
  }
  // `==1.2.3` / `===1.2.3` record the version; any other specifier is recorded as written.
  const exact = /^===?\s*([0-9A-Za-z.+!*-]{1,100})$/.exec(tail);
  const version = exact && !exact[1].includes("*") ? exact[1] : tail !== "" ? word(tail.replace(/\s+/g, ""), 100) : undefined;
  return { name, ...(version ? { version } : {}) };
}

/** `name@version` (cargo, go, poetry, uv tool); the part before the last `@`. */
function atSpec(spec: string): Spec | null {
  if (spec === "" || spec.length > MAX_SPEC || isLocalPath(spec)) return null;
  const at = spec.lastIndexOf("@");
  const name = word(at > 0 ? spec.slice(0, at) : spec);
  if (!name) return null;
  const version = at > 0 ? word(spec.slice(at + 1), 100) : undefined;
  return { name, ...(version ? { version } : {}) };
}

// ---- package managers ---------------------------------------------------------------------------------------------------

const JS_VALUED = ["--registry", "--prefix", "--workspace", "-w", "--tag", "--cache", "--userconfig", "--loglevel", "-F", "--filter", "-C", "--dir", "--cwd", "--reporter",
  "--fetch-timeout", "--store-dir", "--network-concurrency", "--save-prefix", "--omit", "--include", "--before", "--cpu", "--os", "--libc", "--install-strategy", "--modules-folder",
  "--network-timeout", "--cache-folder", "--global-folder", "--mutex", "--virtual-store-dir", "--lockfile-dir", "--config", "--package", "-p", "--call", "-c", "--shell-mode",
  "--backend", "--cache-dir", "--trust", "--dir", "--template"];
const PY_VALUED = ["-r", "--requirement", "--requirements", "-c", "--constraint", "--constraints", "-e", "--editable", "-i", "--index-url", "--extra-index-url", "-f", "--find-links",
  "-t", "--target", "--prefix", "--root", "--python", "-p", "--platform", "--abi", "--python-version", "--implementation", "--only-binary", "--no-binary", "--progress-bar",
  "--proxy", "--cert", "--client-cert", "--retries", "--timeout", "--trusted-host", "--config-settings", "-C", "--global-option", "--with", "--group", "--extra", "--index",
  "--default-index", "--directory", "--project", "--resolution", "--prerelease", "--exclude-newer", "--from", "--source", "--optional", "-G", "--suffix", "--pip-args",
  "--spec", "--python-preference", "--package", "--cache-dir", "--upgrade-package", "-P", "--env-file", "--with-requirements", "--with-editable", "--with-executables-from"];

const JS_VERBS: Readonly<Record<string, Verb>> = {
  install: "install", i: "install", in: "install", ins: "install", inst: "install", insta: "install", instal: "install", isnt: "install", isnta: "install",
  isntal: "install", isntall: "install", add: "add", a: "add", "install-test": "install", it: "install", "install-ci-test": "install", cit: "install",
  ci: "install", "clean-install": "install", update: "update", up: "update", upgrade: "update", udpate: "update",
};

/** What a JS registry option or variable names. */
function jsRegistry(sc: SimpleCommand, s: ReturnType<typeof scan>): string | undefined {
  return hostOf(flagValue(s, "--registry") ?? assigned(sc, "NPM_CONFIG_REGISTRY", "npm_config_registry", "YARN_NPM_REGISTRY_SERVER", "BUN_CONFIG_REGISTRY", "PNPM_CONFIG_REGISTRY"));
}

function jsInstalls(sc: SimpleCommand, manager: "npm" | "pnpm" | "yarn" | "bun"): Facts[] {
  const s = scan(sc.argv, JS_VALUED);
  let [sub, ...specs] = s.positionals;
  let global = s.flags.has("-g") || s.flags.has("--global");
  // `yarn global add x`.
  if (manager === "yarn" && sub === "global") { global = true; [sub, ...specs] = specs; }
  if (sub === undefined) {
    // A bare `yarn` or `bun` installs what the manifest lists.
    return manager === "yarn" || manager === "bun" ? [{ route: manager, ecosystem: "npm", verb: "install", from_manifest: true, via: manager }] : [];
  }
  const registry = jsRegistry(sc, s);
  const ignore = s.flags.get("--ignore-scripts");
  const lifecycle = ignore === true || ignore === "true" ? "blocked" as const : "unknown" as const;
  const base = { route: manager, ecosystem: "npm" as const, via: manager, ...(global ? { global: true as const } : {}), ...(registry ? { source_domain: registry } : {}) };
  // `npm create vite`, `pnpm create x`, `yarn create x`, `bun create x`, `npm init x`: run the `create-x` package.
  if (sub === "create" || (sub === "init" && manager !== "bun" && specs[0] !== undefined && !specs[0].startsWith("-"))) {
    const target = specs[0];
    if (target === undefined || isLocalPath(target)) return [];
    const parsed = jsSpec(target);
    if (!parsed?.name) return [];
    const scoped = /^(@[^/]+)(?:\/(.+))?$/.exec(parsed.name);
    const name = scoped ? `${scoped[1]}/create${scoped[2] ? `-${scoped[2]}` : ""}` : parsed.name.startsWith("create-") ? parsed.name : `create-${parsed.name}`;
    return [{ ...base, verb: "run", name, ...(parsed.version ? { version: parsed.version } : {}) }];
  }
  if ((manager === "pnpm" || manager === "yarn") && sub === "dlx") return runner(sc, manager);
  if (manager === "bun" && sub === "x") return runner(sc, "bun");
  if (manager === "npm" && (sub === "exec" || sub === "x")) return runner(sc, "npm");
  const verb = Object.hasOwn(JS_VERBS, sub) ? JS_VERBS[sub] : undefined;
  if (verb === undefined) return [];
  if (sub === "ci" || sub === "clean-install" || specs.length === 0) {
    return [{ ...base, verb, from_manifest: true, lifecycle_scripts: lifecycle }];
  }
  const out: Facts[] = [];
  for (const spec of specs.slice(0, MAX_ACTIONS)) {
    const parsed = jsSpec(spec);
    if (!parsed) continue;
    out.push({ ...base, verb, lifecycle_scripts: lifecycle, ...parsed, ...(parsed.source_domain === undefined && registry ? { source_domain: registry } : {}) });
  }
  return out;
}

/** A package run through a runner that installs it first when it is missing: `npx`, `pnpm dlx`, `yarn dlx`, `bunx`, `npm exec`,
 *  `uvx`, `uv tool run`, `pipx run`. */
function runner(sc: SimpleCommand, kind: "npx" | "pnpm" | "yarn" | "bun" | "npm" | "uvx" | "pipx"): Facts[] {
  const py = kind === "uvx" || kind === "pipx";
  const s = scan(sc.argv, py ? PY_VALUED : JS_VALUED);
  if (s.flags.has("--no") || s.flags.has("--no-install") || s.flags.has("--offline")) return [];
  const yes = s.flags.has("-y") || s.flags.has("--yes");
  // `npm exec` installs without asking only with --yes (or when nothing can ask: then npm assumes yes).
  const packageFlag = py ? flagValue(s, "--from", "--spec") : flagValue(s, "-p", "--package");
  const l = launched(sc);
  const spec = packageFlag ?? l?.spec;
  if (spec === undefined) return [];
  const route: Route = py ? (kind === "uvx" ? "uv" : "pipx") : kind === "npm" || kind === "npx" ? "npx" : kind;
  const via = kind === "uvx" ? "uvx" : kind === "npm" ? "npm" : kind;
  const parsed = py ? pySpec(spec.replace(/@([^@]+)$/, "==$1")) : jsSpec(spec);
  if (!parsed) return [];
  const registry = py ? hostOf(flagValue(s, "-i", "--index-url", "--default-index", "--index") ?? assigned(sc, "UV_INDEX_URL", "UV_DEFAULT_INDEX", "PIP_INDEX_URL")) : jsRegistry(sc, s);
  return [{
    route, ecosystem: py ? "pypi" : "npm", verb: "run", via, ...parsed,
    ...(parsed.source_domain === undefined && registry ? { source_domain: registry } : {}), ...(yes ? { auto_confirm: true as const } : {}),
  }];
}

function pyInstalls(sc: SimpleCommand, route: "pip" | "uv" | "poetry" | "pipx", argv: readonly string[], via: string, verb: Verb, global = false): Facts[] {
  const s = scan([...argv], PY_VALUED);
  const specs = s.positionals;
  const index = hostOf(flagValue(s, "-i", "--index-url", "--default-index", "--index", "--source") ?? flagValue(s, "--extra-index-url")
    ?? assigned(sc, "PIP_INDEX_URL", "UV_INDEX_URL", "UV_DEFAULT_INDEX", "PIP_EXTRA_INDEX_URL"));
  const base = { route, ecosystem: "pypi" as const, verb, via, ...(global ? { global: true as const } : {}), ...(index ? { source_domain: index } : {}) };
  const out: Facts[] = [];
  // `-r requirements.txt` installs what the file lists; `-e git+https://…` names a source.
  if (["-r", "--requirement", "--requirements"].some((f) => s.flags.has(f))) out.push({ ...base, from_manifest: true });
  const editable = flagValue(s, "-e", "--editable");
  if (editable !== undefined) { const p = pySpec(editable); if (p) out.push({ ...base, ...p }); }
  for (const spec of specs.slice(0, MAX_ACTIONS)) {
    const parsed = route === "poetry" ? pySpec(spec.replace(/@([^@/]+)$/, (_m, v: string) => (/^[\^~<>=!*0-9]/.test(v) ? v.replace(/^(?=[0-9])/, "==") : `@${v}`))) : pySpec(spec);
    if (parsed) out.push({ ...base, ...parsed, ...(parsed.source_domain === undefined && index ? { source_domain: index } : {}) });
  }
  return out;
}

function pythonManager(sc: SimpleCommand): Facts[] {
  const program = canonProgram(sc.program);
  let argv = sc.argv;
  let pip = program === "pip" || program === "pip3";
  if (/^(?:python[0-9.]*|py)$/.test(program)) {
    const at = argv.indexOf("-m");
    if (at < 0) return [];
    const mod = argv[at + 1];
    if (mod === "pip") { pip = true; argv = argv.slice(at + 2); }
    else if (mod === "uv") return uvInstalls(sc, argv.slice(at + 2));
    else if (mod === "pipx") return pipxInstalls(sc, argv.slice(at + 2));
    else return [];
  }
  if (pip) {
    const s = scan([...argv], PY_VALUED);
    if (s.positionals[0] !== "install") return [];
    const verb: Verb = s.flags.has("-U") || s.flags.has("--upgrade") ? "update" : "install";
    const rest = argv.slice(argv.indexOf("install") + 1);
    return pyInstalls(sc, "pip", [...argv.slice(0, argv.indexOf("install")), ...rest], program === "pip3" ? "pip3" : "pip", verb);
  }
  if (program === "uv") return uvInstalls(sc, argv);
  if (program === "uvx") return runner(sc, "uvx");
  if (program === "pipx") return pipxInstalls(sc, argv);
  if (program === "poetry") {
    const s = scan([...argv], PY_VALUED);
    const [sub] = s.positionals;
    const rest = argv.slice(argv.indexOf(sub ?? "") + 1);
    if (sub === "add") return pyInstalls(sc, "poetry", rest, "poetry", "add");
    if (sub === "install") return [{ route: "poetry", ecosystem: "pypi", verb: "install", from_manifest: true, via: "poetry" }];
    if (sub === "update") { const named = pyInstalls(sc, "poetry", rest, "poetry", "update"); return named.length ? named : [{ route: "poetry", ecosystem: "pypi", verb: "update", from_manifest: true, via: "poetry" }]; }
  }
  return [];
}

function uvInstalls(sc: SimpleCommand, argv: readonly string[]): Facts[] {
  const s = scan([...argv], PY_VALUED);
  const [sub, second] = s.positionals;
  const after = (word0: string, word1?: string): string[] => {
    const i = argv.indexOf(word0);
    const j = word1 === undefined ? i : argv.indexOf(word1, i + 1);
    return argv.slice(j + 1);
  };
  if (sub === "add") return pyInstalls(sc, "uv", after("add"), "uv", "add");
  if (sub === "pip" && second === "install") {
    const s2 = scan(after("pip", "install"), PY_VALUED);
    return pyInstalls(sc, "uv", after("pip", "install"), "uv", s2.flags.has("-U") || s2.flags.has("--upgrade") ? "update" : "install");
  }
  if (sub === "sync") return [{ route: "uv", ecosystem: "pypi", verb: "install", from_manifest: true, via: "uv" }];
  if (sub === "tool" && second === "install") return pyInstalls(sc, "uv", after("tool", "install").map((w) => w.replace(/@([0-9][^@]*)$/, "==$1")), "uv", "install", true);
  if (sub === "tool" && second === "run") return runner({ ...sc, program: "uvx", argv: after("tool", "run") }, "uvx");
  return [];
}

function pipxInstalls(sc: SimpleCommand, argv: readonly string[]): Facts[] {
  const s = scan([...argv], PY_VALUED);
  const [sub] = s.positionals;
  if (sub === "install") return pyInstalls(sc, "pipx", argv.slice(argv.indexOf("install") + 1), "pipx", "install", true);
  if (sub === "inject") return pyInstalls(sc, "pipx", argv.slice(argv.indexOf("inject") + 2), "pipx", "add", true);
  if (sub === "run") return runner({ ...sc, program: "pipx", argv: [...argv] }, "pipx");
  return [];
}

const CARGO_VALUED = ["--version", "--vers", "--git", "--branch", "--tag", "--rev", "--path", "--root", "--registry", "--index", "--features", "-F", "--target", "--profile",
  "-j", "--jobs", "--rename", "-p", "--package", "--manifest-path", "--target-dir", "--config", "-Z", "--color"];

function cargoInstalls(sc: SimpleCommand): Facts[] {
  const s = scan(sc.argv, CARGO_VALUED);
  const [sub, ...specs] = s.positionals;
  if (sub !== "install" && sub !== "add" && sub !== "binstall") return [];
  if (flagValue(s, "--path") !== undefined) return [];
  const git = sourceOf(flagValue(s, "--git"));
  const registry = hostOf(flagValue(s, "--index"));
  const version = word(flagValue(s, "--version", "--vers"), 100);
  const base = { route: "cargo" as const, ecosystem: "cargo" as const, verb: (sub === "add" ? "add" : "install") as Verb, via: "cargo", ...(sub !== "add" ? { global: true as const } : {}), ...(git ?? (registry ? { source_domain: registry } : {})) };
  if (specs.length === 0) return git ? [base] : [];
  return specs.slice(0, MAX_ACTIONS).map(atSpec).filter((p): p is Spec => p !== null).map((p) => ({ ...base, ...p, ...(version && !p.version ? { version } : {}) }));
}

function goInstalls(sc: SimpleCommand): Facts[] {
  const s = scan(sc.argv, ["-C", "-modfile", "-mod", "-tags", "-ldflags", "-gcflags", "-o", "-p", "-exec", "-overlay", "-pgo", "-toolexec", "-asmflags", "-buildmode", "-compiler", "-installsuffix", "-pkgdir", "-buildvcs"]);
  const [sub, ...specs] = s.positionals;
  if (sub !== "install" && sub !== "get" && sub !== "run") return [];
  const out: Facts[] = [];
  for (const spec of (sub === "run" ? specs.slice(0, 1) : specs).slice(0, MAX_ACTIONS)) {
    // A module path names its host first (`github.com/x/y/cmd/z@v1`); a local package (`.`, `./cmd/x`) is not an install.
    if (isLocalPath(spec) || !/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(spec)) continue;
    // `go run` installs only a module named with a version.
    if (sub === "run" && !spec.includes("@")) continue;
    const p = atSpec(spec);
    if (!p?.name) continue;
    out.push({ route: "go", ecosystem: "go", verb: sub === "get" ? "add" : sub === "run" ? "run" : "install", via: "go", ...(sub === "install" ? { global: true as const } : {}), ...p, source_domain: p.name.split("/")[0].toLowerCase() });
  }
  return out;
}

function gemInstalls(sc: SimpleCommand): Facts[] {
  const program = canonProgram(sc.program);
  const s = scan(sc.argv, ["-v", "--version", "-s", "--source", "-i", "--install-dir", "-n", "--bindir", "--platform", "-g", "--file", "--group", "--git", "--branch", "--github", "--path", "--require"]);
  const [sub, ...specs] = s.positionals;
  if (program === "bundle") {
    if (sub === "install") return [{ route: "gem", ecosystem: "rubygems", verb: "install", from_manifest: true, via: "bundle" }];
    if (sub !== "add" || specs.length === 0) return [];
  } else if (sub !== "install" && sub !== "i" && sub !== "update") return [];
  const version = word(flagValue(s, "-v", "--version"), 100);
  const src = sourceOf(flagValue(s, "--git")) ?? (flagValue(s, "-s", "--source") ? { source_domain: hostOf(flagValue(s, "-s", "--source")) } : undefined);
  return specs.slice(0, MAX_ACTIONS).filter((spec) => !isLocalPath(spec) && !spec.endsWith(".gem")).map((spec) => word(spec)).filter((n): n is string => n !== undefined).map((name) => ({
    route: "gem" as const, ecosystem: "rubygems" as const, verb: (program === "bundle" ? "add" : sub === "update" ? "update" : "install") as Verb, via: program, name,
    ...(program === "gem" ? { global: true as const } : {}), ...(version ? { version } : {}), ...(src?.source_domain ? src : {}),
  }));
}

function brewInstalls(sc: SimpleCommand): Facts[] {
  const s = scan(sc.argv, []);
  const [sub, ...specs] = s.positionals;
  if (sub === "bundle") return [{ route: "brew", ecosystem: "homebrew", verb: "install", from_manifest: true, global: true, via: "brew" }];
  if (sub === "tap") {
    const name = word(specs[0]);
    if (!name) return [];
    const src = sourceOf(specs[1]) ?? sourceOf(`https://github.com/${name.replace(/^([^/]+)\/(?!homebrew-)([^/]+)$/, "$1/homebrew-$2")}`);
    return [{ route: "brew", ecosystem: "homebrew", verb: "add", name, global: true, via: "brew", ...(src ?? {}) }];
  }
  if (!["install", "reinstall", "upgrade"].includes(sub ?? "")) return [];
  // A formula's name is whole: `node@20` is a formula of its own, not a version of `node`.
  return specs.slice(0, MAX_ACTIONS).filter((spec) => !isLocalPath(spec)).map((spec) => word(spec)).filter((n): n is string => n !== undefined)
    .map((name) => ({ route: "brew" as const, ecosystem: "homebrew" as const, verb: (sub === "upgrade" ? "update" : "install") as Verb, name, global: true as const, via: "brew" }));
}

/** The package installs one simple command names. */
function packageInstalls(sc: SimpleCommand): Facts[] {
  if (sc.opaque) return [];
  const program = canonProgram(sc.program);
  switch (program) {
    case "npm": case "pnpm": case "yarn": case "bun": return jsInstalls(sc, program);
    case "npx": case "pnpx": return runner(sc, "npx");
    case "bunx": return runner(sc, "bun");
    case "cargo": return cargoInstalls(sc);
    case "go": return goInstalls(sc);
    case "gem": case "bundle": return gemInstalls(sc);
    case "brew": return brewInstalls(sc);
    default: return pythonManager(sc);
  }
}

// ---- fetches, scripts and downloads -----------------------------------------------------------------------------------------

interface Fetch { url: string; output?: string; stdout: boolean; via: string }

const CURL_VALUED = new Set(["-X", "--request", "-H", "--header", "-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "-F", "--form",
  "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "-r", "--range",
  "--retry", "--retry-delay", "--retry-max-time", "--max-redirs", "--limit-rate", "--cacert", "--capath", "-E", "--cert", "--key", "-x", "--proxy", "--resolve", "--connect-to",
  "--proto", "--proto-redir", "--tlsv1.2", "--ciphers", "-K", "--config", "--interface", "--output-dir", "-T", "--upload-file", "--url", "-o", "--output", "--oauth2-bearer", "-U", "--proxy-user"]);
const CURL_SHORT_VALUED = "XHdFuAebcwmrxEKTUo";

function readCurl(argv: readonly string[]): Fetch | null {
  const urls: string[] = [];
  let output: string | undefined;
  let remoteName = false;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") { urls.push(...argv.slice(i + 1)); break; }
    if (t.startsWith("--")) {
      const at = t.indexOf("=");
      const name = at > 0 ? t.slice(0, at) : t;
      let value = at > 0 ? t.slice(at + 1) : undefined;
      if (CURL_VALUED.has(name) && value === undefined) value = argv[++i];
      if (name === "--output") output = value;
      else if (name === "--url" && value) urls.push(value);
      else if (name === "--remote-name" || name === "--remote-name-all") remoteName = true;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const c = t[k];
        if (c === "O") { remoteName = true; continue; }
        if (CURL_SHORT_VALUED.includes(c)) {
          const value = k + 1 < t.length ? t.slice(k + 1) : argv[++i];
          if (c === "o") output = value;
          break;
        }
      }
      continue;
    }
    urls.push(t);
  }
  const url = urls.find((u) => /^https?:\/\//i.test(u)) ?? urls.find((u) => /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?(?:\/|$)/.test(u));
  if (!url) return null;
  const file = output !== undefined && output !== "-" ? output : remoteName ? lastSegment(url) : undefined;
  return { url, ...(file ? { output: file } : {}), stdout: file === undefined, via: "curl" };
}

const WGET_VALUED = new Set(["-O", "--output-document", "-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix", "-t", "--tries", "-T", "--timeout", "-w", "--wait",
  "-U", "--user-agent", "--header", "--http-user", "--http-password", "--user", "--password", "-e", "--execute", "--method", "--post-data", "--post-file", "--body-data",
  "--body-file", "-l", "--level", "-A", "--accept", "-R", "--reject", "--referer", "--load-cookies", "--save-cookies", "--certificate", "--private-key", "--ca-certificate",
  "--bind-address", "-Q", "--quota", "--limit-rate", "-i", "--input-file", "-B", "--base"]);

function readWget(argv: readonly string[]): Fetch | null {
  const urls: string[] = [];
  let output: string | undefined;
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") { urls.push(...argv.slice(i + 1)); break; }
    if (t.startsWith("--")) {
      const at = t.indexOf("=");
      const name = at > 0 ? t.slice(0, at) : t;
      let value = at > 0 ? t.slice(at + 1) : undefined;
      if (WGET_VALUED.has(name) && value === undefined) value = argv[++i];
      if (name === "--output-document") output = value;
      else if (name === "--directory-prefix") dir = value;
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const c = `-${t[k]}`;
        if (WGET_VALUED.has(c)) {
          const value = k + 1 < t.length ? t.slice(k + 1) : argv[++i];
          if (c === "-O") output = value;
          else if (c === "-P") dir = value;
          break;
        }
      }
      continue;
    }
    urls.push(t);
  }
  const url = urls.find((u) => /^https?:\/\//i.test(u)) ?? urls.find((u) => /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?(?:\/|$)/.test(u));
  if (!url) return null;
  if (output === "-") return { url, stdout: true, via: "wget" };
  const name = output ?? lastSegment(url);
  return { url, ...(name ? { output: dir && output === undefined ? `${dir.replace(/\/+$/, "")}/${name}` : name } : {}), stdout: false, via: "wget" };
}

function readPowerShellFetch(argv: readonly string[]): Fetch | null {
  let uri: string | undefined;
  let output: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored letters, then an optional colon and the rest
    const m = /^-([A-Za-z]+)(?::(.*))?$/.exec(t);
    if (!m) { positional.push(t); continue; }
    const name = m[1].toLowerCase();
    const value = m[2] ?? (["usebasicparsing", "useb", "passthru", "skipcertificatecheck", "resume", "noproxy", "usedefaultcredentials", "disablekeepalive"].includes(name) ? undefined : argv[++i]);
    if (name === "uri" || name === "u") uri = value;
    else if (name === "outfile" || name === "o") output = value;
  }
  const url = uri ?? positional.find((p) => /^https?:\/\//i.test(p));
  if (!url) return null;
  return { url, ...(output ? { output } : {}), stdout: output === undefined, via: "powershell" };
}

/** A fetch one simple command makes, if it is one: curl, wget, or PowerShell's web cmdlets. */
function readFetch(sc: SimpleCommand, dialect: "posix" | "powershell"): Fetch | null {
  if (sc.opaque) return null;
  const program = canonProgram(sc.program);
  if (["invoke-webrequest", "iwr", "invoke-restmethod", "irm"].includes(program)) return readPowerShellFetch(sc.argv);
  const exe = /\.exe$/i.test(sc.programRaw);
  // In Windows PowerShell `curl` and `wget` name Invoke-WebRequest; in PowerShell 7 they are the real programs. Read as the
  // cmdlet first, then as the program.
  if (dialect === "powershell" && !exe && (program === "curl" || program === "wget")) return readPowerShellFetch(sc.argv) ?? (program === "curl" ? readCurl(sc.argv) : readWget(sc.argv));
  if (program === "curl") return readCurl(sc.argv);
  if (program === "wget") return readWget(sc.argv);
  return null;
}

function lastSegment(url: string): string | undefined {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : undefined;
  } catch { return undefined; }
}

const SHELL_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "python", "python3", "py", "node", "perl", "ruby", "php", "deno", "bun", "pwsh", "powershell",
  "iex", "invoke-expression", "eval", "source", "."]);
const EXECUTABLE = /\.(?:exe|msi|msix|msixbundle|appx|pkg|mpkg|dmg|deb|rpm|apk|apkg|sh|bash|zsh|ps1|psm1|bat|cmd|run|bin|appimage|jar|com|scr|vbs|js|py|command)$/i;
const READ_ONLY = new Set(["git", "ls", "dir", "cat", "type", "less", "more", "head", "tail", "grep", "rg", "find", "tree", "pwd", "echo", "code", "cursor", "open", "wc",
  "stat", "file", "du", "cd", "pushd", "popd", "get-childitem", "gci", "get-content", "gc", "set-location", "sl", "chdir", "test", "[", "true", "false", "printf", "sort", "diff"]);

const sameFile = (a: string, b: string): boolean => {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return norm(a) === norm(b);
};

/** Whether a simple command makes `file` executable or runs it. */
function runsFile(sc: SimpleCommand, file: string): boolean {
  if (sc.opaque) return false;
  const program = canonProgram(sc.program);
  if (sameFile(sc.programRaw, file) || sameFile(sc.programRaw, `./${file}`)) return true;
  if (program === "chmod") {
    const mode = sc.argv.find((a) => !sameFile(a, file) && !a.startsWith("--"));
    const executable = mode !== undefined && (/x/.test(mode) || (/^[0-7]{3,4}$/.test(mode) && /[1357]/.test(mode)));
    return executable && sc.argv.some((a) => sameFile(a, file));
  }
  if (SHELL_RUNNERS.has(program) || ["start-process", "saps", "start", "msiexec", "dpkg", "rpm", "installer", "apt", "apt-get", "sudo", "open", "hdiutil", "invoke-item", "ii"].includes(program)) {
    return sc.argv.some((a) => sameFile(a, file));
  }
  return false;
}

// ---- repositories ----------------------------------------------------------------------------------------------------------

interface Clone { name?: string; version?: string; source_url?: string; source_domain?: string; dir: string; via: string }

const GIT_CLONE_VALUED = ["-b", "--branch", "--depth", "-o", "--origin", "-c", "--config", "--template", "-u", "--upload-pack", "--reference", "--reference-if-able",
  "--separate-git-dir", "--filter", "-j", "--jobs", "--shallow-since", "--shallow-exclude", "--server-option", "--bundle-uri", "--revision"];

function readClone(sc: SimpleCommand): Clone | null {
  if (sc.opaque) return null;
  const program = canonProgram(sc.program);
  let url: string | undefined;
  let dir: string | undefined;
  let branch: string | undefined;
  let via = "git";
  if (program === "git") {
    const g = gitArgs(sc);
    if (!g || g.sub !== "clone") return null;
    const s = scan(g.args, GIT_CLONE_VALUED);
    [url, dir] = s.positionals;
    branch = flagValue(s, "-b", "--branch");
  } else if (program === "gh") {
    const [area, action, ...rest] = sc.argv;
    if (area !== "repo" || action !== "clone") return null;
    const end = rest.indexOf("--");
    const words = (end < 0 ? rest : rest.slice(0, end)).filter((w) => !w.startsWith("-"));
    [url, dir] = words;
    if (url && !/[:/].*[:/]|^https?:/i.test(url) && /^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
    via = "gh";
  } else return null;
  if (!url) return null;
  const src = sourceOf(url);
  const path = src ? src.source_url.replace(/^[a-z]+:\/\/[^/]+\/?/i, "").replace(/\.git$/i, "") : undefined;
  const target = dir ?? (path ? path.split("/").pop() : undefined) ?? lastSegment(url)?.replace(/\.git$/i, "");
  if (!target) return null;
  return {
    via, dir: target,
    ...(src ? { name: clip(`${src.source_domain}/${path}`, 200), source_url: src.source_url.replace(/\.git$/i, ""), source_domain: src.source_domain } : {}),
    ...(word(branch, 100) ? { version: word(branch, 100) } : {}),
  };
}

/** Whether a simple command, run after a clone into `dir` (and possibly after `cd` into it), runs something from it. */
function runsFromClone(sc: SimpleCommand, dir: string, inside: boolean): boolean {
  if (sc.opaque) return false;
  const program = canonProgram(sc.program);
  if (program === "") return false;
  const under = (p: string): boolean => { const n = p.replace(/\\/g, "/").replace(/^\.\//, ""); return n === dir || n.startsWith(`${dir}/`); };
  if (inside && !READ_ONLY.has(program)) return true;
  if (under(sc.programRaw)) return true;
  if (READ_ONLY.has(program)) return false;
  // `bash repo/install.sh`, `make -C repo`, `npm --prefix repo install`, `pip install ./repo`, `python repo/setup.py`.
  return sc.argv.some((a, i) => under(a) || (["-C", "--prefix", "--dir", "--directory", "--cwd", "--manifest-path", "-f", "--file"].includes(sc.argv[i - 1] ?? "") && under(a)));
}

// ---- containers ------------------------------------------------------------------------------------------------------------

const DOCKER_GLOBAL_VALUED = new Set(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]);
const DOCKER_RUN_VALUED = new Set(["-e", "--env", "--env-file", "-v", "--volume", "-p", "--publish", "--name", "-w", "--workdir", "--network", "--net", "--entrypoint", "-u", "--user",
  "--platform", "--mount", "-l", "--label", "--label-file", "--cpus", "-m", "--memory", "--memory-swap", "--restart", "--pull", "-h", "--hostname", "--add-host", "--device",
  "--cap-add", "--cap-drop", "--security-opt", "--gpus", "--ulimit", "--log-driver", "--log-opt", "--tmpfs", "--shm-size", "--ipc", "--pid", "--expose", "--link", "--dns",
  "--dns-search", "--dns-option", "--runtime", "--stop-signal", "--stop-timeout", "--health-cmd", "--health-interval", "--health-retries", "--health-timeout", "--health-start-period",
  "-a", "--attach", "--cidfile", "--volumes-from", "--group-add", "--isolation", "--userns", "--uts", "--cgroupns", "--cgroup-parent", "--cpu-shares", "-c", "--cpuset-cpus",
  "--cpuset-mems", "--cpu-period", "--cpu-quota", "--memory-reservation", "--kernel-memory", "--blkio-weight", "--device-read-bps", "--device-write-bps", "--ip", "--ip6",
  "--mac-address", "--network-alias", "--oom-score-adj", "--pids-limit", "--storage-opt", "--sysctl", "--annotation", "--detach-keys", "--domainname", "--link-local-ip",
  "--volume-driver", "--device-cgroup-rule", "--publish-all-ports", "-q", "--quiet"]);
const DOCKER_RUN_BOOL = new Set(["-d", "--detach", "-i", "--interactive", "-t", "--tty", "-it", "-ti", "--rm", "--privileged", "--init", "-P", "--publish-all", "--read-only",
  "--no-healthcheck", "--oom-kill-disable", "--sig-proxy", "--disable-content-trust", "--use-api-socket"]);

/** An image reference: `[registry/]path[:tag][@digest]`. The registry is the first part when it has a dot or a port, or is
 *  `localhost`; otherwise none is named (the engine's configured one is used). */
function imageOf(ref: string): Spec | null {
  if (!ref || ref.length > MAX_SPEC || ref.startsWith("-") || ref.includes(SUBST) || ref.includes("$")) return null;
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; the name class cannot contain `@`, which starts the digest
  const m = /^([^@\s]+?)(?:@([A-Za-z0-9]+:[0-9a-fA-F]{32,128}))?$/.exec(ref);
  if (!m) return null;
  let rest = m[1];
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  const parts = rest.split("/");
  const registry = parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === "localhost") ? parts[0].toLowerCase() : undefined;
  const name = word(rest.toLowerCase());
  if (!name) return null;
  const version = m[2] ? word(m[2], 100) : tag ? word(tag, 100) : undefined;
  return { name, ...(version ? { version } : {}), ...(registry ? { source_domain: registry.replace(/:\d+$/, "") } : {}) };
}

function dockerInstalls(sc: SimpleCommand): Facts[] {
  if (sc.opaque) return [];
  const program = canonProgram(sc.program);
  let argv: readonly string[];
  if (program === "docker-compose") argv = ["compose", ...sc.argv];
  else if (program === "docker" || program === "podman" || program === "nerdctl") argv = sc.argv;
  else return [];
  const via = program === "docker-compose" ? "docker" : program;
  let i = skipOptions(argv, 0, DOCKER_GLOBAL_VALUED);
  let sub = argv[i];
  if ((sub === "image" || sub === "container") && argv[i + 1] !== undefined) { i++; sub = argv[i]; }
  if (sub === "compose") {
    const k = skipOptions(argv, i + 1, new Set(["-f", "--file", "-p", "--project-name", "--profile", "--env-file", "--project-directory", "--ansi", "--parallel", "--progress"]));
    const verb = argv[k];
    if (verb === "pull") return [{ route: "docker_pull", ecosystem: "container", verb: "pull", from_manifest: true, via }];
    if (verb === "up" || verb === "run" || verb === "create") return [{ route: "docker_run", ecosystem: "container", verb: "run", from_manifest: true, via }];
    return [];
  }
  if (sub === "pull") {
    const k = skipOptions(argv, i + 1, new Set(["--platform"]));
    const image = imageOf(argv[k] ?? "");
    return image ? [{ route: "docker_pull", ecosystem: "container", verb: "pull", via, ...image }] : [];
  }
  if (sub === "run" || sub === "create") {
    let k = i + 1;
    while (k < argv.length) {
      const t = argv[k];
      if (t === "--") { k++; break; }
      if (!t.startsWith("-") || t === "-") break;
      const eq = t.indexOf("=");
      const name = eq > 0 ? t.slice(0, eq) : t;
      if (eq > 0 || DOCKER_RUN_BOOL.has(name)) { k++; continue; }
      if (DOCKER_RUN_VALUED.has(name)) { k += 2; continue; }
      // An attached short value (`-p8080:80`, `-eX=1`) or a cluster of switches (`-dit`).
      if (/^-[A-Za-z]/.test(t) && !t.startsWith("--")) { k++; continue; }
      // A long option this reader does not know: the image may be its value, so it is not named.
      return [{ route: "docker_run", ecosystem: "container", verb: "run", via }];
    }
    const image = imageOf(argv[k] ?? "");
    return image ? [{ route: "docker_run", ecosystem: "container", verb: "run", via, ...image }] : [{ route: "docker_run", ecosystem: "container", verb: "run", via }];
  }
  return [];
}

// ---- MCP servers ---------------------------------------------------------------------------------------------------------------

/** What an MCP server's launch command (or URL) installs or reaches. */
function launchFacts(command: string | undefined, args: readonly string[], url: string | undefined, server: string | undefined, via: string): Facts {
  const base = { route: "mcp_settings" as const, verb: "configure" as const, via, ...(word(server, 100) ? { mcp_server: word(server, 100) } : {}) };
  const remote = sourceOf(url);
  if (remote) return { ...base, ecosystem: "remote", ...remote };
  if (command) {
    const words = [command, ...args].map((w) => String(w));
    const sc = decomposeShell(words.map((w) => (/[\s"'$`\\|&;<>()]/.test(w) ? `'${w.replace(/'/g, "")}'` : w)).join(" ")).find((c) => !c.opaque && c.program !== "");
    if (sc) {
      // A server started through a runner or a container is that package or image.
      const installs = [...packageInstalls(sc), ...dockerInstalls(sc)];
      const first = installs[0];
      if (first) {
        const { route: _route, verb: _verb, via: _via, auto_confirm: _yes, global: _global, lifecycle_scripts: _scripts, ...rest } = first;
        void _route; void _verb; void _via; void _yes; void _global; void _scripts;
        return { ...base, ...rest };
      }
    }
  }
  return { ...base, ecosystem: "unknown" };
}

/** `claude mcp add`, `claude mcp add-json`, `codex mcp add`, `code --add-mcp`: the server each adds. */
function mcpCliInstalls(sc: SimpleCommand): Facts[] {
  if (sc.opaque) return [];
  const program = canonProgram(sc.program);
  const argv = sc.argv;
  if ((program === "code" || program === "code-insiders" || program === "cursor") && argv.includes("--add-mcp")) {
    const json = argv[argv.indexOf("--add-mcp") + 1];
    return fromJsonServers(json, program);
  }
  if ((program !== "claude" && program !== "codex") || argv[0] !== "mcp") return [];
  const sub = argv[1];
  if (program === "claude" && sub === "add-json") {
    const rest = argv.slice(2).filter((w) => !w.startsWith("-"));
    const [name, json] = rest;
    try { const server = JSON.parse(json ?? "") as Record<string, unknown>; return [serverFacts(name, server, program)]; } catch { return [{ route: "mcp_settings", ecosystem: "unknown", verb: "configure", via: program, ...(word(name, 100) ? { mcp_server: word(name, 100) } : {}) }]; }
  }
  if (sub !== "add") return [];
  const valued = new Set(program === "claude" ? ["-s", "--scope", "-t", "--transport", "-e", "--env", "-H", "--header", "--client-id", "--callback-port"] : ["--env", "--url", "--bearer-token-env-var"]);
  const words: string[] = [];
  let url: string | undefined;
  let transport: string | undefined;
  let k = 2;
  for (; k < argv.length; k++) {
    const t = argv[k];
    if (t === "--") { k++; break; }
    if (t.startsWith("-")) {
      const eq = t.indexOf("=");
      const name = eq > 0 ? t.slice(0, eq) : t;
      const value = eq > 0 ? t.slice(eq + 1) : valued.has(name) ? argv[++k] : undefined;
      if (name === "--url") url = value;
      if (name === "-t" || name === "--transport") transport = value;
      continue;
    }
    words.push(t);
    // Claude Code: `add <name> <commandOrUrl> [args…]` — the words after the command are its arguments.
    if (program === "claude" && words.length === 2) { k++; break; }
  }
  const name = words[0];
  const rest = argv.slice(k);
  if (program === "claude") {
    const target = words[1] ?? rest[0];
    const args = words[1] !== undefined ? rest : rest.slice(1);
    if (target && (transport === "http" || transport === "sse" || /^https?:\/\//i.test(target))) return [launchFacts(undefined, [], target, name, program)];
    return [launchFacts(target, args, undefined, name, program)];
  }
  return [launchFacts(rest[0], rest.slice(1), url, name, program)];
}

function serverFacts(name: string | undefined, server: Record<string, unknown>, via: string): Facts {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const args = Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === "string") : [];
  return launchFacts(str(server.command), args, str(server.url) ?? str(server.serverUrl) ?? str(server.httpUrl), name ?? str(server.name), via);
}

function fromJsonServers(text: string | undefined, via: string): Facts[] {
  if (!text) return [];
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc && typeof doc === "object" && !Array.isArray(doc) && (doc.command !== undefined || doc.url !== undefined)) return [serverFacts(undefined, doc, via)];
  } catch { /* not JSON */ }
  return [];
}

/** The MCP settings files of the coding tools this hook supports, by path. */
export const MCP_SETTINGS_FILE = /(?:^|[\\/])(?:\.mcp\.json|\.cursor[\\/]mcp\.json|\.vscode[\\/]mcp\.json|\.claude\.json|\.codex[\\/]config\.toml|\.copilot[\\/]mcp-config\.json)$/i;
const SETTINGS_LIMIT = 256 * 1024;

/** The tool a settings file belongs to, for `via`. */
function settingsVia(path: string): string {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (p.endsWith(".cursor/mcp.json")) return "cursor";
  if (p.endsWith(".vscode/mcp.json")) return "vscode";
  if (p.endsWith(".codex/config.toml")) return "codex";
  if (p.endsWith(".copilot/mcp-config.json")) return "copilot";
  return "claude";
}

/** Every MCP server a settings text configures: the servers objects of a whole JSON file, or, for a fragment (an edit, a
 *  patch, TOML), each `command`/`args`/`url` it shows. Server environment values and headers are never read. */
function settingsServers(text: string, via: string): Facts[] {
  const out: Facts[] = [];
  const body = text.length > SETTINGS_LIMIT ? text.slice(0, SETTINGS_LIMIT) : text;
  try {
    const doc = JSON.parse(body) as unknown;
    const walk = (node: unknown, depth: number): void => {
      if (depth > 6 || !node || typeof node !== "object" || Array.isArray(node) || out.length >= MAX_ACTIONS) return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if ((key === "mcpServers" || key === "servers" || key === "mcp_servers") && value && typeof value === "object" && !Array.isArray(value)) {
          for (const [name, server] of Object.entries(value as Record<string, unknown>)) {
            if (server && typeof server === "object" && !Array.isArray(server) && out.length < MAX_ACTIONS) out.push(serverFacts(name, server as Record<string, unknown>, via));
          }
        } else walk(value, depth + 1);
      }
    };
    walk(doc, 0);
    return out;
  } catch { /* a fragment: read it below */ }
  // A patch's added lines, without their `+`.
  const lines = body.split(/\r?\n/).map((l) => (/^\+(?!\+\+)/.test(l) ? l.slice(1) : l)).join("\n");
  const strings = (list: string): string[] => [...list.matchAll(/"((?:[^"\\\n]|\\.){0,500})"|'([^'\n]{0,500})'/g)].map((m) => m[1] ?? m[2]);
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: each alternative is anchored on a fixed key and a bounded quoted value
  const keyRe = /(?:"(command|url|serverUrl|httpUrl)"\s*:|\b(command|url)\s*=)\s*"((?:[^"\\\n]|\\.){0,1000})"/g;
  const matches = [...lines.matchAll(keyRe)];
  for (let i = 0; i < matches.length && out.length < MAX_ACTIONS; i++) {
    const m = matches[i];
    const key = m[1] ?? m[2];
    const value = m[3];
    const end = matches[i + 1]?.index ?? Math.min(lines.length, (m.index ?? 0) + 4000);
    const window = lines.slice((m.index ?? 0) + m[0].length, end);
    // A TOML table name (`[mcp_servers.name]`) or a JSON key (`"name": {`) just before names the server.
    const before = lines.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0);
    const name = /\[mcp_servers\.([A-Za-z0-9_-]{1,100})\][^[]*$/.exec(before)?.[1] ?? /"([A-Za-z0-9_.@/-]{1,100})"\s*:\s*\{[^{}]*$/.exec(before)?.[1];
    if (key === "command") {
      const args = /(?:"args"\s*:|\bargs\s*=)\s*\[([^\]]{0,4000})\]/.exec(window)?.[1];
      out.push(launchFacts(value, args ? strings(args) : [], undefined, name, via));
    } else out.push(launchFacts(undefined, [], value, name, via));
  }
  return out;
}

// ---- assembling -----------------------------------------------------------------------------------------------------------------

function toAction(f: Facts, derivedFrom: "shell.exec" | "file.write"): InstallAction {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined) params[k] = v;
  return { action_type: "software.install", params: { ...params, derived_from: derivedFrom, risk_class: "sensitive" } };
}

function dedupe(actions: InstallAction[]): InstallAction[] {
  const seen = new Set<string>();
  const out: InstallAction[] = [];
  for (const a of actions) {
    const key = JSON.stringify(Object.entries(a.params).sort(([x], [y]) => (x < y ? -1 : 1)));
    if (!seen.has(key)) { seen.add(key); out.push(a); }
    if (out.length >= MAX_ACTIONS) break;
  }
  return out;
}

const scriptFacts = (fetch: Fetch, via = fetch.via): Facts => ({ route: "curl_pipe_shell", ecosystem: "script", verb: "run", via, ...(sourceOf(fetch.url) ?? {}) });

/** The script installs of one command line: a fetch fed to a shell, at this level and inside `sh -c` scripts. */
function scriptInstalls(command: string, dialect: "posix" | "powershell", depth = 0): Facts[] {
  if (depth > 4) return [];
  const parts = splitCommandLine(command);
  if (!parts) return [];
  const out: Facts[] = [];
  const decomposed = parts.map((p) => decomposeShell(p.text));
  const main = (i: number): SimpleCommand | undefined => [...decomposed[i]].reverse().find((sc) => sc.raw === parts[i].text && !sc.opaque && sc.program !== "")
    ?? decomposed[i].find((sc) => !sc.opaque && sc.program !== "");
  for (let i = 0; i < parts.length; i++) {
    const head = main(i);
    // `curl … | sh`, `wget -qO- … | sudo bash`, `iwr … | iex`.
    if (parts[i].sep === "|" && i + 1 < parts.length) {
      const fetch = decomposed[i].map((sc) => readFetch(sc, dialect)).find((f): f is Fetch => f !== null && f.stdout);
      const next = decomposed[i + 1].filter((sc) => !sc.opaque && sc.program !== "").map((sc) => canonProgram(sc.program));
      if (fetch && next.some((p) => SHELL_RUNNERS.has(p) && p !== "source" && p !== ".")) out.push(scriptFacts(fetch));
    }
    if (!head) continue;
    const program = canonProgram(head.program);
    const text = parts[i].text;
    // `sh -c "$(curl …)"`, `bash <(curl …)`, `eval "$(wget -qO- …)"`, `source <(curl …)`, `iex (iwr …)`: the fetch's output runs.
    if (SHELL_RUNNERS.has(program) && /\$\(|`|<\(|\(\s*(?:iwr|irm|invoke-webrequest|invoke-restmethod|new-object)\b/i.test(text)) {
      const fetch = decomposed[i].filter((sc) => sc !== head).map((sc) => readFetch(sc, dialect)).find((f): f is Fetch => f !== null && f.stdout);
      if (fetch) out.push(scriptFacts(fetch));
    }
    // PowerShell's `iex ((New-Object Net.WebClient).DownloadString('https://…'))`.
    if ((program === "iex" || program === "invoke-expression") && /downloadstring|downloadfile|net\.webclient/i.test(text)) {
      const url = /https?:\/\/[^\s'"()]+/i.exec(text)?.[0];
      if (url) out.push(scriptFacts({ url, stdout: true, via: "powershell" }));
    }
    // A script given to a shell is a command line of its own.
    if (["sh", "bash", "zsh", "dash", "ksh", "ash"].includes(program)) {
      const script = shellScriptArg(head.argv);
      if (script && !/^\s*\$\(/.test(script)) out.push(...scriptInstalls(script, "posix", depth + 1));
    }
    if (program === "powershell" || program === "pwsh") {
      const at = head.argv.findIndex((a) => /^[-/](?:c|command)$/i.test(a));
      if (at >= 0 && at + 1 < head.argv.length) out.push(...scriptInstalls(head.argv.slice(at + 1).join(" "), "powershell", depth + 1));
    }
  }
  return out;
}

/**
 * The `software.install` actions one shell command line performs: every package install it names, a script it feeds to a
 * shell, a download it runs or that is a program, a clone (and a clone whose scripts it runs), a container it pulls or runs,
 * and an MCP server it adds. Pure and deterministic. Each action carries `via`, `derived_from: "shell.exec"` and
 * `risk_class: "sensitive"`.
 */
export function deriveInstalls(command: string, dialect: "posix" | "powershell" = "posix"): InstallAction[] {
  try {
    const src = dialect === "powershell" ? command.replace(/`(.)/g, "$1").replace(/\\/g, "/") : command;
    const all = decomposeShell(src);
    const facts: Facts[] = [];
    for (const sc of all) facts.push(...packageInstalls(sc), ...dockerInstalls(sc), ...mcpCliInstalls(sc));
    facts.push(...scriptInstalls(src, dialect));
    // Downloads and clones, in the order the command line runs them.
    for (let i = 0; i < all.length; i++) {
      const sc = all[i];
      const fetch = readFetch(sc, dialect);
      if (fetch?.output) {
        const executed = all.slice(i + 1).some((later) => runsFile(later, fetch.output!));
        if (executed || EXECUTABLE.test(fetch.output) || EXECUTABLE.test(lastSegment(fetch.url) ?? "")) {
          facts.push({ route: "download_exec", ecosystem: "binary", verb: "download", via: fetch.via, executed, ...(sourceOf(fetch.url) ?? {}) });
        }
      }
      const clone = readClone(sc);
      if (clone) {
        let inside = false;
        let runs = false;
        for (const later of all.slice(i + 1)) {
          const p = canonProgram(later.program);
          if (/^(?:cd|pushd|chdir|set-location|sl)$/.test(p)) {
            const target = (later.argv.find((a) => !a.startsWith("-")) ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
            inside = target === clone.dir || target.startsWith(`${clone.dir}/`) || (inside && !target.startsWith("/") && !target.startsWith(".."));
            continue;
          }
          if (runsFromClone(later, clone.dir, inside)) { runs = true; break; }
        }
        const { dir: _dir, ...rest } = clone;
        void _dir;
        facts.push({ route: runs ? "git_clone_run" : "git_clone", ecosystem: "git", verb: "clone", ...rest });
      }
    }
    return dedupe(facts.map((f) => toAction(f, "shell.exec")));
  } catch { return []; }
}

/** The `software.install` actions a write to a coding tool's MCP settings file performs: one per server the written text
 *  configures. Nothing for any other file. `text` is the new content (a whole file, an edit's new text or a patch). */
export function deriveSettingsInstalls(path: string, text: string): InstallAction[] {
  try {
    if (!MCP_SETTINGS_FILE.test(path) || text === "") return [];
    return dedupe(settingsServers(text, settingsVia(path)).map((f) => toAction(f, "file.write")));
  } catch { return []; }
}
