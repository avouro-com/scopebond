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

export interface SimpleCommand {
  /** The invoked program's basename, after stripping sudo/env/assignment prefixes.
   *  Empty when it cannot be determined. */
  program: string;
  /** The first token whole (pre-basename), so a caller can scrub it before splitting
   *  on "/": a bare-secret command must not leak a path-fragment as the program. */
  programRaw: string;
  /** Remaining argv (quotes removed), best-effort — used to parse git push. */
  argv: string[];
  /** The raw simple-command text, for the redacted command digest. */
  raw: string;
  /** True when parsing was not confident; the caller must fail closed. */
  opaque: boolean;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "busybox"]);
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

/** Tokenize a simple command into words, honoring single and double quotes. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
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
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += c; has = true;
  }
  if (has) out.push(cur);
  return out;
}

const basename = (t: string): string => t.replace(/^.*[\\/]/, "");
const isAssignment = (t: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);

/** Strip a leading run of `sudo`, `env`, `command`, `nohup`, `nice`, `time`,
 *  `xargs`, `exec` wrappers and `NAME=value` assignments, so the program is the
 *  real one about to run. `env`/`xargs` consume their own following words as the
 *  command, which is handled by simply dropping the wrapper token. */
function stripPrefixes(tokens: string[]): string[] {
  const wrappers = new Set(["sudo", "env", "command", "nohup", "nice", "time", "exec", "stdbuf", "setsid", "xargs"]);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (isAssignment(t)) { i++; continue; }
    if (wrappers.has(basename(t))) {
      i++;
      // `sudo -u user`, `nice -n 10`, `env -i` … skip option words and their args.
      while (i < tokens.length && tokens[i].startsWith("-")) {
        const opt = tokens[i];
        i++;
        if (/^-[unC]$/.test(opt) && i < tokens.length && !tokens[i].startsWith("-")) i++;
      }
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

/** Decompose a command line into the simple commands it will run. Recurses into
 *  `-c` scripts and command substitutions up to a bounded depth. */
export function decomposeShell(command: string, depth = 0): SimpleCommand[] {
  const src = command.trim();
  if (!src) return [];
  const opaque = (): SimpleCommand[] => [{ program: "", programRaw: "", argv: [], raw: src, opaque: true }];
  if (depth > MAX_DEPTH) return opaque();

  const { segments, unbalanced } = splitTopLevel(src);
  if (unbalanced) return opaque();

  const out: SimpleCommand[] = [];
  for (const seg of segments) {
    const { outer, inner } = extractSubstitutions(seg);
    for (const sub of inner) out.push(...decomposeShell(sub, depth + 1));

    const tokens = stripPrefixes(tokenize(outer));
    if (tokens.length === 0) continue; // pure substitution/subshell — inner already handled
    const program = basename(tokens[0]);
    const argv = tokens.slice(1);
    out.push({ program, programRaw: tokens[0], argv, raw: seg, opaque: false });

    if (SHELLS.has(program)) {
      const script = shellScriptArg(argv);
      if (script) out.push(...decomposeShell(script, depth + 1));
    }
  }
  return out.length ? out : opaque();
}

/** Parse a `git … push …` simple command into git.push params, or null if it is
 *  not a push. Handles global options that take an argument (`-C dir`, `-c k=v`),
 *  `--force`/`-f`/`--force-with-lease`, and a leading `+` force refspec. */
export function parseGitPush(cmd: SimpleCommand): { force: boolean; remote?: string; ref?: string } | null {
  if (cmd.program !== "git") return null;
  const a = cmd.argv;
  let i = 0;
  while (i < a.length) {
    const t = a[i];
    if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "--namespace") { i += 2; continue; }
    if (t.startsWith("-")) { i++; continue; }
    break;
  }
  if (a[i] !== "push") return null;
  const rest = a.slice(i + 1);
  let force = false;
  const positional: string[] = [];
  for (const t of rest) {
    if (t === "--force" || t === "-f" || t === "--force-with-lease" || t.startsWith("--force-with-lease=")) { force = true; continue; }
    if (t.startsWith("-")) continue;
    positional.push(t);
  }
  const params: { force: boolean; remote?: string; ref?: string } = { force };
  if (positional[0]) params.remote = positional[0];
  if (positional[1]) {
    let refspec = positional[1];
    if (refspec.startsWith("+")) { force = true; params.force = true; refspec = refspec.slice(1); }
    params.ref = refspec.replace(/^[^:]*:\+?/, ""); // src:dst → dst
  }
  return params;
}
