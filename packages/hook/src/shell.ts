// Shell decomposition for the hook mapper. A single Bash tool call can carry many
// commands — `a && b`, `a; b`, `a | b`, `$(c)`, `` `c` ``, `bash -c '…'`, `( c )` —
// so mapping only the first token lets a denied program ride in behind an allowed
// one. This module splits a command line into the simple commands it will actually
// run, so the mapper can emit an intent for each and the runtime can deny if any
// one of them is out of policy.
//
// It is best-effort and fail-safe: anything it cannot parse with confidence is
// returned as a single `opaque` command, which the caller denies (strict) or
// observes (non-strict) rather than trusting. Every scan is linear in the input
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
    // `&>file`, `2>&1`, `<&3` and `>|file` are redirections, not separators.
    const prev = src[i - 1];
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

/** Pull the contents of command substitutions and subshell groups out of one
 *  segment — `$( … )`, `` ` … ` ``, and a leading `( … )` — for recursion, and
 *  return the segment with those regions blanked so the outer command tokenizes
 *  cleanly. */
function extractSubstitutions(seg: string): { outer: string; inner: string[] } {
  const inner: string[] = [];
  let outer = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    const n = seg[i + 1];
    if (quote) {
      outer += c;
      if (quote === "'") { if (c === "'") quote = null; }
      else if (c === "\\" && n !== undefined) outer += seg[++i];
      else if (c === '"') quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; outer += c; continue; }
    if (c === "`") {
      const end = seg.indexOf("`", i + 1);
      if (end === -1) { outer += c; continue; }
      inner.push(seg.slice(i + 1, end));
      i = end;
      continue;
    }
    if ((c === "$" && n === "(") || c === "(") {
      const start = c === "(" ? i + 1 : i + 2;
      let depth = 1;
      let j = start;
      for (; j < seg.length && depth > 0; j++) {
        if (seg[j] === "(") depth++;
        else if (seg[j] === ")") depth--;
      }
      inner.push(seg.slice(start, depth === 0 ? j - 1 : j));
      i = j - 1;
      continue;
    }
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
      if (c === '"') quote = null;
      else if (c === "\\" && n !== undefined) cur += s[++i];
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

// Wrappers that run the rest of their argv as a command. `busybox` and `doas` run
// an applet/command given as the next word, like `sudo`.
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "nohup", "nice", "time", "exec", "stdbuf", "setsid", "xargs", "busybox", "timeout", "ionice", "chrt", "taskset", "caffeinate"]);

/** Strip a leading run of `sudo`, `env`, `command`, `nohup`, `nice`, `time`,
 *  `xargs`, `exec`, `busybox`, `timeout` … wrappers and `NAME=value` assignments, so
 *  the program is the real one about to run. `env`/`xargs` consume their own
 *  following words as the command, which is handled by simply dropping the wrapper. */
function stripPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (isAssignment(t)) { i++; continue; }
    const w = canonProgram(t);
    if (WRAPPERS.has(w)) {
      i++;
      // `sudo -u user`, `nice -n 10`, `env -i` … skip option words and their args.
      while (i < tokens.length && tokens[i].startsWith("-")) {
        const opt = tokens[i];
        i++;
        if (/^-[unCkspg]$/.test(opt) && i < tokens.length && !tokens[i].startsWith("-")) i++;
      }
      // `timeout 5 cmd`, `taskset 0x1 cmd`, `chrt 10 cmd`: a leading numeric operand.
      if ((w === "timeout" || w === "taskset" || w === "chrt") && i < tokens.length && /^[\d.]+[smhd]?$|^0x[0-9a-f]+$/i.test(tokens[i])) i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
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

/** Decompose a command line into the simple commands it will run. Recurses into
 *  `-c` scripts and command substitutions up to a bounded depth. */
export function decomposeShell(command: string, depth = 0): SimpleCommand[] {
  const src = command.trim();
  if (!src) return [];
  const opaque = (raw = src): SimpleCommand[] => [{ program: "", programRaw: "", argv: [], redirects: [], raw, opaque: true }];
  if (depth > MAX_DEPTH) return opaque();

  const { segments, unbalanced } = splitTopLevel(src);
  if (unbalanced) return opaque();

  const out: SimpleCommand[] = [];
  for (const seg of segments) {
    const { outer, inner } = extractSubstitutions(seg);
    for (const sub of inner) out.push(...decomposeShell(sub, depth + 1));

    const { words, redirects } = splitRedirects(tokenize(outer));
    const tokens = stripPrefixes(words);
    if (tokens.length === 0) {
      // A bare redirection (`> file`) still writes its target.
      if (redirects.length) out.push({ program: "", programRaw: "", argv: [], redirects, raw: seg, opaque: false });
      continue; // pure substitution/subshell — inner already handled
    }
    const program = basename(tokens[0]);
    const argv = tokens.slice(1);
    out.push({ program, programRaw: tokens[0], argv, redirects, raw: seg, opaque: false });

    const canon = canonProgram(program);
    if (SHELLS.has(canon)) {
      const script = shellScriptArg(argv);
      if (script) out.push(...decomposeShell(script, depth + 1));
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
  return out.length ? out : opaque();
}

/** One pushed destination: the branch it updates and whether that update is forced. */
export interface PushTarget { ref?: string; force: boolean }

/** Canonicalize a push destination to the short branch name a policy names:
 *  `refs/heads/main` → `main`, `heads/main` → `main`. `HEAD` and `@` mean the
 *  current branch and resolve to undefined (the runtime fills the real branch in). */
export function canonRef(dst: string): string | undefined {
  const d = dst.trim();
  if (!d || d === "HEAD" || d === "@") return undefined;
  return d.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
}

/** Parse a `git … push …` simple command, or null if it is not a push. Handles
 *  global options that take an argument (`-C dir`, `-c k=v`), push options that take
 *  one (`-o`, `--repo`, `--receive-pack`), every force spelling (`--force`, `-f`,
 *  `-uf`, `--force-with-lease`, `--force-if-includes`, a `+` refspec), `src:dst` and
 *  fully qualified refspecs, and multiple refspecs — each destination is returned,
 *  so `git push origin feature refs/heads/main` cannot hide `main` in second place.
 *  `--all`, `--mirror` and `--branches` push every branch: they return the literal
 *  flag as the ref, which the starter policy denies. `ref`/`force` mirror the first
 *  target for callers that expect a single push. */
export function parseGitPush(cmd: SimpleCommand): { force: boolean; remote?: string; ref?: string; targets: PushTarget[] } | null {
  if (canonProgram(cmd.program) !== "git") return null;
  const a = cmd.argv;
  let i = 0;
  while (i < a.length) {
    const t = a[i];
    if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "--namespace" || t === "--exec-path") { i += 2; continue; }
    if (t.startsWith("-")) { i++; continue; }
    break;
  }
  if (a[i] !== "push") return null;
  const rest = a.slice(i + 1);
  let force = false;
  let everything: string | undefined;
  const positional: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (t === "--force" || t === "--force-with-lease" || t.startsWith("--force-with-lease=") || t === "--force-if-includes") { force = true; continue; }
    if (/^-[A-Za-z]+$/.test(t) && t.includes("f")) { force = true; continue; } // -f, -uf, -fu
    if (t === "--all" || t === "--mirror" || t === "--branches") { everything = t; if (t === "--mirror") force = true; continue; }
    if (t === "-o" || t === "--push-option" || t === "--repo" || t === "--receive-pack" || t === "--exec") { k++; continue; }
    if (t === "--") continue;
    if (t.startsWith("-")) continue;
    positional.push(t);
  }
  const remote = positional[0];
  const targets: PushTarget[] = [];
  if (everything) targets.push({ ref: everything, force });
  for (const spec of positional.slice(1)) {
    let s = spec;
    let f = force;
    if (s.startsWith("+")) { f = true; s = s.slice(1); }
    const colon = s.indexOf(":");
    // `src:dst` pushes to dst; `:dst` deletes dst; `src:` has no destination, so src.
    const dst = colon >= 0 ? (s.slice(colon + 1) || s.slice(0, colon)) : s;
    targets.push({ ref: canonRef(dst.replace(/^\+/, "")), force: f || dst.startsWith("+") });
  }
  if (targets.length === 0) targets.push({ ref: undefined, force });
  const first = targets[0];
  return { force: targets.some((t) => t.force), ...(remote !== undefined ? { remote } : {}), ...(first.ref !== undefined ? { ref: first.ref } : {}), targets };
}
