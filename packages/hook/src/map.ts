// The mapper: a pure function from a coding agent's native tool call to the
// normalized Scopebond actions (Action Taxonomy v1) it represents. Deterministic
// and side-effect free, so it can be conformance-tested directly.
//
// A shell tool call can carry several commands (`a && b`, `$(c)`, `bash -c '…'`);
// the mapper decomposes it and returns one intent per simple command, so the
// runtime evaluates every one and denies if any is out of policy. Non-shell tools
// map to a single intent (a one-element array).

import { digest, redactCommand, scrubParam, scrubSecrets } from "./minimize.js";
import { canonProgram, decomposeShell, parseGitPush, type SimpleCommand } from "./shell.js";

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

// Canonicalize a path before any guard sees it:
//  - Windows backslash separators become "/" (the taxonomy path space), so a guard
//    written with "/" cannot be bypassed by `.scopebond\agent.key`;
//  - NTFS alternate-stream suffixes (`.env::$DATA`) and the trailing dots/spaces
//    Windows silently drops from a name (`.env.`, `agent.key `) are removed, so they
//    cannot disguise the file they open;
//  - `//` and `/./` collapse.
// Case is preserved (it is evidence); the starter policy matches case-insensitively.
// Linear (no regex backtracking on long runs of dots/spaces).
const trimDotsSpaces = (seg: string): string => {
  let end = seg.length;
  while (end > 0 && (seg[end - 1] === "." || seg[end - 1] === " ")) end--;
  return end === 0 ? seg : seg.slice(0, end);
};
const normPath = (s: string): string =>
  s.replace(/\\/g, "/")
    .replace(/::?\$data$/i, "")
    .split("/").map((seg) => (seg === "." || seg === ".." ? seg : trimDotsSpaces(seg))).join("/")
    .replace(/\/(?:\.\/)+/g, "/").replace(/\/{2,}/g, "/");

const rel = (value: unknown, cwd?: string): string => {
  const s = normPath(String(value ?? ""));
  const c = cwd ? normPath(cwd) : undefined;
  if (c && s.toLowerCase().startsWith(c.toLowerCase() + "/")) return s.slice(c.length + 1);
  if (c && s.toLowerCase() === c.toLowerCase()) return ".";
  return s;
};

// Locations the starter policy protects, as concrete sample paths. An operand the
// mapper cannot resolve statically — a glob (`.scope*/agent.key`), a variable
// (`$D/agent.key`), a brace list or a command substitution — is tested against these:
// if it could name one, the intent carries that protected path so the guard sees it
// (the literal operand is kept as `pattern` for the record). Otherwise the literal is
// used. This keeps shell expansion from hiding a protected file from the path guard.
const PROTECTED_SAMPLES = [
  ".scopebond/agent.key", ".scopebond/attester.key", ".scopebond/policy.json", ".scopebond/cloud.json",
  "agent.key", "attester.key", "server.key", "cert.pem", "id.p12", "id.pfx",
  ".env", ".env.local", ".env.production", ".envrc",
  ".ssh/id_rsa", ".ssh/id_ed25519", ".aws/credentials", ".npmrc", ".pypirc", ".netrc", ".git-credentials",
  ".kube/config", ".docker/config.json", ".config/gcloud/credentials.db", ".azure/accessTokens.json",
  ".claude/settings.json", ".claude/settings.local.json", ".cursor/hooks.json", ".codex/hooks.json", ".codex/config.toml",
  ".git/hooks/pre-commit", ".git/config", ".husky/pre-commit", ".github/workflows/ci.yml", ".github/actions/a/action.yml",
  ".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", "Jenkinsfile",
];

const UNRESOLVED = /[*?[\]{}$`]/;

/** Convert a shell word with globs/variables/braces into an anchored matcher. Glob
 *  metacharacters stay within one path segment; a variable or substitution may span
 *  segments. Like the shell, a segment wildcard does not match a leading dot. Linear:
 *  no nested quantifiers are generated. */
function wordMatcher(word: string): RegExp {
  let re = "";
  let segStart = true;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    const leadingDot = segStart ? "(?!\\.)" : "";
    if (c === "*") re += leadingDot + "[^/]*";
    else if (c === "?") re += leadingDot + "[^/]";
    else if (c === "[") { const end = word.indexOf("]", i + 1); re += leadingDot + "[^/]"; if (end > i) i = end; }
    else if (c === "{") { const end = word.indexOf("}", i + 1); re += "[^/]*"; if (end > i) i = end; }
    else if (c === "$" || c === "`") {
      // $VAR, ${VAR…}, $(…) or `…`: any text, possibly several segments.
      if (word[i + 1] === "{" || word[i + 1] === "(") { const close = word[i + 1] === "{" ? "}" : ")"; const end = word.indexOf(close, i + 2); if (end > i) i = end; }
      else if (c === "`") { const end = word.indexOf("`", i + 1); if (end > i) i = end; }
      else while (i + 1 < word.length && /[A-Za-z0-9_]/.test(word[i + 1])) i++;
      re += ".*";
    } else re += c.replace(/[.+^()|\\]/g, "\\$&");
    segStart = c === "/";
  }
  return new RegExp("^(?:" + re + ")$", "i");
}

/** The protected sample an unresolvable operand could name, if any. An operand that
 *  is only wildcards or only a variable (`*`, `$FILE`) carries no name to test and is
 *  left to the literal path — a cooperative hook cannot know a variable's value. */
const MAX_WORD = 4096;
function protectedCandidate(word: string): string | undefined {
  // An absurdly long unresolvable operand is not worth analysing: treat it as if it
  // could name the hook's own files (fail closed) rather than scan it.
  if (word.length > MAX_WORD) return PROTECTED_SAMPLES[0];
  const literal = word.replace(/\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|\$[A-Za-z0-9_]+|[*?[\]{}]/g, "");
  if (!/[A-Za-z0-9]/.test(literal)) return undefined;
  // Compare the operand's last N segments with each N-segment sample, so any prefix —
  // `x/../`, `$HOME/`, an absolute path — cannot move the tail out of view.
  const segs = word.split("/");
  const cache = new Map<number, RegExp>();
  for (const sample of PROTECTED_SAMPLES) {
    const n = sample.split("/").length;
    if (segs.length < n) continue;
    let m = cache.get(n);
    if (!m) { m = wordMatcher(segs.slice(-n).join("/")); cache.set(n, m); }
    if (m.test(sample)) return sample;
  }
  return undefined;
}

/** The file intent for one path operand, resolving it against a `cd` prefix. */
function fileIntent(action: "file.read" | "file.write", word: string, dir: string, cwd?: string): Mapped {
  let w = word;
  if (dir && !/^(?:[\\/]|~|[A-Za-z]:|\$)/.test(w)) w = dir.replace(/\/+$/, "") + "/" + w;
  const path = rel(scrubParam(w), cwd);
  if (UNRESOLVED.test(w)) {
    const hit = protectedCandidate(normPath(w));
    if (hit) return { intent: { action_type: action, params: { path: hit, pattern: path } }, evaluated: true, source: "shell" };
  }
  return { intent: { action_type: action, params: { path } }, evaluated: true, source: "shell" };
}

// Shell programs whose operands are files they READ. A read of the signing keys or a
// secret file through the shell (`cat .scopebond/attester.key`, `grep -r . .scopebond`)
// must reach the same file.read guard as the Read tool.
const READERS = new Set([
  "cat", "tac", "less", "more", "head", "tail", "nl", "od", "xxd", "hexdump", "strings", "base64", "base32",
  "bat", "type", "get-content", "gc", "grep", "egrep", "fgrep", "rg", "ag", "ack", "awk", "gawk", "sort",
  "uniq", "cut", "paste", "diff", "cmp", "comm", "wc", "jq", "yq", "iconv", "openssl", "gpg", "md5sum",
  "sha1sum", "sha256sum", "sha512sum", "shasum", "file", "stat", "source", ".", "select-string", "sls",
  "import-csv", "tar", "zip", "7z", "gzip", "bzip2", "xz", "zstd", "zcat", "vi", "vim", "nano", "code",
]);
// Programs that copy or move: sources are read, the destination is written; `mv`
// also removes its sources, so they are writes too.
const COPIERS = new Set(["cp", "mv", "rsync", "scp", "install", "ln", "copy-item", "cpi", "copy", "move-item", "mi", "move", "robocopy", "xcopy", "rename-item", "ren"]);
const MOVERS = new Set(["mv", "move-item", "mi", "move", "rename-item", "ren"]);
// Programs whose operands are files they WRITE (or whose metadata they change).
const WRITERS = new Set(["tee", "touch", "truncate", "set-content", "sc", "add-content", "ac", "out-file", "new-item", "ni", "clear-content", "clc", "chmod", "chown", "chattr", "attrib", "icacls", "set-acl", "shred", "unlink"]);
// Flags whose value is a file the program reads (`curl -T f`, `curl -d @f`) or writes (`-o f`).
const READ_FLAGS = new Set(["-t", "--upload-file", "-k", "--config", "--input-file", "--post-file", "--body-file", "-in", "-infile", "--key", "--cert", "-f", "--file", "-literalpath", "-path", "-filepath", "-inputobject"]);
const WRITE_FLAGS = new Set(["-o", "--output", "-out", "--output-document", "-destination", "-outfile", "--target-directory"]);
// Names a generic program's operand is checked against even when the program is not
// a known reader: a secret path passed to anything (`git add .env`, `node -r .env`)
// is still a read of that path.
const SENSITIVE = /(?:^|[/\\])(?:\.scopebond(?:[/\\]|$)|\.env(?:\.[^/\\]*)?$|\.envrc$|\.ssh[/\\]|\.aws[/\\]|\.npmrc$|\.pypirc$|_?\.?netrc$|\.git-credentials$|\.kube[/\\]|\.docker[/\\]|\.azure[/\\]|\.config[/\\]gcloud[/\\])|\.(?:key|pem|p12|pfx|jks|keystore)$/i;

const INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3", "py", "ruby", "perl", "php", "osascript", "lua", "tclsh"]);
// Path literals inside inline code. Each alternative starts at a boundary (not after
// a word character — so `process.env` is not `.env`) and has no overlapping repeats,
// keeping the scan linear; input is capped per argument.
const SENSITIVE_IN_CODE = /(?<![\w$])(?:\.scopebond[\\/][\w.-]*|\.env(?:\.[\w-]+)?(?![\w.-])|\.envrc|\.ssh[\\/][\w.-]+|\.aws[\\/]credentials|\.claude[\\/]settings[\w.-]*|\.cursor[\\/]hooks\.json|\.codex[\\/](?:hooks\.json|config\.toml)|\.git[\\/](?:hooks[\\/][\w.-]*|config)|\.github[\\/](?:workflows|actions)[\\/][\w./-]*|\.npmrc|\.git-credentials)|(?<![\w.-])[\w-]+\.(?:key|pem|p12|pfx)(?![\w])/gi;
const CODE_SCAN_LIMIT = 20000;

const isPathWord = (t: string): boolean => t !== "" && !/^\d+$/.test(t) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t);

/** Derive the file.read / file.write intents a simple shell command implies —
 *  operands of reader, copier and writer programs, flag values that name files,
 *  redirection targets, and any operand of any program that names a sensitive
 *  location — resolved against the directory an earlier `cd` in the same call moved
 *  to. These flow through the same protect-read / protect-write clauses as the native
 *  file tools; a false positive (a non-protected operand) is a harmless extra receipt
 *  the starter policy allows. */
function fileOpsFromShell(sc: SimpleCommand, dir: string, cwd?: string): Mapped[] {
  const ops: Mapped[] = [];
  const prog = canonProgram(sc.program);
  const read = (w: string) => { if (isPathWord(w)) ops.push(fileIntent("file.read", w, dir, cwd)); };
  const write = (w: string) => { if (isPathWord(w)) ops.push(fileIntent("file.write", w, dir, cwd)); };

  // Operands (non-flag words) and flag values (`--flag=value`, `-T value`, `@file`, `if=f`).
  const operands: string[] = [];
  const args = sc.argv;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    const lower = t.toLowerCase();
    const eq = t.indexOf("=");
    if (t.startsWith("-") && eq > 0) {                       // --flag=value
      const flag = lower.slice(0, eq);
      const value = t.slice(eq + 1).replace(/^@/, "");
      if (WRITE_FLAGS.has(flag)) write(value); else if (READ_FLAGS.has(flag) || SENSITIVE.test(value) || t[eq + 1] === "@") read(value);
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        if (COPIERS.has(prog) && t === "-t") { write(value); i++; continue; } // cp -t DIR
        if (WRITERS.has(prog) && /^-(?:path|literalpath|filepath)$/.test(lower)) { write(value); i++; continue; } // Set-Content -Path f
        if (WRITE_FLAGS.has(lower)) { write(value); i++; continue; }
        if (READ_FLAGS.has(lower) || value.startsWith("@")) { read(value.replace(/^@/, "")); i++; continue; }
      }
      continue;
    }
    if (prog === "dd" && /^(?:if|of)=/.test(t)) { (t.startsWith("of=") ? write : read)(t.slice(3)); continue; }
    if (t.startsWith("@")) { read(t.slice(1)); continue; }
    operands.push(t);
  }

  if (READERS.has(prog)) operands.forEach(read);
  else if (COPIERS.has(prog) && operands.length) {
    const hasTarget = args.some((a) => /^(?:-t|--target-directory(?:=.*)?|-destination)$/i.test(a) || /^--target-directory=/.test(a));
    const sources = hasTarget ? operands : operands.slice(0, -1);
    sources.forEach(read);
    if (MOVERS.has(prog)) sources.forEach(write);
    if (!hasTarget) write(operands[operands.length - 1]);
  } else if (WRITERS.has(prog)) operands.forEach(write);
  else if ((prog === "sed" || prog === "perl") && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) {
    // `sed -i 's/x/y/' f…`: the first operand is the script (unless -e/-f gave it).
    const scriptGiven = args.some((a) => a === "-e" || a === "-f" || a.startsWith("--expression"));
    (scriptGiven ? operands : operands.slice(1)).forEach(write);
  } else if (INTERPRETERS.has(prog)) {
    // Inline code (`node -e "…"`, `python -c "…"`): best effort — every protected-
    // looking path literal in the code is recorded as both a read and a write. Code
    // that assembles a path at run time is beyond a cooperative hook (use a gateway).
    for (const w of args) for (const m of w.slice(0, CODE_SCAN_LIMIT).match(SENSITIVE_IN_CODE) ?? []) { read(m); write(m); }
  } else {
    for (const w of operands) if (SENSITIVE.test(w) || (UNRESOLVED.test(w) && protectedCandidate(normPath(w)))) read(w);
  }

  for (const r of sc.redirects) {
    if (r.op.startsWith(">")) write(r.target);
    else if (r.op === "<>") { read(r.target); write(r.target); }
    else read(r.target);
  }
  return ops;
}

/** Map one parsed simple command to the intents it implies: the git.push or
 *  shell.exec itself, plus any file reads/writes it performs. An opaque
 *  (unparseable) command becomes a single un-evaluated shell.exec so it fails closed. */
function mapSimpleCommand(sc: SimpleCommand, dir: string, cwd?: string): Mapped[] {
  if (sc.opaque) {
    return [{
      intent: { action_type: "shell.exec", params: { command: redactCommand(sc.raw), program: "", ...(cwd ? { cwd } : {}) } },
      evaluated: false, source: "shell",
    }];
  }
  const push = parseGitPush(sc);
  if (push) {
    // One intent per pushed destination, so a protected branch cannot ride behind
    // an allowed one (`git push origin feature main`).
    return push.targets.map((t) => {
      const params: Record<string, unknown> = { force: t.force };
      if (push.remote !== undefined) params.remote = scrubParam(push.remote);
      if (t.ref !== undefined) params.ref = scrubParam(t.ref);
      return { intent: { action_type: "git.push", params }, evaluated: true, source: "shell" } as Mapped;
    });
  }
  const files = fileOpsFromShell(sc, dir, cwd);
  // A bare redirection (`> file`) runs no program: only its file effect is recorded.
  if (!sc.program) return files;
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
  return [exec, ...files];
}

const CD = new Set(["cd", "pushd", "chdir", "set-location", "sl"]);

/** Decompose a shell command into the intents it will run. A `cd` earlier in the same
 *  call changes the directory later relative operands resolve against
 *  (`cd .scopebond && cp x policy.json` writes `.scopebond/policy.json`). An empty
 *  command yields a single un-evaluated placeholder (nothing to grant). */
function mapShell(command: string, cwd?: string, dialect: "posix" | "powershell" = "posix"): Mapped[] {
  // PowerShell: `\` is a path separator and the backtick is the escape character
  // (``Re`move-Item`` runs Remove-Item). Normalize both before the POSIX parser sees
  // them, so neither hides a program or mangles a Windows path.
  const src = dialect === "powershell" ? command.replace(/`(.)/g, "$1").replace(/\\/g, "/") : command;
  const commands = decomposeShell(src);
  if (commands.length === 0) {
    return [{ intent: { action_type: "shell.exec", params: { command: redactCommand(command), program: "" } }, evaluated: false, source: "shell" }];
  }
  const walk = (list: SimpleCommand[], filesOnly: boolean): Mapped[] => {
    let dir = "";
    const out: Mapped[] = [];
    for (const sc of list) {
      const mapped = mapSimpleCommand(sc, dir, cwd);
      out.push(...(filesOnly ? mapped.filter((m) => m.intent.action_type.startsWith("file.")) : mapped));
      if (!sc.opaque && CD.has(canonProgram(sc.program))) {
        const target = sc.argv.find((a) => !a.startsWith("-"));
        if (target === undefined || target === "~") dir = "";
        else if (/^(?:[\\/]|~[\\/]|[A-Za-z]:)/.test(target)) dir = normPath(target);
        else dir = normPath((dir ? dir + "/" : "") + target);
      }
    }
    return out;
  };
  const out = walk(commands, false);
  // A "Bash" command may really run under PowerShell or cmd (Codex and Cursor on
  // Windows), where `\` separates paths instead of escaping. Read it both ways for
  // file effects, so `.scopebond\policy.json` is not lost as `.scopebondpolicy.json`.
  if (dialect === "posix" && src.includes("\\")) {
    const seen = new Set(out.map((m) => `${m.intent.action_type} ${String(m.intent.params.path)}`));
    for (const m of walk(decomposeShell(src.replace(/\\/g, "/")), true)) {
      const key = `${m.intent.action_type} ${String(m.intent.params.path)}`;
      if (!seen.has(key)) { seen.add(key); out.push(m); }
    }
  }
  return out;
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
  if (name === "Bash" || name === "Shell")
    return mapShell(String(ti.command ?? ""), cwd);
  if (name === "PowerShell")
    return mapShell(String(ti.command ?? ""), cwd, "powershell");
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
  if (name === "PowerShell")
    return mapShell(String(ti.command ?? ti.cmd ?? ""), cwd, "powershell");
  if (name === "Bash" || name === "Shell" || name === "exec_command" || name === "unified_exec")
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
