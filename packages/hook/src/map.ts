// The mapper: a pure function from a coding agent's native tool call to the
// normalized Scopebond actions (Action Taxonomy v1) it represents. Deterministic
// and side-effect free, so it can be conformance-tested directly.
//
// A shell tool call can carry several commands (`a && b`, `$(c)`, `bash -c '…'`);
// the mapper decomposes it and returns one intent per simple command, so the
// runtime evaluates every one and denies if any is out of policy. Non-shell tools
// map to a single intent (a one-element array), or one per spelling of an
// ambiguous Windows short path.

import { digest, redactCommand, scrubParam, scrubSecrets } from "./minimize.js";
import { canonProgram, decomposeShell, gitArgs, parseGitPush, type SimpleCommand } from "./shell.js";

export interface NormalizedIntent {
  action_type: string;
  params: Record<string, unknown>;
}
export interface Mapped {
  intent: NormalizedIntent;
  /** false when no taxonomy type applies (an unknown tool) or when the command's
   *  effect cannot be judged from its text (`patch`, `git apply`, `tar x`): emitted to
   *  the observation path (not_evaluated) in normal mode and denied by the closed
   *  allowlist in strict mode — never granted. A shell command that could not be
   *  parsed, or whose program is only known at run time, is evaluated with an empty
   *  program, which the starter policy denies in every mode. */
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

// Windows 8.3 short names: `CLAUDE~1` opens `.claude`, `SCOPEB~1` opens `.scopebond`,
// `SETTIN~1.JSO` opens `settings.json`. A short segment that could abbreviate a
// protected name is expanded to every protected name it could stand for, and the
// path is checked in each spelling. Only the names below are expanded; any other
// short name is left as written.
const SHORT_SEGMENT = /^([^.~\s/]{1,6})~\d{1,6}(?:\.([^.\s/]{1,3}))?$/;
const SHORT_TARGETS = [
  ".scopebond", ".claude", ".cursor", ".codex", ".github", ".git", ".husky", ".circleci", ".gitlab-ci.yml", ".gitlab-ci.yaml",
  ".mcp.json", "azure-pipelines.yml", "Jenkinsfile", "workflows", "actions", "settings.json", "settings.local.json", "hooks.json",
  "config.toml", "agents", ".ssh", ".aws", ".kube", ".docker", ".azure", ".gnupg", ".config", ".env", ".env.local", ".env.production",
  ".envrc", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "credentials", ".credentials.json", "id_ed25519", "config.json",
  "accessTokens.json", "credentials.db", "attester.key", "policy.json", "cloud.json",
];
function abbreviates(prefix: string, ext: string, long: string): boolean {
  const name = long.replace(/^\.+/, "");
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/[.\s]/g, "").toUpperCase();
  const longExt = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
  return base.length > 0 && base.startsWith(prefix.toUpperCase()) && longExt.slice(0, 3) === ext.toUpperCase()
    && (base.length > 8 || long.startsWith(".") || longExt.length > 3 || name.includes(" "));
}
/** Every spelling a path could have with its short segments expanded (at most 16). */
function pathVariants(path: string): string[] {
  if (!path.includes("~")) return [path];
  let variants: string[][] = [[]];
  for (const seg of path.split("/")) {
    const m = SHORT_SEGMENT.exec(seg);
    const long = m ? SHORT_TARGETS.filter((t) => abbreviates(m[1], m[2] ?? "", t)) : [];
    const choices = long.length ? long : [seg];
    const next: string[][] = [];
    for (const v of variants) for (const c of choices) if (next.length < 16) next.push([...v, c]);
    variants = next;
  }
  return [...new Set(variants.map((v) => v.join("/")))];
}

/** One file intent per spelling of `path` (normally one). */
function pathIntents(action: "file.read" | "file.write", path: string, source: string, extra: Record<string, unknown> = {}): Mapped[] {
  return pathVariants(path).map((p) => ({ intent: { action_type: action, params: { path: p, ...extra } }, evaluated: true, source }));
}

// Locations the starter policy protects, as concrete sample paths (files, and the
// protected directories themselves). An operand the mapper cannot resolve
// statically — a glob (`.scope*/agent.key`, `.*/*`), a variable (`$D/agent.key`), a
// brace list or a command substitution — is tested against these: if it could name
// one, the intent carries that protected path so the guard sees it (the literal
// operand is kept as `pattern` for the record). Otherwise the literal is used. This
// keeps shell expansion from hiding a protected file from the path guard.
const PROTECTED_SAMPLES = [
  ".scopebond/agent.key", ".scopebond/attester.key", ".scopebond/policy.json", ".scopebond/cloud.json",
  "agent.key", "attester.key", "server.key", "cert.pem", "id.p12", "id.pfx",
  ".env", ".env.local", ".env.production", ".envrc",
  ".ssh/id_rsa", ".ssh/id_ed25519", ".aws/credentials", ".npmrc", ".pypirc", ".netrc", ".git-credentials",
  ".kube/config", ".docker/config.json", ".config/gcloud/credentials.db", ".azure/accessTokens.json",
  ".config/gh/hosts.yml", ".claude/.credentials.json",
  ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/hook.sh", ".claude/agents/agent.md",
  ".cursor/hooks.json", ".codex/hooks.json", ".codex/config.toml", ".mcp.json",
  ".git/hooks/pre-commit", ".git/config", ".husky/pre-commit", ".github/workflows/ci.yml", ".github/actions/a/action.yml",
  ".gitlab-ci.yml", ".gitlab-ci.yaml", ".circleci/config.yml", "azure-pipelines.yml", "Jenkinsfile",
  // the protected directories themselves (a recursive reader or copier given the directory)
  ".scopebond", ".ssh", ".aws", ".kube", ".docker", ".azure", ".gnupg", ".config/gcloud", ".config/gh",
];

const UNRESOLVED = /[*?[\]{}$`]/;
const EXPANSION = /\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|\$[A-Za-z0-9_]+|[*?[\]{}]/g;

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

// The protected sample an unresolvable operand could name, if any. The operand's
// last N segments are compared with each N-segment sample, so any prefix — `x/../`,
// `$HOME/`, an absolute path — cannot move the tail out of view. A tail made only of
// wildcards or variables (`*`, the last segment of `src/*`, `$FILE`) names nothing and
// is not compared — `cat logs/*` is not a read of `agent.key` — but a tail with any
// literal text, even a lone dot, is: `.*/*` can reach `.scopebond/agent.key`.
const MAX_WORD = 4096;
function protectedCandidate(word: string): string | undefined {
  // An absurdly long unresolvable operand is not worth analysing: treat it as if it
  // could name the hook's own files (fail closed) rather than scan it.
  if (word.length > MAX_WORD) return PROTECTED_SAMPLES[0];
  const segs = word.split("/");
  const cache = new Map<number, RegExp | null>();
  for (const sample of PROTECTED_SAMPLES) {
    const n = sample.split("/").length;
    if (segs.length < n) continue;
    let m = cache.get(n);
    if (m === undefined) {
      const tail = segs.slice(-n).join("/");
      m = /[^/]/.test(tail.replace(EXPANSION, "")) ? wordMatcher(tail) : null;
      cache.set(n, m);
    }
    if (m && m.test(sample)) return sample;
  }
  return undefined;
}

/** The file intents for one path operand, resolving it against a `cd` prefix. */
function fileIntent(action: "file.read" | "file.write", word: string, dir: string, cwd?: string): Mapped[] {
  let w = word;
  if (dir && !/^(?:[\\/]|~|[A-Za-z]:|\$)/.test(w)) w = dir.replace(/\/+$/, "") + "/" + w;
  const path = rel(scrubParam(w), cwd);
  if (UNRESOLVED.test(w)) {
    const hit = protectedCandidate(normPath(w));
    if (hit) return pathIntents(action, hit, "shell", { pattern: path });
  }
  return pathIntents(action, path, "shell");
}

// Shell programs whose operands are files whose CONTENT they output, copy or send. A
// read of the signing keys or a secret file through the shell (`cat .scopebond/attester.key`,
// `grep -r . .scopebond`) must reach the same file.read guard as the Read tool.
// Metadata-only programs (`ls`, `stat`, `test`, `[`, `file`) are not readers.
const READERS = new Set([
  "cat", "tac", "less", "more", "head", "tail", "nl", "od", "xxd", "hexdump", "strings", "base64", "base32",
  "bat", "type", "get-content", "gc", "grep", "egrep", "fgrep", "rg", "ag", "ack", "awk", "gawk", "mawk", "nawk", "sort",
  "uniq", "cut", "paste", "diff", "cmp", "comm", "wc", "jq", "yq", "sed", "iconv", "openssl", "gpg", "md5sum",
  "sha1sum", "sha256sum", "sha512sum", "shasum", "source", ".", "select-string", "sls",
  "import-csv", "tar", "bsdtar", "zip", "7z", "7za", "7zz", "gzip", "bzip2", "xz", "zstd", "zcat", "view", "code",
]);
// Editors read their operands and can write them (`vim -es -c ':wq' f`, `ed f`).
const EDITORS = new Set(["vi", "vim", "nvim", "ex", "ed", "nano", "pico", "emacs", "micro", "joe", "kak", "hx", "helix", "mcedit"]);
// Programs that copy or move: sources are read, the destination is written; `mv`
// also removes its sources, so they are writes too.
const COPIERS = new Set(["cp", "mv", "rsync", "scp", "install", "ln", "copy-item", "cpi", "copy", "move-item", "mi", "move", "robocopy", "xcopy", "rename-item", "ren"]);
const MOVERS = new Set(["mv", "move-item", "mi", "move", "rename-item", "ren"]);
// Programs whose operands are files they WRITE (or whose metadata they change).
const WRITERS = new Set(["tee", "touch", "truncate", "set-content", "sc", "add-content", "ac", "out-file", "new-item", "ni", "clear-content", "clc", "chmod", "chown", "chattr", "attrib", "icacls", "set-acl", "shred", "unlink", "sponge"]);
// Programs that send what they are given elsewhere (network, clipboard, mail): an
// operand naming a secret location is a read of it.
const UPLOADERS = new Set([
  "curl", "wget", "http", "https", "xh", "httpie", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "lftp", "smbclient",
  "aws", "gsutil", "gcloud", "az", "rclone", "s3cmd", "gh", "glab", "mail", "mailx", "sendmail", "mutt", "xclip", "xsel",
  "pbcopy", "wl-copy", "clip", "set-clipboard", "croc", "wormhole",
]);
// Flags whose value is a file the program reads (`curl -T f`, `curl -d @f`) or writes (`-o f`).
// Read flags apply to readers, copiers and uploaders only (`test -f .env` reads nothing).
const READ_FLAGS = new Set(["-t", "--upload-file", "-k", "--config", "--input-file", "--post-file", "--body-file", "-in", "-inkey", "-key", "-infile", "--key", "--cert", "-f", "--file", "-literalpath", "-path", "-filepath", "-inputobject"]);
const WRITE_FLAGS = new Set(["-o", "--output", "-out", "--output-document", "-destination", "-outfile", "--target-directory"]);
// curl/wget request-body and form flags carry inline data, not a filename — a quoted
// JSON body must not be read as a glob over a protected path. Their value names a file
// only through `@`: `-d @.env`, `-F upload=@secret`, `--data-urlencode key@file`.
const CURL_DATA = new Set(["-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--json", "--post-data", "--body-data"]);
const CURL_URLENCODE = "--data-urlencode";
const CURL_FORM = new Set(["-F", "--form", "--form-string"]);
/** The file a curl/wget body/form value points at with `@`, or undefined for inline data. */
function curlFileRef(flag: string, value: string): string | undefined {
  if (value.startsWith("@")) return value.slice(1).split(";")[0];
  if (flag === CURL_URLENCODE) { const m = /^[^=@]*@(.+)$/.exec(value); if (m) return m[1]; }
  if (CURL_FORM.has(flag)) { const m = /=@([^;]+)/.exec(value); if (m) return m[1]; }
  return undefined;
}
// Names an uploader's operand, or `git add`'s, is checked against: a secret path sent
// or staged (`gh gist create .env`, `git add .env`) is a read of that path.
const SENSITIVE = /(?:^|[/\\])(?:\.scopebond(?:[/\\]|$)|\.env(?:\.[^/\\]*)?$|\.envrc$|\.ssh(?:[/\\]|$)|\.aws(?:[/\\]|$)|\.npmrc$|\.pypirc$|_?\.?netrc$|\.git-credentials$|\.kube(?:[/\\]|$)|\.docker(?:[/\\]|$)|\.azure(?:[/\\]|$)|\.gnupg(?:[/\\]|$)|\.config[/\\](?:gcloud|gh)(?:[/\\]|$)|\.credentials\.json$)|\.(?:key|pem|p12|pfx|jks|keystore)$/i;

const INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3", "py", "ruby", "perl", "php", "osascript", "lua", "tclsh"]);
// Path literals inside inline code. Each alternative starts at a boundary (not after
// a word character — so `process.env` is not `.env`) and has no overlapping repeats,
// keeping the scan linear; input is capped per argument.
const SENSITIVE_IN_CODE = /(?<![\w$])(?:\.scopebond[\\/][\w.-]*|\.env(?:\.[\w-]+)?(?![\w.-])|\.envrc|\.ssh[\\/][\w.-]+|\.aws[\\/]credentials|\.claude[\\/]settings[\w.-]*|\.cursor[\\/]hooks\.json|\.codex[\\/](?:hooks\.json|config\.toml)|\.git[\\/](?:hooks[\\/][\w.-]*|config)|\.github[\\/](?:workflows|actions)[\\/][\w./-]*|\.npmrc|\.git-credentials)|(?<![\w.-])[\w-]+\.(?:key|pem|p12|pfx)(?![\w])/gi;
// A file or process API in the same inline snippet, required in call or member form
// (not a bare English word — "your .env file" must not read like `File`). Without one,
// a protected path in a string literal opens nothing. Covers Node (fs/child_process/
// streams), Python (open, os, subprocess, pathlib, shutil), Ruby/PHP (File/IO/fopen/
// file_get_contents) and PowerShell (Get-/Set-Content, Out-File, Invoke-*).
const FILE_API = /\b(?:open|fopen|readlink|read_file|readfile|read_to_string|readfilesync|writefile|writefilesync|appendfile|appendfilesync|createreadstream|createwritestream|openfile|opensync|copyfile|copyfilesync|rename|renamesync|unlink|unlinksync|popen|spawn|spawnsync|exec|execsync|execfile|execfilesync|system|shell_exec|proc_open|file_get_contents|file_put_contents|urlopen)\s*\(|\b(?:fs|io|os|subprocess|child_process|pathlib|shutil|File|Dir|IO|Pathname|Path|FileUtils)\s*\.\s*\w|\bimport\s+(?:os|subprocess|shutil|pathlib|io)\b|\brequire\s*\(\s*['"`](?:node:)?(?:fs|child_process)|\b(?:Get-Content|Set-Content|Out-File|Add-Content|Import-Csv|Invoke-\w+)\b/i;
const CODE_SCAN_LIMIT = 20000;

/** Option arities of the content readers, so an option's value (`grep -C 3`, `rg -g
 *  '!*.key'`, `head -n 1`) is never taken for a file operand. `short`: letters that
 *  take a value; `optional`: letters whose value can only be attached; `long`: long
 *  options that take the next word; `read`/`write`: options whose value is a file. */
interface OptionSpec { short?: string; optional?: string; long?: string[]; read?: string[]; write?: string[] }
const GREP: OptionSpec = { short: "efmABCdD", long: ["--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude", "--exclude-dir", "--exclude-from", "--directories", "--devices", "--label", "--binary-files", "--group-separator"], read: ["-f", "--file", "--exclude-from"] };
const AWK: OptionSpec = { short: "fvF", long: ["--file", "--assign", "--field-separator", "--include", "--load"], read: ["-f", "--file"] };
const VIM: OptionSpec = { short: "cSuiTwWtq", long: ["--cmd"], read: ["-S", "-u"], write: ["-w", "-W"] };
const OPTIONS = new Map<string, OptionSpec>([
  ["grep", GREP], ["egrep", GREP], ["fgrep", GREP],
  ["rg", { short: "efgtTmABCjMErd", long: ["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--type-clear", "--max-count", "--after-context", "--before-context", "--context", "--threads", "--max-columns", "--encoding", "--replace", "--max-depth", "--max-filesize", "--pre", "--pre-glob", "--ignore-file", "--sort", "--sortr", "--colors", "--path-separator", "--context-separator", "--engine"], read: ["-f", "--file", "--ignore-file"] }],
  ["ag", { short: "ABCGgmp", long: ["--ignore", "--ignore-dir", "--file-search-regex", "--depth", "--pager", "--after", "--before", "--context", "--max-count", "--path-to-ignore"], read: ["-p", "--path-to-ignore"] }],
  ["ack", { short: "ABCm", long: ["--type", "--ignore-dir", "--ignore-file", "--match", "--max-count", "--output", "--after-context", "--before-context", "--context"] }],
  ["awk", AWK], ["gawk", AWK], ["mawk", AWK], ["nawk", AWK],
  ["jq", { short: "fL", long: ["--from-file", "--indent"], read: ["-f", "--from-file"] }],
  ["yq", { short: "Iop", long: ["--indent", "--output-format", "--input-format", "--expression", "--front-matter"] }],
  ["head", { short: "nc", long: ["--lines", "--bytes"] }],
  ["tail", { short: "nc", long: ["--lines", "--bytes", "--pid", "--sleep-interval", "--max-unchanged-stats"] }],
  ["sort", { short: "ktoST", long: ["--key", "--field-separator", "--output", "--buffer-size", "--temporary-directory", "--files0-from", "--batch-size", "--parallel"], read: ["--files0-from"] }],
  ["cut", { short: "bcdf", long: ["--bytes", "--characters", "--delimiter", "--fields", "--output-delimiter"] }],
  ["od", { short: "AjNStw" }], ["xxd", { short: "cglos" }], ["hexdump", { short: "efns", read: ["-f"] }],
  ["base64", { short: "w" }], ["base32", { short: "w" }],
  ["diff", { short: "CUFILXx", long: ["--label", "--ignore-matching-lines", "--show-function-line", "--exclude", "--exclude-from", "--from-file", "--to-file", "--horizon-lines"], read: ["-X", "--exclude-from", "--from-file", "--to-file"] }],
  ["nl", { short: "bdfhilnsvw" }],
  ["strings", { short: "nte", long: ["--bytes", "--radix", "--encoding", "--output-separator"] }],
  ["tar", { short: "fCTXbHKLNVg", long: ["--file", "--directory", "--files-from", "--exclude-from", "--exclude", "--transform", "--owner", "--group", "--mode", "--mtime", "--newer", "--after-date", "--label", "--format", "--blocking-factor"], read: ["-T", "-X", "--files-from", "--exclude-from"] }],
  ["unzip", { short: "dxP" }],
  ["sed", { short: "efl", optional: "i", long: ["--expression", "--file", "--line-length"], read: ["-f", "--file"] }],
  ["vi", VIM], ["vim", VIM], ["nvim", VIM], ["view", VIM], ["ex", VIM],
  ["ed", { short: "p" }],
  ["gpg", { short: "orRu", long: ["--output", "--recipient", "--local-user", "--homedir", "--default-key"] }],
]);
// Programs whose first operand is a pattern or program text, not a file — unless the
// pattern came from an option (`grep -e p`, `awk -f prog`, `jq -f filter`).
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "awk", "gawk", "mawk", "nawk", "jq", "yq", "select-string", "sls"]);
const PATTERN_OPTIONS = new Set(["-e", "-f", "--regexp", "--file", "--from-file", "--expression"]);

/** If `t` is an option that takes a value under `spec`, its name and any attached value. */
function valuedOption(spec: OptionSpec | undefined, t: string): { name: string; attached?: string } | undefined {
  if (!spec) return undefined;
  if (t.startsWith("--")) return spec.long?.includes(t) ? { name: t } : undefined;
  for (let k = 1; k < t.length; k++) {
    if (spec.optional?.includes(t[k])) return undefined;
    if (spec.short?.includes(t[k])) return { name: "-" + t[k], attached: t.slice(k + 1) || undefined };
  }
  return undefined;
}

// `git config` keys whose value runs a program, redirects a push or reroutes a remote:
// setting one is a write to the protected git config.
const DANGEROUS_GIT_KEY = /^(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy)|alias\..+|include\.path|includeif\..+|remote\..+\.(?:push|pushurl|url|receivepack|uploadpack)|url\..+\.(?:insteadof|pushinsteadof)|push\.default|remote\.pushdefault|credential\..*helper|filter\..+\.(?:clean|smudge|process)|diff\..+\.(?:textconv|command)|merge\..+\.driver|sequence\.editor|gpg\.(?:.+\.)?program)$/i;

/** The file a `git config …` invocation writes, or undefined when it only reads (or
 *  sets a harmless key). `--file F` writes F for any key; otherwise setting a
 *  dangerous key (or `--edit`) writes the git config (`--global` included, recorded as
 *  `.git/config` so the protected-write guard applies). */
function gitConfigWrite(args: string[]): string | undefined {
  let file: string | undefined;
  let edit = false;
  let mutate = false;
  let query = false;
  const positional: string[] = [];
  const valued = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-f" || a === "--file") { file = args[++i]; continue; }
    if (a.startsWith("--file=")) { file = a.slice(7); continue; }
    if (valued.has(a)) { i++; continue; }
    if (a === "-e" || a === "--edit") { edit = true; continue; }
    if (/^--(?:add|replace-all|unset|unset-all|rename-section|remove-section)$/.test(a)) { mutate = true; continue; }
    if (/^(?:--get|--get-all|--get-regexp|--get-urlmatch|-l|--list|--get-color|--get-colorbool)$/.test(a)) { query = true; continue; }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  const verb = positional[0]?.toLowerCase();
  if (verb === "edit") edit = true;
  else if (verb === "set" || verb === "unset" || verb === "rename-section" || verb === "remove-section") { mutate = true; positional.shift(); }
  else if (verb === "get" || verb === "list") query = true;
  const key = positional[0] ?? "";
  const writes = edit || (!query && (mutate || positional.length >= 2));
  if (!writes) return undefined;
  if (file !== undefined) return file;
  const section = /^(?:alias|core|include|includeif|remote|url|filter|diff|merge|credential|push|gpg|sequence)(?:\.|$)/i;
  return edit || DANGEROUS_GIT_KEY.test(key) || (mutate && positional.some((p) => section.test(p))) ? ".git/config" : undefined;
}

/** Split git subcommand arguments into positionals, honoring `--` and skipping the
 *  values of the given options. */
function gitPositionals(args: string[], valued: string[] = []): { before: string[]; after: string[] | null } {
  const before: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return { before, after: args.slice(i + 1) };
    if (valued.includes(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    before.push(a);
  }
  return { before, after: null };
}

const isPathWord = (t: string): boolean => t !== "" && !/^\d+$/.test(t) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t);
const isSensitiveOperand = (w: string): boolean => SENSITIVE.test(w) || (UNRESOLVED.test(w) && protectedCandidate(normPath(w)) !== undefined);

/** Derive the file.read / file.write intents a simple shell command implies —
 *  operands of reader, copier, writer and editor programs, flag values that name
 *  files, redirection targets, the sensitive operands of uploaders and `git add`, and
 *  the paths git writes (`checkout -- p`, `restore`, `mv`, `rm`, `config`) — resolved
 *  against the directory an earlier `cd` in the same call moved to. These flow through
 *  the same protect-read / protect-write clauses as the native file tools; a false
 *  positive (a non-protected operand) is a harmless extra receipt the starter policy
 *  allows. `unknownTarget` is set when the command writes files its text does not
 *  name (`patch`, `git apply`, `tar x`, `unzip`). */
function fileOpsFromShell(sc: SimpleCommand, dir: string, cwd?: string): { ops: Mapped[]; unknownTarget: boolean } {
  const ops: Mapped[] = [];
  let unknownTarget = false;
  const prog = canonProgram(sc.program);
  const read = (w: string | undefined) => { if (w !== undefined && isPathWord(w)) ops.push(...fileIntent("file.read", w, dir, cwd)); };
  const write = (w: string | undefined) => { if (w !== undefined && isPathWord(w)) ops.push(...fileIntent("file.write", w, dir, cwd)); };
  const args = sc.argv;
  const spec = OPTIONS.get(prog);
  const flagFiles = READERS.has(prog) || EDITORS.has(prog) || COPIERS.has(prog) || UPLOADERS.has(prog);

  // Operands (non-flag words) and flag values (`--flag=value`, `-T value`, `@file`, `if=f`).
  const operands: string[] = [];
  const given = new Set<string>();
  const flagValue = (name: string, value: string) => {
    const lower = name.toLowerCase();
    given.add(name);
    if (spec?.write?.includes(name) || WRITE_FLAGS.has(lower)) write(value);
    else if (spec?.read?.includes(name) || (flagFiles && READ_FLAGS.has(lower))) read(value.replace(/^@/, ""));
    else if (value.startsWith("@")) read(value.slice(1));
  };
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") { operands.push(...args.slice(i + 1)); break; }
    const lower = t.toLowerCase();
    const eq = t.indexOf("=");
    if (prog === "curl" || prog === "wget") {
      const flag = eq > 0 && t.startsWith("--") ? t.slice(0, eq) : t;
      if (CURL_DATA.has(flag) || CURL_FORM.has(flag) || flag === CURL_URLENCODE) {
        let value: string | undefined;
        if (eq > 0 && t.startsWith("--")) value = t.slice(eq + 1);
        else value = args[++i];
        given.add(flag);
        if (value !== undefined) { const f = curlFileRef(flag, value); if (f !== undefined) read(f); }
        continue;
      }
    }
    if (t.startsWith("-") && eq > 0) {                       // --flag=value
      const flag = t.slice(0, eq);
      const value = t.slice(eq + 1);
      given.add(flag);
      if (spec?.write?.includes(flag) || WRITE_FLAGS.has(flag.toLowerCase())) write(value.replace(/^@/, ""));
      else if (spec?.read?.includes(flag) || (flagFiles && READ_FLAGS.has(flag.toLowerCase())) || value.startsWith("@") || (UPLOADERS.has(prog) && SENSITIVE.test(value))) read(value.replace(/^@/, ""));
      continue;
    }
    if (t.startsWith("-") && t.length > 1) {
      // jq's two-valued options: `--arg name value`, `--slurpfile name file`.
      if (prog === "jq" && /^--(?:arg|argjson|slurpfile|rawfile)$/.test(t)) { if (/file$/.test(t)) read(args[i + 2]); i += 2; continue; }
      const opt = valuedOption(spec, t);
      if (opt) {
        let value = opt.attached;
        if (value === undefined && i + 1 < args.length) value = args[++i];
        if (value !== undefined) flagValue(opt.name, value);
        continue;
      }
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        if (COPIERS.has(prog) && t === "-t") { write(value); i++; continue; } // cp -t DIR
        if (WRITERS.has(prog) && /^-(?:path|literalpath|filepath)$/.test(lower)) { write(value); i++; continue; } // Set-Content -Path f
        if (WRITE_FLAGS.has(lower)) { write(value); i++; continue; }
        if (flagFiles && READ_FLAGS.has(lower)) { read(value.replace(/^@/, "")); i++; continue; }
        if (value.startsWith("@")) { read(value.slice(1)); i++; continue; }
      }
      continue;
    }
    if (prog === "dd" && /^(?:if|of)=/.test(t)) { (t.startsWith("of=") ? write : read)(t.slice(3)); continue; }
    if (t.startsWith("@")) { read(t.slice(1)); continue; }
    operands.push(t);
  }
  if (PATTERN_FIRST.has(prog) && ![...given].some((g) => PATTERN_OPTIONS.has(g)) && !(prog === "yq" && operands.length === 1)) operands.shift();

  const git = gitArgs(sc);
  const inPlace = (a: string) => a === "--inplace" || a.startsWith("--in-place") || /^-[a-hj-z]*i/.test(a);
  if (git) {
    const sub = git.sub?.toLowerCase();
    const a = git.args;
    if (sub === "add") {
      // Staging a secret is one commit away from publishing it.
      const { before, after } = gitPositionals(a, ["--pathspec-from-file"]);
      [...before, ...(after ?? [])].filter(isSensitiveOperand).forEach(read);
    } else if (sub === "checkout") {
      const { before, after } = gitPositionals(a, ["-b", "-B", "--orphan", "--conflict", "--pathspec-from-file"]);
      (after ?? before).forEach(write);
    } else if (sub === "restore") {
      const { before, after } = gitPositionals(a, ["-s", "--source", "--pathspec-from-file"]);
      [...before, ...(after ?? [])].forEach(write);
    } else if (sub === "mv") {
      const { before, after } = gitPositionals(a);
      const all = [...before, ...(after ?? [])];
      all.slice(0, -1).forEach(read);
      all.forEach(write);
    } else if (sub === "rm" && !a.includes("--cached")) {
      const { before, after } = gitPositionals(a, ["--pathspec-from-file"]);
      [...before, ...(after ?? [])].forEach(write);
    } else if (sub === "config") write(gitConfigWrite(a));
    else if (sub === "show" || sub === "cat-file") {
      // `git show REV:path` prints that file's content from history.
      for (const w of a) { const m = /^(?:[^-:][^:]*)?:(?:\d:)?(.+)$/.exec(w); if (m && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) read(m[1]); }
    } else if (sub === "apply" || sub === "am") unknownTarget = true;
  } else if (prog === "find") {
    // `find DIR … -exec cat {} +` reads DIR's files; `-fprint F` writes F.
    const starts: string[] = [];
    for (const w of args) { if (/^[-(!]/.test(w) || w === "\\(") break; starts.push(w); }
    if (args.some((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w))) starts.forEach(read);
    args.forEach((w, k) => { if (/^-(?:fprint0?|fprintf|fls)$/.test(w)) write(args[k + 1]); });
  } else if ((prog === "docker" || prog === "podman" || prog === "kubectl") && operands[0] === "cp") {
    const local = (p: string | undefined) => p !== undefined && (!/^[^/\\]+:/.test(p) || /^[A-Za-z]:[\\/]/.test(p));
    if (local(operands[1])) read(operands[1]);
    if (local(operands[2])) write(operands[2]);
  } else if (prog === "patch") {
    // The file a patch changes is named inside the patch; an explicit operand is written.
    unknownTarget = true;
    write(operands[0]);
  } else if ((prog === "tar" || prog === "bsdtar") && (args.some((w) => w === "--extract" || w === "--get" || /^-[A-Za-z]*x/.test(w)) || /^[A-Za-z]*x[A-Za-z]*$/.test(args[0] ?? ""))) {
    unknownTarget = true;
    args.forEach((w, k) => { if (w === "-C" || w === "--directory") write(args[k + 1]); else if (w.startsWith("--directory=")) write(w.slice(12)); });
    operands.forEach(read);
  } else if (prog === "unzip" && !args.some((w) => /^-[ltvZpcz]$/.test(w))) {
    unknownTarget = true;
    args.forEach((w, k) => { if (w === "-d") write(args[k + 1]); });
    read(operands[0]);
  } else if (/^7z[arz]?$/.test(prog) && /^[xe]$/.test(operands[0] ?? "")) {
    unknownTarget = true;
    args.forEach((w) => { if (/^-o./.test(w)) write(w.slice(2)); });
    read(operands[1]);
  } else if (prog === "cpio" && args.some((w) => w === "--extract" || /^-[A-Za-z]*i/.test(w))) {
    unknownTarget = true;
  } else if (prog === "gpg" && args.some((w) => /^--export-secret-(?:sub)?keys$/.test(w))) {
    read(".gnupg/private-keys-v1.d");
  } else if (READERS.has(prog)) {
    operands.forEach(read);
    if (prog === "yq" && args.some(inPlace)) operands.forEach(write);
    // `sed -i 's/x/y/' f…` rewrites its operands in place; the first operand is the
    // script unless `-e`/`-f` supplied one.
    if (prog === "sed" && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) {
      const scriptGiven = args.some((a) => a === "-e" || a === "-f" || a.startsWith("--expression")) || given.has("-e") || given.has("-f");
      (scriptGiven ? operands : operands.slice(1)).forEach(write);
    }
  } else if (EDITORS.has(prog)) {
    operands.forEach(read);
    operands.forEach(write);
  } else if (COPIERS.has(prog) && operands.length) {
    const hasTarget = args.some((a) => /^(?:-t|--target-directory(?:=.*)?|-destination)$/i.test(a) || /^--target-directory=/.test(a));
    const sources = hasTarget ? operands : operands.slice(0, -1);
    sources.forEach(read);
    if (MOVERS.has(prog)) sources.forEach(write);
    if (!hasTarget) write(operands[operands.length - 1]);
  } else if (WRITERS.has(prog)) {
    // A permission/owner spec is not a path: `chmod +x f`, `chmod 0755 f`,
    // `chattr +i f`, `chown root:wheel f`, `attrib +r f` write f, not "+x".
    let targets = operands;
    if (prog === "chmod" || prog === "chattr" || prog === "attrib") targets = targets.filter((o) => !/^[+\-=][rwxstugoa+-]*$|^[ugoa]+[+\-=][rwxXst]*$|^[0-7]{3,4}$/i.test(o));
    else if (prog === "chown" || prog === "chgrp") targets = targets.slice(1);
    targets.forEach(write);
  }
  else if ((prog === "perl" || prog === "ruby") && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) {
    // `perl -i -pe 's/x/y/' f…`: the first operand is the script (unless -e/-f gave it).
    const scriptGiven = args.some((a) => a === "-e" || a === "-f" || a.startsWith("--expression")) || given.has("-e") || given.has("-f");
    (scriptGiven ? operands : operands.slice(1)).forEach(write);
  } else if (INTERPRETERS.has(prog)) {
    // Inline code (`node -e "…"`, `python -c "…"`): best effort — a protected-looking
    // path literal is recorded as a read and a write only when the same code also calls
    // a file or process API, so a path merely named in a log string is not a finding.
    // Code that assembles a path at run time is beyond a cooperative hook (use a gateway).
    for (const w of args) {
      const code = w.slice(0, CODE_SCAN_LIMIT);
      if (!FILE_API.test(code)) continue;
      for (const m of code.match(SENSITIVE_IN_CODE) ?? []) { read(m); write(m); }
    }
  } else if (UPLOADERS.has(prog)) {
    operands.filter(isSensitiveOperand).forEach(read);
  }

  for (const r of sc.redirects) {
    if (r.op.startsWith(">")) write(r.target);
    else if (r.op === "<>") { read(r.target); write(r.target); }
    else read(r.target);
  }
  return { ops, unknownTarget };
}

// The hook's own CLI run by the agent to switch itself off or re-scope itself
// (`npx @scopebond/hook uninstall`, `scopebond trust`, `scopebond-hook init --force`).
const SELF_SUBCOMMANDS = new Set(["uninstall", "trust", "init", "install", "connect"]);
const isHookCli = (w: string): boolean =>
  /^scopebond(?:-hook)?(?:\.js)?$/.test(canonProgram(w)) || /^@scopebond\/hook(?:@[^/\s]*)?$/i.test(w) || /@scopebond[\\/]hook[\\/]dist[\\/]cli\.js$/i.test(w);
function selfDisable(sc: SimpleCommand): boolean {
  const all = [sc.programRaw, ...sc.argv];
  for (let k = 0; k < all.length; k++) {
    if (!isHookCli(all[k])) continue;
    const sub = all.slice(k + 1).find((a) => !a.startsWith("-"));
    if (sub && SELF_SUBCOMMANDS.has(sub.toLowerCase())) return true;
  }
  return false;
}

/** Map one parsed simple command to the intents it implies: the git.push or
 *  shell.exec itself, plus any file reads/writes it performs. An opaque command
 *  (unparseable, or a program known only at run time) becomes a shell.exec with an
 *  empty program, evaluated, which the starter policy denies. */
function mapSimpleCommand(sc: SimpleCommand, dir: string, cwd?: string): Mapped[] {
  if (sc.opaque) {
    return [{
      intent: { action_type: "shell.exec", params: { command: redactCommand(sc.raw), program: "", ...(cwd ? { cwd } : {}) } },
      evaluated: true, source: "shell",
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
  const { ops: files, unknownTarget } = fileOpsFromShell(sc, dir, cwd);
  // The hook disabling itself is a write to its own policy, which the starter protects.
  if (selfDisable(sc)) files.push(...pathIntents("file.write", ".scopebond/policy.json", "shell"));
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
  // A command that writes files its text does not name (`patch`, `git apply`, `tar x`)
  // cannot be judged here: its writes are recorded as a file.write with no path, not
  // evaluated — observed in normal mode, denied by strict mode (like an apply_patch
  // with no recognizable path).
  if (unknownTarget) files.push({ intent: { action_type: "file.write", params: { path: "" } }, evaluated: false, source: "shell" });
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
  return paths.flatMap((path) => pathIntents("file.write", path, "apply_patch"));
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
    return pathIntents("file.write", rel(ti.file_path, cwd), name);
  if (name === "NotebookEdit")
    return pathIntents("file.write", rel(ti.notebook_path ?? ti.file_path, cwd), name);
  if (name === "Read")
    return pathIntents("file.read", rel(ti.file_path, cwd), name);
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
      return pathIntents("file.read", rel(p.path ?? p.file_path, cwd), event);
    case "afterFileEdit":
      return pathIntents("file.write", rel(p.path ?? p.file_path, cwd), event);
    case "beforeMCPExecution": {
      const server = String(p.server ?? p.server_name ?? "");
      const tool = String(p.tool ?? p.tool_name ?? "");
      return one({ action_type: "mcp.tool.call", params: { server, tool, args_digest: digest(p.args ?? p.arguments ?? {}) } }, true, event);
    }
    default:
      return one({ action_type: `tool.${event.toLowerCase()}`, params: {} }, false, event);
  }
}
