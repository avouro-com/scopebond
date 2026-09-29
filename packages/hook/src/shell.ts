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

/** Split a command line into top-level simple-command strings at unquoted
 *  separators (`;`, newline, `&&`, `||`, `|`, `&`), leaving quotes, `$( )`,
 *  backticks and `( )` groups intact inside each piece. */
function splitTopLevel(src: string): { segments: string[]; unbalanced: boolean } {
  const segments: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let paren = 0; // depth of $( ) and ( )
  let backtick = false;
  const flush = () => { const t = cur.trim(); if (t) segments.push(t); cur = ""; };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      cur += c;
      if (quote === "'") { if (c === "'") quote = null; }
      else if (c === "\\" && n !== undefined) cur += src[++i];
      else if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "`") { backtick = !backtick; cur += c; continue; }
    if (backtick) { cur += c; continue; }
    if (c === "\\" && n !== undefined) { cur += c + src[++i]; continue; }
    if (c === "$" && n === "(") { paren++; cur += "$("; i++; continue; }
    if (c === "(") { paren++; cur += c; continue; }
    if (c === ")") { if (paren > 0) paren--; cur += c; continue; }
    if (paren > 0) { cur += c; continue; }
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
    if (c === ";" || c === "\n") { flush(); continue; }
    if (c === "&" && n === "&") { flush(); i++; continue; }
    if (c === "|" && n === "|") { flush(); i++; continue; }
    if (c === "&" || c === "|") { flush(); continue; }
    cur += c;
  }
  flush();
  return { segments, unbalanced: quote !== null || paren !== 0 || backtick };
}

/** What a command substitution leaves behind in the outer command: a parameter
 *  expansion, so the word it sat in is treated as unresolved (its value is only known
 *  at run time) — as a program name it is dynamic, as a path it is glob-tested. */
const SUBST = "${__sb_subst}";

/** Pull the contents of command substitutions and subshell groups out of one
 *  segment — `$( … )` and `` ` … ` `` (also inside double quotes, where the shell
 *  still runs them) and `( … )` groups — for recursion. A substitution is replaced
 *  by a placeholder expansion; a group is blanked, except an empty `()` (a function
 *  definition), which is kept. */
function extractSubstitutions(seg: string): { outer: string; inner: string[] } {
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
    if (quote === "'") { outer += c; if (c === "'") quote = null; continue; }
    if (c === "`") {
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
      if (c === "\\" && n !== undefined) outer += seg[++i];
      else if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; outer += c; continue; }
    if (c === "\\" && n !== undefined) { outer += c + seg[++i]; continue; }
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

interface Wrapper { name: string; raw: string; redirects: Redirect[] }

/** Words of a string as the shell would split it (quotes honored, operators dropped). */
const words = (s: string): string[] => tokenize(s).filter((t) => !t.op).map((t) => t.t);

/** Strip the leading shell keywords, `NAME=value` assignments and wrappers (`sudo`,
 *  `env`, `time`, `xargs`, `timeout`, `strace` …, each with its own option arity) so
 *  the program is the real one about to run. `env -S "…"` splits its string into the
 *  command. Returns the remaining words and the wrappers passed on the way. */
function stripPrefixes(input: string[]): { tokens: string[]; wrappers: Wrapper[] } {
  let tokens = input;
  const wrappers: Wrapper[] = [];
  let i = 0;
  for (let guard = 0; i < tokens.length && guard < 1000; guard++) {
    const t = tokens[i];
    if (isAssignment(t)) { i++; continue; }
    if (KEYWORDS.has(t)) { i++; continue; }
    // `for x in …` / `select x in …`: the header runs nothing (its substitutions were
    // already extracted); the body follows `do`.
    if (t === "for" || t === "select") return { tokens: [], wrappers };
    // `case WORD in PATTERN) cmd`: skip to the command after the pattern.
    if (t === "case") {
      const at = tokens.indexOf("in", i + 1);
      if (at < 0) return { tokens: [], wrappers };
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
    wrappers.push({ name: w, raw: t, redirects });
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
  return { tokens: tokens.slice(i), wrappers };
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
function shellScriptArg(argv: string[]): string | null {
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
      return /[\u0000-\u0008�]/.test(text) ? null : text;
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

interface Heredoc { line: number; delim: string; dashed: boolean; ownerIsShell: boolean }

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
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "\n") { line++; if (!quote) cmdStart = i + 1; continue; }
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
        found.push({ line, delim, dashed, ownerIsShell: SHELLS.has(prog) });
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
function stripHeredocs(src: string): { text: string; scripts: string[] } {
  if (!src.includes("<<")) return { text: src, scripts: [] };
  const openers = findHeredocs(src);
  if (openers.length === 0) return { text: src, scripts: [] };
  const strip = (s: string) => s.replace(/^\t+/, "");
  const byLine = new Map<number, Heredoc[]>();
  for (const op of openers) { const l = byLine.get(op.line) ?? []; l.push(op); byLine.set(op.line, l); }
  const lines = src.split("\n");
  const out: string[] = [];
  const scripts: string[] = [];
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
      i = end; // skip the body and the terminator line
    }
  }
  return { text: out.join("\n"), scripts };
}

/** Decompose a command line into the simple commands it will run. Recurses into
 *  `-c` scripts and command substitutions up to a bounded depth. */
export function decomposeShell(command: string, depth = 0): SimpleCommand[] {
  const src = command.trim();
  if (!src) return [];
  const opaque = (raw = src): SimpleCommand[] => [{ program: "", programRaw: "", argv: [], redirects: [], raw, opaque: true }];
  if (depth > MAX_DEPTH) return opaque();

  const { text, scripts } = stripHeredocs(src);
  const fromHeredocs = scripts.flatMap((s) => decomposeShell(s, depth + 1));

  const { segments, unbalanced } = splitTopLevel(text);
  if (unbalanced) return [...opaque(), ...fromHeredocs];

  const out: SimpleCommand[] = [];
  for (const seg of segments) {
    const { outer, inner } = extractSubstitutions(seg);
    for (const sub of inner) out.push(...decomposeShell(sub, depth + 1));

    const split = splitRedirects(tokenize(outer));
    const { tokens, wrappers } = stripPrefixes(split.words);
    const redirects = split.redirects;
    // Each wrapper is recorded as a command of its own (`sudo` is a program a policy
    // may deny), carrying any file its options name (`time -o f`, `xargs -a f`).
    for (const w of wrappers) out.push({ program: basename(w.raw), programRaw: w.raw, argv: [], redirects: w.redirects, raw: seg, opaque: false });
    if (tokens.length === 0) {
      // A bare redirection (`> file`) still writes its target.
      if (redirects.length) out.push({ program: "", programRaw: "", argv: [], redirects, raw: seg, opaque: false });
      continue; // pure substitution/subshell — inner already handled
    }
    // A program named by a variable, an ANSI-C string or a substitution is only known
    // at run time: it cannot be judged by name, so it is opaque (fails closed).
    if (isDynamicProgram(tokens[0])) { out.push(...opaque(seg)); continue; }
    const program = basename(tokens[0]);
    const argv = tokens.slice(1);
    out.push({ program, programRaw: tokens[0], argv, redirects, raw: seg, opaque: false });

    const canon = canonProgram(program);
    const nested = (script: string | null | undefined) => { if (script) out.push(...decomposeShell(script, depth + 1)); };
    if (SHELLS.has(canon)) {
      nested(shellScriptArg(argv));
    } else if (canon === "eval") {
      nested(argv.join(" "));
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
      if (script) out.push(...decomposeShell(script, depth + 1));
    } else if (POWERSHELLS.has(canon)) {
      const script = powershellScriptArg(argv);
      if (script === null) out.push(...opaque(seg));
      else if (script) out.push(...decomposeShell(script, depth + 1));
    } else if (canon === "find") {
      for (const script of findExecCommands(argv)) out.push(...decomposeShell(script, depth + 1));
    }
  }
  out.push(...fromHeredocs);
  return out.length ? out : opaque();
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
export function canonRef(dst: string): string | undefined {
  const d = dst.trim();
  if (!d || d === "HEAD" || d === "@") return undefined;
  return d.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
}


/** A git invocation split into its global `-c` config values, its subcommand and
 *  the subcommand's arguments, or null if the program is not git. Global options
 *  that take a value (`-C dir`, `-c k=v`, `--git-dir d` …) are skipped with it. */
export function gitArgs(cmd: SimpleCommand): { sub?: string; args: string[]; configs: string[] } | null {
  if (canonProgram(cmd.program) !== "git") return null;
  const a = cmd.argv;
  const configs: string[] = [];
  let i = 0;
  while (i < a.length) {
    const t = a[i];
    if (t === "-c" || t === "--config-env") { configs.push(a[i + 1] ?? ""); i += 2; continue; }
    if (t.startsWith("--config-env=")) { configs.push(t.slice("--config-env=".length)); i++; continue; }
    if (t === "-C" || t === "--git-dir" || t === "--work-tree" || t === "--namespace" || t === "--super-prefix") { i += 2; continue; }
    if (t.startsWith("-")) { i++; continue; }
    break;
  }
  return { sub: a[i], args: a.slice(i + 1), configs };
}

/** The ref recorded for a push whose destination cannot be read from the command
 *  line: an alias (`git -c alias.ship=push ship`), a configured push refspec
 *  (`-c remote.origin.push=…`, `-c push.default=matching`) or a lower-level push
 *  (`git send-pack`, `git http-push`, `git subtree push`). It starts with `-`, which
 *  the starter branch guard refuses, so an unreadable push fails closed. */
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
 *  callers that expect a single push. */
export function parseGitPush(cmd: SimpleCommand): { force: boolean; remote?: string; ref?: string; targets: PushTarget[] } | null {
  const g = gitArgs(cmd);
  if (!g) return null;
  const aliased = g.configs.some((c) => /^alias\./i.test(c));
  const configuredPush = g.configs.some((c) => /^(?:remote\..*\.push(?:url)?|push\.default|remote\.pushdefault)(?:=|$)/i.test(c));
  const lowLevel = g.sub === "send-pack" || g.sub === "http-push" || (g.sub === "subtree" && g.args.includes("push"));
  if (aliased || lowLevel || (g.sub === "push" && configuredPush)) {
    return { force: false, ref: UNKNOWN_REF, targets: [{ ref: UNKNOWN_REF, force: false }] };
  }
  if (g.sub !== "push") return null;
  const rest = g.args;
  let force = false;
  let everything: string | undefined;
  let tags = false;
  let del = false;
  let repo: string | undefined;
  const positional: string[] = [];
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
    targets.push({ ref: canonRef(dst.replace(/^\+/, "")), force: f || dst.startsWith("+"), ...(isDelete ? { del: true } : {}) });
  }
  if (repo !== undefined && positional.length <= 1 && !everything && !tags) targets.push({ ref: undefined, force, ...(del ? { del: true } : {}) });
  if (targets.length === 0) targets.push(tags ? { ref: "--tags", force } : { ref: undefined, force, ...(del ? { del: true } : {}) });
  const first = targets[0];
  return { force: targets.some((t) => t.force), ...(remote !== undefined ? { remote } : {}), ...(first.ref !== undefined ? { ref: first.ref } : {}), targets };
}
