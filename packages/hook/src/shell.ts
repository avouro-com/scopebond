// Shell decomposition for the hook mapper. A single Bash tool call can carry many
// commands — `a && b`, `a; b`, `a | b`, `$(c)`, `` `c` ``, `bash -c '…'`, `( c )` —
// so mapping only the first token lets a denied program ride in behind an allowed
// one. This module splits a command line into the simple commands it will actually
// run, so the mapper can emit an intent for each and the runtime can deny if any
// one of them is out of policy.
//
// It is best-effort and fail-safe: anything it cannot parse with confidence is
// returned as a single `opaque` command (as is a command whose program is only known
// at run time), which the mapper records with an empty program so the starter policy
// denies it rather than trusting it. Every scan is linear in the input
// length with no backtracking, so a hostile command cannot stall the hot path.

export interface Redirect {
  /** The operator without its file descriptor: `>`, `>>`, `>|`, `<`, `<>`. */
  op: string;
  target: string;
}

export interface SimpleCommand {
  /** The invoked program's basename, after stripping sudo/env/assignment prefixes.
   *  Empty when it cannot be determined. */
  program: string;
  /** The first token whole (pre-basename), so a caller can scrub it before splitting
   *  on "/": a bare-secret command must not leak a path-fragment as the program. */
  programRaw: string;
  /** Remaining argv (quotes and redirections removed), best-effort. */
  argv: string[];
  /** File redirections (`> f`, `>>f`, `x>f`, `< f`, `&> f`), in order. */
  redirects: Redirect[];
  /** The raw simple-command text, for the redacted command digest. */
  raw: string;
  /** True when parsing was not confident; the caller must fail closed. */
  opaque: boolean;
  /** The `NAME=value` words in force for this command, quotes removed: its own prefix (`X=1 cmd`, `env X=1 cmd`) after
   *  those of the commands it is nested in (`X=1 sh -c 'cmd'`). */
  assigns?: string[];
  /** A segment of assignments alone (`X=1; …`): it runs nothing and sets shell variables for the commands after it. */
  assignOnly?: boolean;
  /** Read as POSIX, the command only prints its help or version, or rehearses (`rm --help`, `sudo --version`, `rm -h`):
   *  it changes nothing (see `describesItself`). */
  describes?: true;
}

/** The options by which a command line only describes itself or rehearses, in any program: `--help`, `--version`, and
 *  `--dry-run` (also `--dry-run=<mode>`, but not `=none` or `=false`, which turn it off). */
export function isDescribeOption(word: string): boolean {
  if (word === "--help" || word === "--version" || word === "--dry-run") return true;
  return word.startsWith("--dry-run=") && !/^(?:none|false)$/i.test(word.slice("--dry-run=".length));
}

/** Programs whose `-h` is not help: it halts the computer (`shutdown -h`, and the `-h` of halt, poweroff and reboot). */
const HALTS = new Set(["shutdown", "halt", "poweroff", "reboot"]);

/** Whether a POSIX program given `argv` only prints its help or version, or rehearses: a describe option among the options
 *  it reads before its first operand (option reading stops there, and at `--`: after it `--help` is a file to act on), or
 *  `-h` as its only argument (elsewhere `-h` often means something else, such as a host or a halt). */
export function describesItself(program: string, argv: readonly string[]): boolean {
  if (argv.length === 1 && argv[0] === "-h") return !HALTS.has(canonProgram(program));
  for (const a of argv) {
    if (a === "--" || a === "-" || !a.startsWith("-")) return false;
    if (isDescribeOption(a)) return true;
  }
  return false;
}

/** The canonical program name used for every decision: basename, lower-cased, with
 *  a Windows executable suffix removed. `RM.EXE`, `/bin/rm` and `rm` are one program
 *  — Windows and macOS resolve them case-insensitively, so matching the literal
 *  spelling would let a case or suffix variant through. */
export const canonProgram = (t: string): string =>
  t.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, "");

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const MAX_DEPTH = 6;

/** The two command languages a command line is read in: a POSIX shell, or PowerShell (script blocks, statements, the call
 *  operator, the backtick escape). */
export type ShellDialect = "posix" | "powershell";

/** The end of the PowerShell script block or braced variable that opens at `start` (a `{`): the index of its closing `}`, or
 *  -1 when it never closes. Quotes and nested blocks are honored; the backtick escapes the next character. */
function braceEnd(src: string, start: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "`") { i++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Split a command line into top-level simple-command strings at unquoted
 *  separators (`;`, newline, `&&`, `||`, `|`, `&`), leaving quotes, `$( )`,
 *  backticks and `( )` groups intact inside each piece. Read as PowerShell, a script
 *  block or hashtable (`{ … }`, `@{ … }`) and a braced variable (`${env:X}`) stay
 *  whole too, the backtick escapes the next character, and an `&` that starts a
 *  statement is the call operator (`& $tool`), not a separator. */
function splitTopLevel(src: string, ps = false): { segments: string[]; seps: string[]; unbalanced: boolean } {
  const segments: string[] = [];
  // The separator after each segment (`;`, a line end, `&&`, `||`, `|`, `&`, or "" after the last).
  const seps: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let paren = 0; // depth of $( ) and ( )
  let backtick = false;
  let unclosedBrace = false;
  const flush = (sep = "") => { const t = cur.trim(); if (t) { segments.push(t); seps.push(sep); } cur = ""; };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (ps && c === "`") { cur += c + (n ?? ""); i++; continue; }
    if (quote) {
      cur += c;
      if (quote === "'") { if (c === "'") quote = null; }
      else if (!ps && c === "\\" && n !== undefined) cur += src[++i];
      else if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (ps && c === "{") {
      const end = braceEnd(src, i);
      if (end < 0) { unclosedBrace = true; cur += src.slice(i); break; }
      cur += src.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ps && c === "<" && n === "#") { const end = src.indexOf("#>", i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (!ps && c === "`") { backtick = !backtick; cur += c; continue; }
    if (backtick) { cur += c; continue; }
    if (!ps && c === "\\" && n !== undefined) { cur += c + src[++i]; continue; }
    if (c === "$" && n === "(") { paren++; cur += "$("; i++; continue; }
    if (c === "(") { paren++; cur += c; continue; }
    if (c === ")") { if (paren > 0) paren--; cur += c; continue; }
    if (paren > 0) { cur += c; continue; }
    // PowerShell's call operator starts a statement (`& $tool`, `$x = & $tool`); elsewhere `&` still ends one.
    if (ps && c === "&" && n !== "&" && (cur.trim() === "" || /=\s*$/.test(cur))) { cur += c; continue; }
    const prev = src[i - 1];
    // An unquoted `#` at the start of a word begins a comment that runs to the end of
    // the line (`rm -rf x # don't` must not read as an unbalanced quote).
    if (c === "#" && (prev === undefined || /[\s;&|()]/.test(prev))) {
      while (i + 1 < src.length && src[i + 1] !== "\n") i++;
      continue;
    }
    // `&>file`, `2>&1`, `<&3` and `>|file` are redirections, not separators.
    if (c === "&" && (n === ">" || prev === ">" || prev === "<")) { cur += c; continue; }
    if (c === "|" && prev === ">") { cur += c; continue; }
    if (c === ";" || c === "\n") { flush(c); continue; }
    if (c === "&" && n === "&") { flush("&&"); i++; continue; }
    if (c === "|" && n === "|") { flush("||"); i++; continue; }
    if (c === "&" || c === "|") { flush(c); continue; }
    cur += c;
  }
  flush();
  return { segments, seps, unbalanced: quote !== null || paren !== 0 || backtick || unclosedBrace };
}

/** A command line split at its top-level separators, with the separator after each part (`|` for a pipe), here-documents
 *  removed. Null when its quoting or grouping does not balance. For readers that need to know what feeds what. */
export function splitCommandLine(command: string): Array<{ text: string; sep: string }> | null {
  const { text } = stripHeredocs(command.trim());
  const { segments, seps, unbalanced } = splitTopLevel(text);
  return unbalanced ? null : segments.map((t, i) => ({ text: t, sep: seps[i] ?? "" }));
}

/** What a command substitution leaves behind in the outer command: a parameter
 *  expansion, so the word it sat in is treated as unresolved (its value is only known
 *  at run time) — as a program name it is dynamic, as a path it is glob-tested. */
const SUBST = "${__sb_subst}";

/** Pull the contents of command substitutions and subshell groups out of one
 *  segment — `$( … )` and `` ` … ` `` (also inside double quotes, where the shell
 *  still runs them) and `( … )` groups — for recursion. A substitution is replaced
 *  by a placeholder expansion; a group is blanked, except an empty `()` (a function
 *  definition), which is kept. Read as PowerShell, a script block (`{ … }`) is
 *  pulled out too and blanked, a `( … )` group that opens a word is a value only
 *  known at run time (the placeholder), a braced variable (`${env:X}`) stays as written and the backtick
 *  escapes rather than substitutes. */
function extractSubstitutions(seg: string, ps = false): { outer: string; inner: string[] } {
  const inner: string[] = [];
  let outer = "";
  let quote: '"' | "'" | null = null;
  const group = (start: number): number => {
    let depth = 1;
    let j = start;
    for (; j < seg.length && depth > 0; j++) {
      if (seg[j] === "(") depth++;
      else if (seg[j] === ")") depth--;
    }
    inner.push(seg.slice(start, depth === 0 ? j - 1 : j));
    return j - 1;
  };
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    const n = seg[i + 1];
    if (ps && c === "`") { outer += c + (n ?? ""); i++; continue; }
    if (quote === "'") { outer += c; if (c === "'") quote = null; continue; }
    if (ps && quote === null && c === "{") {
      const end = braceEnd(seg, i);
      const close = end < 0 ? seg.length : end;
      // `${env:X}` is a variable, kept as written; any other `{ … }` is a script block (or a hashtable's body), read on its own.
      if (seg[i - 1] === "$") outer += seg.slice(i, close + 1);
      else { inner.push(seg.slice(i + 1, close)); outer += " "; }
      i = close;
      continue;
    }
    // A group that opens a word is a value (`& (Get-Command x)`, `if ($ok)`); one right after a name holds a method's
    // arguments (`[IO.File]::ReadAllText(…)`, `$s.Trim(…)`) and is blanked, as in a POSIX reading.
    if (ps && quote === null && c === "(" && n !== ")" && !/[\w\].:)}'"]/.test(seg[i - 1] ?? "")) { i = group(i + 1); outer += SUBST; continue; }
    if (!ps && c === "`") {
      const end = seg.indexOf("`", i + 1);
      if (end === -1) { outer += c; continue; }
      inner.push(seg.slice(i + 1, end));
      outer += SUBST;
      i = end;
      continue;
    }
    if (c === "$" && n === "(") { i = group(i + 2); outer += SUBST; continue; }
    if (quote === '"') {
      outer += c;
      if (!ps && c === "\\" && n !== undefined) outer += seg[++i];
      else if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; outer += c; continue; }
    if (!ps && c === "\\" && n !== undefined) { outer += c + seg[++i]; continue; }
    if (c === "(" && n === ")") { outer += "()"; i++; continue; }
    if (c === "(") { i = group(i + 1); continue; }
    outer += c;
  }
  return { outer, inner };
}

interface Token { t: string; op: boolean }

/** Tokenize a simple command into words, honoring single and double quotes.
 *  Unquoted redirection operators (`>`, `>>`, `2>`, `&>`, `>|`, `<`, `<<`, `>&`)
 *  become their own operator tokens even when written without spaces (`x>file`),
 *  so a redirection target can never hide inside a word. */
function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  const push = () => { if (has) { out.push({ t: cur, op: false }); cur = ""; has = false; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; has = true; continue; }
    if (quote === '"') {
      // As in bash: inside double quotes a backslash escapes only $ ` " \ and newline;
      // before anything else it is a literal character (so "a\b" keeps its backslash).
      if (c === '"') quote = null;
      else if (c === "\\" && n !== undefined && /[$`"\\\n]/.test(n)) cur += s[++i];
      else cur += c;
      has = true; continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "\\" && n !== undefined) { cur += s[++i]; has = true; continue; }
    if (/\s/.test(c)) { push(); continue; }
    if (c === ">" || c === "<" || (c === "&" && n === ">")) {
      // A pure file-descriptor number (or `&`) directly before the operator is part of it.
      let op = "";
      if (has && /^\d+$/.test(cur)) { cur = ""; has = false; } else push();
      if (c === "&") { op = "&"; i++; }
      op += s[i];
      const next = s[i + 1];
      if (next === s[i] && next !== undefined) { op += next; i++; if (op.endsWith("<<") && s[i + 1] === "<") { op += "<"; i++; } }
      else if (next === "|" || next === "&" || (s[i] === "<" && next === ">")) { op += next; i++; }
      out.push({ t: op, op: true });
      continue;
    }
    cur += c; has = true;
  }
  push();
  return out;
}

/** Separate redirections from the command's words. `>`/`>>`/`>|`/`&>` targets are
 *  writes, `<` a read, `<>` both; here-doc/here-string operands and fd duplications
 *  (`2>&1`) are dropped. */
function splitRedirects(tokens: Token[]): { words: string[]; redirects: Redirect[] } {
  const words: string[] = [];
  const redirects: Redirect[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.op) { words.push(tok.t); continue; }
    const target = tokens[i + 1] && !tokens[i + 1].op ? tokens[i + 1].t : undefined;
    if (target !== undefined) i++;
    const op = tok.t.replace(/^&/, "");
    if (op.startsWith("<<") || target === undefined) continue;             // here-doc delimiter / here-string text
    if ((op === ">&" || op === "<&") && /^(?:\d+|-)$/.test(target)) continue; // 2>&1, <&-
    redirects.push({ op: op === ">&" ? ">" : op === "<&" ? "<" : op, target });
  }
  return { words, redirects };
}

const basename = (t: string): string => t.replace(/^.*[\\/]/, "");
const isAssignment = (t: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);

/** How a wrapper's own options are spelled, so its option VALUES are never mistaken
 *  for the command it runs (`time -p rm` has no value; `sudo -iu root rm` does).
 *  `short`: letters that take a value (attached `-uroot` or the next word); `optional`:
 *  letters whose value can only be attached (`xargs -i{}`); `long`: long options that
 *  take the next word; `lead`: a leading operand consumed before the command
 *  (`timeout 5`); `write`/`read`: options whose value is a file written or read. */
interface WrapperSpec { short?: string; optional?: string; long?: string[]; lead?: RegExp; write?: string[]; read?: string[] }
const DURATION = /^[\d.]+[smhd]?$/i;
const WRAPPERS = new Map<string, WrapperSpec>([
  ["sudo", { short: "ugCDhpRrTtU", long: ["--user", "--group", "--close-from", "--chdir", "--prompt", "--chroot", "--role", "--type", "--command-timeout", "--other-user", "--host"] }],
  ["doas", { short: "uCa" }],
  ["pkexec", { long: ["--user"] }],
  ["env", { short: "uCSPa", long: ["--unset", "--chdir", "--split-string", "--argv0"] }],
  ["command", {}],
  ["builtin", {}],
  ["nohup", {}],
  ["nice", { short: "n", long: ["--adjustment"] }],
  ["time", { short: "fo", long: ["--format", "--output"], write: ["-o", "--output"] }],
  ["exec", { short: "a" }],
  ["stdbuf", { short: "ioe", long: ["--input", "--output", "--error"] }],
  ["setsid", {}],
  ["xargs", { short: "ILnPsdEa", optional: "iel", long: ["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"], read: ["-a", "--arg-file"] }],
  ["busybox", {}],
  ["timeout", { short: "sk", long: ["--signal", "--kill-after"], lead: DURATION }],
  ["gtimeout", { short: "sk", long: ["--signal", "--kill-after"], lead: DURATION }],
  ["ionice", { short: "cnp", long: ["--class", "--classdata", "--pid"] }],
  ["chrt", { short: "TPD", long: ["--sched-runtime", "--sched-period", "--sched-deadline"], lead: /^\d+$/ }],
  ["taskset", { lead: /^(?:0x[0-9a-f]+|[\d,-]+)$/i }],
  ["caffeinate", { short: "wt" }],
  ["strace", { short: "abeEIoOpPsSuX", long: ["--output", "--trace", "--signal", "--status", "--attach", "--string-limit", "--user", "--env"], write: ["-o", "--output"] }],
  ["ltrace", { short: "aADeFlnopsuxw", long: ["--output", "--library"], write: ["-o", "--output"] }],
  ["chroot", { long: ["--userspec", "--groups"], lead: /^[^-]/ }],
  ["unbuffer", {}],
  ["catchsegv", {}],
  ["torsocks", { short: "uapP" }],
  ["proxychains", { short: "f" }],
  ["proxychains4", { short: "f" }],
]);

// Shell reserved words and grouping in command position. They run nothing themselves;
// the command after them is the real one (`if rm …`, `then rm …`, `{ rm …`, `! rm …`).
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}", "!", "coproc", "esac"]);

interface Wrapper { name: string; raw: string; redirects: Redirect[]; describes?: true }

/** Words of a string as the shell would split it (quotes honored, operators dropped). */
const words = (s: string): string[] => tokenize(s).filter((t) => !t.op).map((t) => t.t);

/** Strip the leading shell keywords, `NAME=value` assignments and wrappers (`sudo`,
 *  `env`, `time`, `xargs`, `timeout`, `strace` …, each with its own option arity) so
 *  the program is the real one about to run. `env -S "…"` splits its string into the
 *  command. Returns the remaining words and the wrappers passed on the way. */
function stripPrefixes(input: string[]): { tokens: string[]; wrappers: Wrapper[]; assigns: string[] } {
  let tokens = input;
  const wrappers: Wrapper[] = [];
  const assigns: string[] = [];
  let i = 0;
  for (let guard = 0; i < tokens.length && guard < 1000; guard++) {
    const t = tokens[i];
    if (isAssignment(t)) { assigns.push(t); i++; continue; }
    if (KEYWORDS.has(t)) { i++; continue; }
    // `for x in …` / `select x in …`: the header runs nothing (its substitutions were
    // already extracted); the body follows `do`. It sets x to each word in turn, so it
    // reads as an assignment of each of them.
    if (t === "for" || t === "select") {
      const name = tokens[i + 1];
      const each = name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && tokens[i + 2] === "in" ? tokens.slice(i + 3).map((v) => `${name}=${v}`) : [];
      return { tokens: [], wrappers, assigns: [...assigns, ...each] };
    }
    // `case WORD in PATTERN) cmd`: skip to the command after the pattern.
    if (t === "case") {
      const at = tokens.indexOf("in", i + 1);
      if (at < 0) return { tokens: [], wrappers, assigns };
      i = at + 1;
      continue;
    }
    // A case pattern opening a segment (`b) cmd`), or a function definition
    // (`f() { cmd`, `function f { cmd`).
    if (/^[^()]*\)$/.test(t) && !t.startsWith("$")) { i++; continue; }
    if (t.length > 2 && t.endsWith("()")) { i++; if (tokens[i] === "{") i++; continue; }
    if (t === "function" && i + 1 < tokens.length) { i += 2; if (tokens[i] === "()") i++; if (tokens[i] === "{") i++; continue; }
    const w = canonProgram(t);
    const spec = WRAPPERS.get(w);
    if (!spec) break;
    // `command -v rm` / `command -V rm` only describes rm; it runs nothing.
    if (w === "command") {
      let query = false;
      for (let j = i + 1; j < tokens.length && tokens[j].startsWith("-"); j++) if (/^-[A-Za-z]*[vV]/.test(tokens[j])) query = true;
      if (query) break;
    }
    const redirects: Redirect[] = [];
    const wrapper: Wrapper = { name: w, raw: t, redirects };
    wrappers.push(wrapper);
    i++;
    let split: string | undefined;
    const value = (name: string, attached: string | undefined): void => {
      let v = attached;
      if (v === undefined && i < tokens.length) v = tokens[i++];
      if (v === undefined) return;
      if (spec.write?.includes(name)) redirects.push({ op: ">", target: v });
      if (spec.read?.includes(name)) redirects.push({ op: "<", target: v });
      if (w === "env" && (name === "-S" || name === "--split-string")) split = v;
    };
    while (i < tokens.length) {
      const o = tokens[i];
      if (o === "--") { i++; break; }
      if (!o.startsWith("-") || o === "-") break;
      i++;
      // `sudo --help`, `time --version`, `sudo -h` alone: the wrapper only describes itself.
      if (isDescribeOption(o) || (o === "-h" && i === tokens.length)) wrapper.describes = true;
      if (o.startsWith("--")) {
        const eq = o.indexOf("=");
        if (eq > 0) value(o.slice(0, eq), o.slice(eq + 1));
        else if (spec.long?.includes(o)) value(o, undefined);
        continue;
      }
      for (let k = 1; k < o.length; k++) {
        if (spec.optional?.includes(o[k])) break;
        if (spec.short?.includes(o[k])) { value("-" + o[k], o.slice(k + 1) || undefined); break; }
      }
    }
    if (split !== undefined) { tokens = [...words(split), ...tokens.slice(i)]; i = 0; continue; }
    if (spec.lead && i < tokens.length && spec.lead.test(tokens[i])) i++;
  }
  return { tokens: tokens.slice(i), wrappers, assigns };
}

/** A program word whose name is only known at run time: a variable (`$r`), an
 *  ANSI-C string (`$'\x72m'`) or a command substitution in its last path segment. */
const isDynamicProgram = (word: string): boolean => /[$`]/.test(word.replace(/^.*\//, ""));

/** The script run by `su -c …`, `script -qc …`, `runuser … -c`, `flock -c …`: the
 *  value of `-c`/`--command` (also as the last letter of a short-option cluster). */
function commandOption(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--command=") || a.startsWith("--session-command=")) return a.slice(a.indexOf("=") + 1);
    if (a === "-c" || a === "--command" || a === "--session-command" || /^-[A-Za-z]+c$/.test(a)) return argv[i + 1] ?? null;  }
  return null;
}

/** The command words `parallel` runs: everything before the first `:::`/`::::`
 *  argument separator, after its own options. */
function parallelCommand(argv: string[]): string | null {
  const valued = new Set(["-j", "-P", "-S", "-a", "-d", "-I", "-E", "-C", "-N", "-n", "-L", "--jobs", "--sshlogin", "--sshloginfile", "--arg-file", "--delimiter", "--colsep", "--results", "--tmpdir", "--workdir", "--wd", "--joblog", "--halt", "--delay", "--timeout", "--retries", "--max-args", "--max-lines", "--env", "--basefile", "--return", "--transferfile"]);
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-") && !argv[i].startsWith(":::")) { i += valued.has(argv[i]) ? 2 : 1; }
  const cmd: string[] = [];
  for (; i < argv.length && !/^::::?\+?$/.test(argv[i]); i++) cmd.push(argv[i]);
  return cmd.length ? cmd.join(" ") : null;
}

/** The command `watch` re-runs: its operands joined (watch passes them to `sh -c`). */
function watchCommand(argv: string[]): string | null {
  let i = 0;
  while (i < argv.length && argv[i].startsWith("-")) {
    const o = argv[i++];
    if (o === "--") break;
    if (o === "-n" || o === "-q" || o === "--interval" || o === "--equexit") i++;
  }
  return i < argv.length ? argv.slice(i).join(" ") : null;
}

/** Find the script argument of a shell invoked with `-c`, including combined short
 *  flags where `c` is last (`-lc`, `-xec`). The script is the next non-option word. */
export function shellScriptArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-c" || /^-[A-Za-z]*c$/.test(argv[i])) {
      for (let j = i + 1; j < argv.length; j++) if (!argv[j].startsWith("-")) return argv[j];
    }
  }
  return null;
}

/** `cmd /c …` / `cmd /k …`: everything after the switch is the script. */
function cmdScriptArg(argv: string[]): string | null {
  const at = argv.findIndex((a) => /^\/[ck]$/i.test(a));
  return at >= 0 && at + 1 < argv.length ? argv.slice(at + 1).join(" ") : null;
}

/** `pwsh -Command …` / `-c …` (rest of argv is the script) or `-EncodedCommand <b64>`
 *  (base64 UTF-16LE, decoded here so an encoded command cannot hide its program).
 *  Returns undefined when there is no inline script, null when it cannot be decoded. */
function powershellScriptArg(argv: string[]): string | null | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i].toLowerCase();
    if (/^[-/](?:c|command|com|comm|comma|comman)$/.test(a)) return argv.slice(i + 1).join(" ") || null;
    if (/^[-/](?:e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/.test(a)) {
      const b64 = argv[i + 1];
      if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
      const text = Buffer.from(b64, "base64").toString("utf16le");
      // eslint-disable-next-line no-control-regex -- deliberate: decoded text holding NUL..BS or U+FFFD is binary, not a script
      return /[\u0000-\u0008\uFFFD]/.test(text) ? null : text;
    }
  }
  return undefined;
}

/** `find … -exec cmd {} ;` / `-execdir` / `-ok`: the embedded command runs per match. */
function findExecCommands(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(argv[i])) continue;
    const cmd: string[] = [];
    let j = i + 1;
    for (; j < argv.length && argv[j] !== ";" && argv[j] !== "+" && argv[j] !== "\\;"; j++) cmd.push(argv[j]);
    if (cmd.length) out.push(cmd.map((w) => (/[\s'"]/.test(w) ? `'${w.replace(/'/g, "")}'` : w)).join(" "));
    i = j;
  }
  return out;
}

interface Heredoc { line: number; delim: string; dashed: boolean; ownerIsShell: boolean; owner: string }

/** Programs that run code given inline, in a here-document or on standard input (the map scans that code for paths). */
export const INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3", "py", "ruby", "perl", "php", "osascript", "lua", "tclsh"]);
/** The options that hand an interpreter its code inline (`python -c`, `node -e`, `perl -E`, `php -r`). */
const INLINE_CODE = /^(?:-c|-e|-E|-r|-p|--eval|--print|--command)$|^--eval=|^--print=/;
/** Whether this interpreter takes its program from standard input: no inline code and no script operand, or `-`. */
function interpreterReadsStdin(argv: string[]): boolean {
  if (argv.some((a) => INLINE_CODE.test(a))) return false;
  const operands = argv.filter((a) => !a.startsWith("-") || a === "-");
  return operands.length === 0 || operands[0] === "-";
}

/** Find here-document openers (`<<word`, `<<-word`, `<< 'word'`, `<<\word`) in the
 *  whole command, honoring quotes and command-substitution nesting so a `<<` inside
 *  `"$(cat <<EOF …)"` is seen but a `<<` inside a quoted string, a here-string
 *  (`<<<`) or arithmetic is not. Each opener records its delimiter, the source line it
 *  sits on, and whether the command that owns it runs a shell (its body is a script)
 *  rather than consuming the body as data. `words`/`stripPrefixes` resolve the owning
 *  program past wrappers (`sudo bash <<EOF`). */
function findHeredocs(src: string): Heredoc[] {
  const found: Heredoc[] = [];
  const stack: Array<'"' | null> = []; // saved quote state at each substitution entry
  let quote: '"' | "'" | null = null;
  let cmdStart = 0;
  let line = 0;
  // Openers seen on the current line: their bodies start after the next unquoted newline, one after the other, and are
  // data, so they are skipped as the shell does. Scanning a body as shell would let an apostrophe in it ("it's") open a
  // quote that hides the next opener.
  const pending: Heredoc[] = [];
  /** From the newline at `at`, past each pending body and its terminator line. Returns the index of the last character
   *  consumed, or `at` when a body has no terminator (then nothing is skipped, as stripHeredocs leaves it too). */
  const skipBodies = (at: number): number => {
    let p = at + 1;
    for (const h of pending) {
      let found = false;
      while (p <= src.length) {
        const end = src.indexOf("\n", p);
        const text = src.slice(p, end === -1 ? src.length : end).replace(/\r$/, "");
        p = end === -1 ? src.length + 1 : end + 1;
        if ((h.dashed ? text.replace(/^\t+/, "") : text) === h.delim) { found = true; break; }
        if (end === -1) break;
      }
      if (!found) return at;
    }
    return Math.min(p, src.length) - 1;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "\n") {
      line++;
      if (!quote) {
        cmdStart = i + 1;
        if (pending.length) {
          const to = skipBodies(i);
          for (let k = i + 1; k <= to; k++) if (src[k] === "\n") line++;
          pending.length = 0;
          i = to;
          cmdStart = to + 1; // the next command starts after the bodies

        }
      }
      continue;
    }
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (quote === '"') {
      if (c === "\\" && n !== undefined) { i++; continue; }
      if (c === '"') { quote = null; continue; }
      // Command substitutions run inside double quotes; a here-doc can open there.
      if (c === "$" && n === "(") { stack.push(quote); quote = null; cmdStart = i + 2; i++; continue; }
      if (c === "`") { stack.push(quote); quote = null; cmdStart = i + 1; continue; }
      continue;
    }
    // unquoted
    if (c === "\\" && n !== undefined) { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "$" && n === "(") { stack.push(null); cmdStart = i + 2; i++; continue; }
    if (c === "`") { stack.push(null); cmdStart = i + 1; continue; }
    if (c === "(") { stack.push(null); cmdStart = i + 1; continue; }
    if (c === ")") { if (stack.length) quote = stack.pop() ?? null; cmdStart = i + 1; continue; }
    if (c === ";" || c === "&" || c === "|") { cmdStart = i + 1; continue; }
    if (c === "<" && n === "<") {
      if (src[i + 2] === "<") { i += 2; continue; } // here-string, not a here-doc
      let j = i + 2;
      let dashed = false;
      if (src[j] === "-") { dashed = true; j++; }
      while (src[j] === " " || src[j] === "\t") j++;
      let delim = "";
      const q = src[j];
      if (q === "'" || q === '"') {
        const end = src.indexOf(q, j + 1);
        if (end === -1 || src.slice(j + 1, end).includes("\n")) { i = j; continue; }
        delim = src.slice(j + 1, end);
        j = end + 1;
      } else {
        if (src[j] === "\\") j++;
        while (j < src.length && /[A-Za-z0-9_./-]/.test(src[j])) delim += src[j++];
      }
      if (delim) {
        const cmdText = src.slice(cmdStart, i);
        const { tokens } = stripPrefixes(words(cmdText));
        const prog = tokens.length ? canonProgram(tokens[0]) : "";
        const opener = { line, delim, dashed, ownerIsShell: SHELLS.has(prog), owner: prog };
        found.push(opener);
        pending.push(opener);
      }
      i = j - 1;
      continue;
    }
  }
  return found;
}

/** Remove here-document bodies before the line-splitter runs, so their lines are
 *  never parsed as commands. A body is inert data — a commit message, an HTTP
 *  payload, a note written with `cat <<EOF > f` (the redirection still records the
 *  write) — except a body fed to a shell (`bash <<EOF …`), which runs and is returned
 *  for its own decomposition. A `<<` whose delimiter never recurs on a later line is
 *  left untouched (it was arithmetic or otherwise not a here-doc). */
function stripHeredocs(src: string): { text: string; scripts: string[]; code: Array<{ program: string; body: string }> } {
  if (!src.includes("<<")) return { text: src, scripts: [], code: [] };
  const openers = findHeredocs(src);
  if (openers.length === 0) return { text: src, scripts: [], code: [] };
  const strip = (s: string) => s.replace(/^\t+/, "");
  const byLine = new Map<number, Heredoc[]>();
  for (const op of openers) { const l = byLine.get(op.line) ?? []; l.push(op); byLine.set(op.line, l); }
  const lines = src.split("\n");
  const out: string[] = [];
  const scripts: string[] = [];
  // A body fed to an interpreter (`python3 <<EOF … EOF`) is that interpreter's program: kept for the same scan as `-c` code.
  const code: Array<{ program: string; body: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const ops = byLine.get(i);
    if (!ops) continue;
    for (const op of ops) {
      // Only consume a body when the terminator is actually present below.
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if ((op.dashed ? strip(lines[j]) : lines[j]) === op.delim) { end = j; break; }
      }
      if (end === -1) continue;
      const body = lines.slice(i + 1, end).map((l) => (op.dashed ? strip(l) : l));
      if (op.ownerIsShell) scripts.push(body.join("\n"));
      else if (INTERPRETERS.has(op.owner)) code.push({ program: op.owner, body: body.join("\n") });
      i = end; // skip the body and the terminator line
    }
  }
  return { text: out.join("\n"), scripts, code };
}

// PowerShell statements that open with a keyword and run nothing of their own: their conditions, collections and bodies (a
// `( … )` group, a `{ … }` block) were already read on their own. `return`, `throw` and `exit` are followed by a value,
// which may be a pipeline that runs a command.
const PS_STATEMENTS = new Set([
  "if", "elseif", "else", "foreach", "for", "while", "do", "until", "switch", "try", "catch", "finally", "trap", "begin",
  "process", "end", "clean", "dynamicparam", "param", "data",
]);
const PS_NAMED = new Set(["function", "filter", "workflow", "configuration", "class", "enum"]);
const PS_VALUE = new Set(["return", "throw", "exit", "break", "continue"]);
/** A PowerShell assignment's target and operator (`$x =`, `$env:X +=`, `${env:X} =`, `$a.b[0] =`, `[int]$n =`). Linear: it
 *  is anchored and every run stops at a character it cannot take. */
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, and each run is bounded by a character it excludes
const PS_ASSIGNMENT = /^(?:\[[^\]\s]*\]\s*)*\$(?:\{[^}]*\}|[\w:?]+)(?:\.\w+|\[[^\]]*\])*\s*(?:[-+*/%]|\?\?)?=(?!=)/;
/** Running a script block or a string as code through a method (`$block.Invoke()`, `$ExecutionContext.InvokeCommand
 *  .InvokeScript(…)`). */
const PS_INVOKE = /\.Invoke\w*(?![\w-])/i;
/** The parameters through which a cmdlet takes a script block to run. */
const PS_BLOCK_PARAMETER = /^-(?:ScriptBlock|sb|FilterScript|Process|Begin|End)$/i;

/** What one PowerShell statement runs, read from its text after `extractSubstitutions` (its groups are the placeholder and
 *  its blocks are blank): `none` for a statement that runs no program (an assignment of a value, a keyword statement, a bare
 *  variable or member expression, a string), `opaque` for a program only known at run time (`& $x`, `& (…)`, `. $x`), or the
 *  command text it runs (the right-hand side of `$x = cmd`, the program after `&`). */
function psStatement(text: string): { kind: "none" } | { kind: "opaque" } | { kind: "command"; text: string } {
  let t = text.trim();
  if (PS_INVOKE.test(t)) return { kind: "opaque" };
  for (let guard = 0; guard < 64; guard++) {
    if (t === "") return { kind: "none" };
    const word = /^\S+/.exec(t)?.[0] ?? "";
    const lower = word.toLowerCase();
    const after = t.slice(word.length).trim();
    if (PS_STATEMENTS.has(lower)) {
      // Its own options (`switch -regex`) and type filters (`catch [IOException]`) come before what it reads.
      // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, and each repeat opens with a fixed `-` or `[`
      t = after.replace(/^(?:(?:-\w+|\[[^\]]*\])\s*)*/, "");
      continue;
    }
    if (PS_NAMED.has(lower)) return { kind: "none" };
    if (PS_VALUE.has(lower)) { t = lower === "break" || lower === "continue" ? "" : after; continue; }
    if (t[0] === "&" || (t[0] === "." && /^\.\s/.test(t))) {
      const rest = t.slice(1).trim();
      // `& { … }` runs a block already read; `& $x`, `& "$x"`, `& (…)` and `. $x` run a program only known at run time.
      if (rest === "") return { kind: "none" };
      const target = /^\S+/.exec(rest)?.[0] ?? "";
      if (/^["']?\$/.test(target) || (target[0] === '"' && target.includes("$"))) return { kind: "opaque" };
      return { kind: "command", text: t[0] === "&" ? rest : t };
    }
    if (t[0] === "$" || t[0] === "[") {
      const assignment = PS_ASSIGNMENT.exec(t);
      if (assignment) { t = t.slice(assignment[0].length).trim(); continue; }
      // `foreach ($f in <pipeline>)`: the collection is a pipeline that may run a command.
      const each = /^\$\w+\s+in\s+/i.exec(t);
      if (each) { t = t.slice(each[0].length); continue; }
      // A type literal opens a .NET call (`[IO.File]::Delete(…)`): read as a command, as before.
      if (t[0] === "[") return { kind: "command", text: t };
      return { kind: "none" };
    }
    // A string, a number or a collection is a value, not a command.
    if (/^["'@]/.test(t) || /^-?\d[\d.]*$/.test(word)) return { kind: "none" };
    return { kind: "command", text: t };
  }
  return { kind: "opaque" };
}

/** Decompose a command line into the simple commands it will run. Recurses into
 *  `-c` scripts and command substitutions up to a bounded depth. `inherited` is the
 *  assignments an enclosing command puts in force for this script (`X=1 sh -c '…'`).
 *  `dialect` is the language the text is read in: under `powershell`, script blocks are
 *  read for the commands inside them, and statements (assignments, `foreach`/`if`/
 *  `while`/`switch`, bare variable expressions) are not commands of their own. */
export function decomposeShell(command: string, depth = 0, inherited: readonly string[] = [], dialect: ShellDialect = "posix"): SimpleCommand[] {
  const src = command.trim();
  if (!src) return [];
  const opaque = (raw = src): SimpleCommand[] => [{ program: "", programRaw: "", argv: [], redirects: [], raw, opaque: true }];
  if (depth > MAX_DEPTH) return opaque();
  const ps = dialect === "powershell";

  const { text, scripts, code } = ps ? { text: src, scripts: [], code: [] } : stripHeredocs(src);
  const fromHeredocs = scripts.flatMap((s) => decomposeShell(s, depth + 1, inherited));
  // An interpreter's here-document is its code: recorded as that interpreter run with the code inline.
  for (const c of code) fromHeredocs.push({ program: c.program, programRaw: c.program, argv: ["-e", c.body], redirects: [], raw: `${c.program} <<heredoc`, opaque: false });

  const { segments, unbalanced } = splitTopLevel(text, ps);
  // Unreadable: kept as the text without its here-document bodies, which are data (a commit message that says "scopebond"
  // never counts as naming it); a body fed to a shell is decomposed on its own above.
  if (unbalanced) return [...opaque(text), ...fromHeredocs];

  const out: SimpleCommand[] = [];
  for (const seg of segments) {
    const extracted = extractSubstitutions(seg, ps);
    let outer = extracted.outer;
    for (const sub of extracted.inner) out.push(...decomposeShell(sub, depth + 1, inherited, dialect));
    if (ps) {
      const statement = psStatement(outer);
      if (statement.kind === "opaque") { out.push(...opaque(seg)); continue; }
      if (statement.kind === "none") {
        // It runs no program; a redirection it carries (`"x" > f`) still writes, and its text is kept for the variables it sets.
        out.push({ program: "", programRaw: "", argv: [], redirects: splitRedirects(tokenize(outer)).redirects, raw: seg, opaque: false, assigns: [...inherited] });
        continue;
      }
      outer = statement.text;
    }

    const split = splitRedirects(tokenize(outer));
    const { tokens, wrappers, assigns: own } = stripPrefixes(split.words);
    const assigns = [...inherited, ...own];
    const redirects = split.redirects;
    // Each wrapper is recorded as a command of its own (`sudo` is a program a policy
    // may deny), carrying any file its options name (`time -o f`, `xargs -a f`).
    for (const w of wrappers) out.push({ program: basename(w.raw), programRaw: w.raw, argv: [], redirects: w.redirects, raw: seg, opaque: false, assigns: [...inherited], ...(w.describes && !ps ? { describes: true as const } : {}) });
    if (tokens.length === 0) {
      // A bare redirection (`> file`) still writes its target.
      if (redirects.length) out.push({ program: "", programRaw: "", argv: [], redirects, raw: seg, opaque: false, assigns });
      // Assignments alone set variables for the commands after them in the same script.
      else if (own.length) out.push({ program: "", programRaw: "", argv: [], redirects: [], raw: seg, opaque: false, assigns, assignOnly: true });
      continue; // pure substitution/subshell — inner already handled
    }
    // A program named by a variable, an ANSI-C string or a substitution is only known
    // at run time: it cannot be judged by name, so it is opaque (fails closed).
    if (isDynamicProgram(tokens[0])) { out.push(...opaque(seg)); continue; }
    const program = basename(tokens[0]);
    const argv = tokens.slice(1);
    // Read as POSIX, a command that only prints its help or version is marked so (PowerShell's own commands take no `--help`:
    // there `rm --help` is Remove-Item given a path).
    out.push({ program, programRaw: tokens[0], argv, redirects, raw: seg, opaque: false, assigns, ...(!ps && describesItself(program, argv) ? { describes: true as const } : {}) });
    // A script block handed over in a variable (`Invoke-Command -ScriptBlock $sb`) runs code only known at run time.
    if (ps && argv.some((a, k) => PS_BLOCK_PARAMETER.test(a) && /^\$/.test(argv[k + 1] ?? ""))) out.push(...opaque(seg));

    const canon = canonProgram(program);
    const nested = (script: string | null | undefined) => { if (script) out.push(...decomposeShell(script, depth + 1, assigns)); };
    if (SHELLS.has(canon)) {
      const script = shellScriptArg(argv);
      nested(script);
      // A shell given neither a -c script nor a script file reads its program from
      // standard input (`curl … | sh`, `sh -s`): the text that will run is not in the
      // command, so it is opaque rather than safe.
      if (script === null && !argv.some((a) => !a.startsWith("-")) && !argv.some((a) => /^--(?:version|help)$/.test(a))) out.push(...opaque(seg));
    } else if (INTERPRETERS.has(canon) && interpreterReadsStdin(argv) && depth === 0) {
      // Code on standard input (`echo "…" | python3`, `python -`) is not in the command, but what feeds it is: the whole
      // command line is scanned as that interpreter's code, so a path named anywhere in it counts.
      out.push({ program, programRaw: tokens[0], argv: ["-e", src], redirects: [], raw: seg, opaque: false });
    } else if (canon === "eval") {
      nested(argv.join(" "));
    } else if (canon === "iex" || canon === "invoke-expression") {
      // Given no code (`$cmd | iex`), it runs what the pipeline hands it: only known at run time.
      // eslint-disable-next-line security/detect-unsafe-regex -- bounded: the nested optionals spell at most `-command`
      const script = argv.filter((a) => !/^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(a)).join(" ");
      if (script.trim() === "") out.push(...opaque(seg));
      else nested(script);
    } else if (canon === "trap") {
      if (argv.length >= 2 && !argv[0].startsWith("-")) nested(argv[0]);
    } else if (canon === "su" || canon === "runuser" || canon === "script" || canon === "flock" || canon === "sg") {
      const script = commandOption(argv);
      if (script) nested(script);
      else if (canon === "sg" || canon === "flock") {
        // `sg group cmd …` / `flock [-w n] lockfile cmd …`: the words after the first operand.
        const ops: string[] = [];
        for (let k = 0; k < argv.length; k++) {
          if (argv[k].startsWith("-") && ops.length === 0) { if (/^-[wEn]$/.test(argv[k])) k++; continue; }
          ops.push(argv[k]);
        }
        nested(ops.slice(1).join(" "));
      }
    } else if (canon === "watch") {
      nested(watchCommand(argv));
    } else if (canon === "parallel") {
      nested(parallelCommand(argv));
    } else if (canon === "cmd") {
      const script = cmdScriptArg(argv);
      nested(script);
    } else if (POWERSHELLS.has(canon)) {
      const script = powershellScriptArg(argv);
      if (script === null) out.push(...opaque(seg));
      else nested(script);
    } else if (canon === "find") {
      for (const script of findExecCommands(argv)) nested(script);
    }
  }
  out.push(...fromHeredocs);
  // A command of assignments alone runs nothing a rule could judge: as before, it is read as one that could not be.
  return out.some((c) => !c.assignOnly) ? out : [...out, ...opaque()];
}

/** One pushed destination: the branch it updates and whether that update is forced. */
export interface PushTarget {
  ref?: string;
  force: boolean;
  /** True when the destination ref is being deleted (`:dst`, `--delete`), which
   *  rewrites the branch's existence and so is destructive even without `--force`. */
  del?: boolean;
  /** True when the push targets every branch (`--all`, `--mirror`, `--branches`), so
   *  it necessarily reaches any protected ref; `--mirror` also prunes and forces. */
  all?: boolean;
}

/** Canonicalize a push destination to the short branch name a policy names:
 *  `refs/heads/main` → `main`, `heads/main` → `main`. `HEAD` and `@` mean the
 *  current branch and resolve to undefined (the runtime fills the real branch in). */
function canonRef(dst: string): string | undefined {
  const d = dst.trim();
  if (!d || d === "HEAD" || d === "@") return undefined;
  return d.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
}


/** The `NAME=value` words given, as a map from the name (upper-cased: Windows reads names in any case) to the value. */
export function assignmentsOf(words: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of words) {
    const eq = w.indexOf("=");
    if (eq > 0) out.set(w.slice(0, eq).toUpperCase(), w.slice(eq + 1));
  }
  return out;
}

/** The configuration git takes from the environment `env` (names upper-cased; a null value is one the command sets without
 *  showing), as `key=value` entries like `-c` ones: GIT_CONFIG_COUNT with GIT_CONFIG_KEY_<n>, and GIT_CONFIG_PARAMETERS. A key
 *  the command does not show (`GIT_CONFIG_KEY_0="$K"`, a count with no key) is `include.path=`: configuration that may hold
 *  anything. The config files the environment can name (HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL) are not read: they are the
 *  person's own configuration, which the hook never sees either way. */
export function gitEnvConfigs(env: ReadonlyMap<string, string | null>): string[] {
  const configs: string[] = [];
  const shown = (v: string | null | undefined): v is string => typeof v === "string" && !/[$`]/.test(v);
  let keys = 0;
  for (const [name, value] of env) {
    if (/^GIT_CONFIG_KEY_\d+$/.test(name)) { keys++; configs.push(shown(value) ? `${value}=` : "include.path="); }
    else if (name === "GIT_CONFIG_PARAMETERS") {
      // `'key=value' …` (or `'key'='value'`, as newer git writes it).
      const items = shown(value) ? [...value.matchAll(/'([^']*)'/g)].map((x) => x[1]) : [];
      configs.push(...(items.length ? items : [shown(value) ? value : "include.path="]));
    }
  }
  if (env.has("GIT_CONFIG_COUNT") && keys === 0) configs.push("include.path=");
  return configs;
}

// git's own subcommands. git never lets an alias replace one of these, so an alias (shown or not) can only turn a subcommand
// outside this list into something else (a push).
const GIT_BUILTINS = new Set([
  "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bugreport", "bundle", "cat-file", "check-attr",
  "check-ignore", "check-mailmap", "check-ref-format", "checkout", "checkout-index", "cherry", "cherry-pick", "citool", "clean",
  "clone", "column", "commit", "commit-graph", "commit-tree", "config", "count-objects", "credential", "describe", "diagnose",
  "diff", "diff-files", "diff-index", "diff-tree", "difftool", "fast-export", "fast-import", "fetch", "fetch-pack",
  "filter-branch", "fmt-merge-msg", "for-each-ref", "for-each-repo", "format-patch", "fsck", "gc", "get-tar-commit-id", "grep",
  "gui", "hash-object", "help", "index-pack", "init", "instaweb", "interpret-trailers", "log", "ls-files", "ls-remote",
  "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge", "merge-base", "merge-file", "merge-index", "merge-tree",
  "mergetool", "mktag", "mktree", "multi-pack-index", "mv", "name-rev", "notes", "pack-objects", "pack-refs", "prune",
  "prune-packed", "pull", "push", "range-diff", "read-tree", "rebase", "reflog", "remote", "repack", "replace", "request-pull",
  "rerere", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "send-email", "shortlog", "show", "show-branch",
  "show-index", "show-ref", "sparse-checkout", "stash", "status", "stripspace", "submodule", "switch", "symbolic-ref", "tag",
  "unpack-file", "unpack-objects", "update-index", "update-ref", "update-server-info", "var", "verify-commit", "verify-pack",
  "verify-tag", "version", "whatchanged", "worktree", "write-tree",
]);
// Well-known git extensions that move objects or branches of their own and never stand for a push of a ref: configuration the
// command does not show does not make them one.
const GIT_EXTENSIONS = new Set(["lfs", "flow"]);

/** A git invocation split into its global `-c` config values (and those its own
 *  environment prefix gives it, see `gitEnvConfigs`), its subcommand, the
 *  subcommand's arguments and the folder `-C` points it at, or null if the program
 *  is not git. Global options that take a value (`-C dir`, `-c k=v`, `--git-dir d` …)
 *  are skipped with it. */
export function gitArgs(cmd: SimpleCommand): { sub?: string; args: string[]; configs: string[]; dir?: string } | null {
  if (canonProgram(cmd.program) !== "git") return null;
  const a = cmd.argv;
  const configs: string[] = gitEnvConfigs(assignmentsOf(cmd.assigns ?? []));
  let dir: string | undefined;
  let i = 0;
  while (i < a.length) {
    const t = a[i];
    if (t === "-c" || t === "--config-env") { configs.push(a[i + 1] ?? ""); i += 2; continue; }
    if (t.startsWith("--config-env=")) { configs.push(t.slice("--config-env=".length)); i++; continue; }
    if (t === "-C") { const d = a[i + 1] ?? ""; dir = dir === undefined || /^(?:[\\/]|[A-Za-z]:)/.test(d) ? d : `${dir}/${d}`; i += 2; continue; }
    if (t === "--git-dir" || t === "--work-tree" || t === "--namespace" || t === "--super-prefix") { i += 2; continue; }
    if (t.startsWith("-")) { i++; continue; }
    break;
  }
  return { sub: a[i], args: a.slice(i + 1), configs, ...(dir !== undefined ? { dir } : {}) };
}

/** The ref recorded for a push whose destination cannot be read from the command
 *  line: an alias (`git -c alias.ship=push ship`, or one given through the
 *  environment), a configured push refspec (`-c remote.origin.push=…`,
 *  `-c push.default=matching`), configuration the command does not show (a config
 *  file it points git at) or a lower-level push (`git send-pack`, `git http-push`,
 *  `git subtree push`). It starts with `-`, which the starter branch guard refuses,
 *  so an unreadable push fails closed. */
export const UNKNOWN_REF = "--unknown";

/** Parse a `git … push …` simple command, or null if it is not a push. Handles
 *  global options that take an argument (`-C dir`, `-c k=v`), push options that take
 *  one (`-o`, `--repo`, `--receive-pack`), every force spelling (`--force`, `-f`,
 *  `-uf`, `--force-with-lease`, `--force-if-includes`, a `+` refspec), `src:dst` and
 *  fully qualified refspecs, and multiple refspecs — each destination is returned,
 *  so `git push origin feature refs/heads/main` cannot hide `main` in second place.
 *  `--all`, `--mirror` and `--branches` push every branch: they return the literal
 *  flag as the ref, which the starter policy denies; `--tags` alone pushes only tags
 *  and returns `--tags`, which it allows. `ref`/`force` mirror the first target for
 *  callers that expect a single push. `lineConfigs` is configuration the rest of the
 *  command line gives this command through the environment (an earlier `export`,
 *  an enclosing `VAR=… sh -c '…'`), read as if given with `-c`. */
export function parseGitPush(cmd: SimpleCommand, lineConfigs: readonly string[] = []): { force: boolean; remote?: string; ref?: string; targets: PushTarget[] } | null {
  const g = gitArgs(cmd);
  if (!g) return null;
  const configs = [...g.configs, ...lineConfigs];
  const sub = g.sub?.toLowerCase();
  // An alias can stand for a push only under a name that is not one of git's own subcommands (git ignores the others).
  const aliasable = sub !== undefined && !GIT_BUILTINS.has(sub);
  const aliased = aliasable && configs.some((c) => /^alias\./i.test(c));
  // Configuration the command does not show (an included file, an environment key it computes) may hold an alias or a push refspec.
  const unshown = configs.some((c) => /^include\.path(?:=|$)/i.test(c) || /^includeif\./i.test(c));
  const configuredPush = unshown || configs.some((c) => /^(?:remote\..*\.push(?:url)?|push\.default|remote\.pushdefault)(?:=|$)/i.test(c));
  const mayBeAlias = unshown && aliasable && !GIT_EXTENSIONS.has(sub);
  const lowLevel = g.sub === "send-pack" || g.sub === "http-push" || (g.sub === "subtree" && g.args.includes("push"));
  const unknown = { force: false, ref: UNKNOWN_REF, targets: [{ ref: UNKNOWN_REF, force: false }] };
  if (aliased || mayBeAlias || lowLevel) return unknown;
  if (g.sub !== "push") return null;
  const rest = g.args;
  let force = false;
  let everything: string | undefined;
  let tags = false;
  let del = false;
  let repo: string | undefined;
  const positional: string[] = [];
  // A rehearsal (`--dry-run`) or a help page updates no branch: not a push. git reads its options anywhere before `--`;
  // an option's value (`-o --dry-run`, `--repo --dry-run`) is not one.
  for (let k = 0; k < rest.length && rest[k] !== "--"; k++) {
    if (/^(?:-o|--push-option|--receive-pack|--exec|--repo)$/.test(rest[k])) k++;
    else if (isDescribeOption(rest[k]) && rest[k] !== "--version") return null;
  }
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (t === "--force" || t === "--force-with-lease" || t.startsWith("--force-with-lease=") || t === "--force-if-includes") { force = true; continue; }
    if (/^-[A-Za-z]+$/.test(t) && t.includes("f")) { force = true; continue; } // -f, -uf, -fu
    if (t === "--delete" || (/^-[A-Za-z]+$/.test(t) && t.includes("d"))) { del = true; continue; } // --delete, -d, -df
    if (t === "--all" || t === "--mirror" || t === "--branches") { everything = t; if (t === "--mirror") force = true; continue; }
    if (t === "--tags") { tags = true; continue; }
    if (t === "--repo") { repo = rest[++k]; continue; }
    if (t.startsWith("--repo=")) { repo = t.slice("--repo=".length); continue; }
    if (t === "-o" || t === "--push-option" || t === "--receive-pack" || t === "--exec") { k++; continue; }
    if (t === "--") continue;
    if (t.startsWith("-")) continue;
    positional.push(t);
  }
  // `--repo <r>` names the repository. git itself still reads a first positional as
  // the repository when one is given, but the option's documentation reads as if the
  // positionals were then all refspecs — so with `--repo`, every positional is checked
  // as a refspec AND, when at most one is given, the current branch is too. Either
  // reading of `git push --repo origin HEAD:main` is covered.
  const remote = repo ?? positional[0];
  const specs = repo !== undefined ? positional : positional.slice(1);
  // A configured push refspec or push.default decides the destination only when the command names none: a refspec on the
  // command line (`git push origin feature`) is what git pushes, whatever the configuration says.
  if (configuredPush && specs.length === 0 && !everything && !tags) return unknown;
  const targets: PushTarget[] = [];
  // `--all`/`--mirror`/`--branches` reach every branch, so they hit any protected ref;
  // `--mirror` also prunes and force-updates. The pseudo-ref keeps the starter policy's
  // ref allowlist denying it; `all` is the signal a force_push_guard clause reads.
  if (everything) targets.push({ ref: everything, force, all: true, ...(everything === "--mirror" ? { del: true } : {}) });
  for (const spec of specs) {
    let s = spec;
    let f = force;
    if (s.startsWith("+")) { f = true; s = s.slice(1); }
    const colon = s.indexOf(":");
    // `src:dst` pushes to dst; `:dst` deletes dst; `src:` has no destination, so src.
    const isDelete = del || (colon >= 0 && s.slice(0, colon) === "");
    const dst = colon >= 0 ? (s.slice(colon + 1) || s.slice(0, colon)) : s;
    // A destination made of a variable, substitution or glob is only known at run time:
    // it is an unresolved destination, never a safe one.
    const unresolved = /[$`*?[\]{}]/.test(dst);
    targets.push({ ref: unresolved ? UNKNOWN_REF : canonRef(dst.replace(/^\+/, "")), force: f || dst.startsWith("+"), ...(isDelete ? { del: true } : {}) });
  }
  if (repo !== undefined && positional.length <= 1 && !everything && !tags) targets.push({ ref: undefined, force, ...(del ? { del: true } : {}) });
  if (targets.length === 0) targets.push(tags ? { ref: "--tags", force } : { ref: undefined, force, ...(del ? { del: true } : {}) });
  const first = targets[0];
  return { force: targets.some((t) => t.force), ...(remote !== undefined ? { remote } : {}), ...(first.ref !== undefined ? { ref: first.ref } : {}), targets };
}
