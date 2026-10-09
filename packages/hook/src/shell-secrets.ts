// Credential shapes in shell commands that carry no label a fixed pattern can key on: PowerShell's ways of setting a
// secret (an environment variable through the Env: drive, .NET or setx; a variable or hashtable entry; a plain-text
// secure string), a value piped into a program that reads a secret from standard input, and a credential-named
// assignment written with spaces or a quoted value (`$token = '…'`, `client_secret = '…'`, `password="a b"`).
// Used by the gateway's value scrubbing and the hook's command scrubber. Each package ships its own copy of this file so
// either can be released alone; the two copies are kept identical (the hook's tests compare them).
//
// Every function is a forward scan: its regular expressions are anchored at the scan position over simple character
// classes, and the scan resumes past what it read, so the time stays linear in the text's length (a pattern such as
// `[\w:]*\s*=\s*VALUE` would retry every suffix of a long name). A secret is replaced whole; over-scrubbing is safe.
// Pure string work: no Node built-ins, so it runs wherever the gateway does.

const MASK = "***";

const SECRET_WORD = /token|secret|passw|pwd|api_?key|access_?key|private_?key|auth|credential|session/i;
// Short password names (`DB_PASS`, `PASS`, `DB_PW`) and anything ending in KEY (`SERVICE_KEY`, `X-Api-Key`).
const SHORT_SECRET_WORD = /(?:^|[_$:.-])(?:pass|pw)(?:_|$)|key$/i;
const CAMEL_HUMP = /([a-z0-9])([A-Z])/g;

/** Whether a variable, parameter or header name looks like it holds a credential. A camelCase part counts as a word
 *  (`DbPass` reads as `Db_Pass`). */
export function isCredentialName(name: string): boolean {
  return SECRET_WORD.test(name) || SHORT_SECRET_WORD.test(name.replace(CAMEL_HUMP, "$1_$2"));
}

const isQuote = (c: string | undefined): c is "'" | '"' => c === "'" || c === '"';

/** The first position at or after `i` that is not a space or tab. */
function skipBlanks(text: string, i: number): number {
  while (text[i] === " " || text[i] === "\t") i++;
  return i;
}

/** A value's replacement: a quoted literal keeps its quotes, anything else becomes the mask alone. */
function masked(value: string): string {
  const q = value[0];
  return value.length >= 2 && isQuote(q) && value[value.length - 1] === q ? `${q}${MASK}${q}` : MASK;
}

const unquote = (word: string): string => (word.length >= 2 && isQuote(word[0]) && word[word.length - 1] === word[0] ? word.slice(1, -1) : word);

// ---- simple commands as words ------------------------------------------------------------------------------------------

interface Command { words: string[]; starts: number[]; piped: boolean }

/** The simple commands of `text`, split at an unquoted `;`, `|`, `&` or line end (`2>&1`, `&>` and `>|` are redirections,
 *  not separators), including inside a `( … )` group. A word runs to the next blank, bracket or separator, so a group's
 *  words read as the hook records the group (on its own); a quote inside a word runs to its closing quote, or to the end
 *  of the text when it has none. `piped` marks a command whose output the next one reads. */
function splitCommands(text: string): Command[] {
  const out: Command[] = [];
  let current: Command = { words: [], starts: [], piped: false };
  let start = -1;
  const endWord = (i: number): void => {
    if (start < 0) return;
    current.words.push(text.slice(start, i));
    current.starts.push(start);
    start = -1;
  };
  const endCommand = (piped: boolean): void => {
    if (current.words.length) { current.piped = piped; out.push(current); }
    current = { words: [], starts: [], piped: false };
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (isQuote(c)) {
      if (start < 0) start = i;
      const close = text.indexOf(c, i + 1);
      i = close < 0 ? text.length - 1 : close;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "(" || c === ")") { endWord(i); continue; }
    const prev = text[i - 1];
    const next = text[i + 1];
    const redirection = (c === "&" && (next === ">" || prev === ">" || prev === "<")) || (c === "|" && prev === ">");
    if (!redirection && (c === ";" || c === "\n" || c === "&" || c === "|")) {
      endWord(i);
      endCommand(c === "|" && next !== "|" && prev !== "|");
      continue;
    }
    if (start < 0) start = i;
  }
  endWord(text.length);
  endCommand(false);
  return out;
}

const VARIABLE = /^\$[\w:]+$/;
const PUNCTUATION = /^[()[\]{},;=$@]+$/;
const LEADING_CALL = /^[(@$&.]+/;
const PATH_PREFIX = /^.*[\\/]/;
const LEADING_SLASHES = /^[\\/]+/;

/** Where a command's program sits: after a leading `$x =` / `[type]$x =` assignment, else first. */
const programIndex = (words: string[]): number => (words.length > 2 && (words[0][0] === "$" || words[0][0] === "[") && words[1] === "=" ? 2 : 0);
const programName = (word: string | undefined): string => (word ?? "").replace(LEADING_CALL, "").replace(PATH_PREFIX, "").toLowerCase();

/** Whether a word can hold a value: not a variable, bracket or `=` alone, and not a switch (unless it carries its value
 *  after a colon and `switchValue` accepts the switch). */
function holdsValue(word: string, switchValue: (name: string) => boolean): boolean {
  if (VARIABLE.test(word) || PUNCTUATION.test(word)) return false;
  if (word[0] !== "-") return true;
  const colon = word.indexOf(":");
  return colon > 0 && colon < word.length - 1 && switchValue(word.slice(1, colon).toLowerCase());
}

/** A masked word: a `-Switch:value` keeps its switch, anything else is replaced whole. */
function maskWord(word: string): string {
  if (word[0] === "-") {
    const colon = word.indexOf(":");
    if (colon > 0) return word.slice(0, colon + 1) + masked(word.slice(colon + 1));
  }
  return masked(word);
}

const never = (): boolean => false;
const SECURE_STRING_VALUE = (name: string): boolean => name.startsWith("s") || name.startsWith("k"); // -String, -SecureKey, -Key
const ITEM_VALUE = (name: string): boolean => name.startsWith("v"); // -Value
const ENV_SETTERS = new Set(["set-item", "si", "new-item", "ni", "set-content", "sc", "add-content", "ac"]);
const SETX_SWITCHES_WITH_ARGUMENT = new Set(["s", "u", "p", "k", "f", "a", "r", "d"]);

/** The words of one command that hold a secret, by index. */
function secretWords(command: Command): Set<number> {
  const { words } = command;
  const hide = new Set<number>();
  const program = programIndex(words);
  const name = programName(words[program]);

  // ConvertTo-SecureString: its string (`-String`, `-String:`, or the first positional) and key, in any order.
  const secure = words.findIndex((w) => programName(w) === "convertto-securestring");
  if (secure >= 0) for (let k = secure + 1; k < words.length; k++) if (holdsValue(words[k], SECURE_STRING_VALUE)) hide.add(k);

  // An environment variable set through the Env: drive: `Set-Item Env:DB_PASSWORD 'x'`, `-Path Env:… -Value 'x'`,
  // `New-Item -Path Env: -Name API_TOKEN -Value 'x'`. Every value the setter is given goes, wherever it sits.
  if (ENV_SETTERS.has(name)) {
    let path = -1;
    let variable = "";
    let label = -1;
    for (let k = program + 1; k < words.length; k++) {
      const word = unquote(words[k]);
      const lower = word.toLowerCase();
      if (path < 0 && lower.startsWith("env:")) { path = k; variable ||= word.slice(4).replace(LEADING_SLASHES, ""); }
      else if (lower === "-name" && k + 1 < words.length) { label = k + 1; variable = unquote(words[k + 1]); }
      else if (lower.startsWith("-name:")) variable = word.slice(6);
    }
    if (path >= 0 && isCredentialName(variable)) {
      for (let k = program + 1; k < words.length; k++) if (k !== path && k !== label && holdsValue(words[k], ITEM_VALUE)) hide.add(k);
    }
  }

  // cmd's setx: `setx DB_PASSWORD value`, `setx /M NAME value`, and the remote password after `/P`.
  if (name === "setx" || name === "setx.exe") {
    let positional = 0;
    let variable = "";
    for (let k = program + 1; k < words.length; k++) {
      const word = words[k];
      if (word[0] === "/" || word[0] === "-") {
        const flag = word.slice(1).toLowerCase();
        if (SETX_SWITCHES_WITH_ARGUMENT.has(flag)) { if (flag === "p" && k + 1 < words.length) hide.add(k + 1); k++; }
        continue;
      }
      if (positional === 0) variable = unquote(word);
      else if (positional === 1 && isCredentialName(variable)) hide.add(k);
      positional++;
    }
  }
  return hide;
}

/** Whether a command reads a secret from standard input: `ConvertTo-SecureString`, `… login --password-stdin`. */
const readsSecret = (command: Command): boolean => command.words.some((w) => w === "--password-stdin" || programName(w) === "convertto-securestring");

/** The words of a command piped into a reader of secrets that may be the secret: every literal but its program. */
function pipedWords(command: Command): Set<number> {
  const hide = new Set<number>();
  const program = programIndex(command.words);
  command.words.forEach((word, k) => {
    if (k === program && !isQuote(word[0])) return;
    if (holdsValue(word, never)) hide.add(k);
  });
  return hide;
}

/** Rebuild `text` with the chosen words of each command masked. */
function rebuild(text: string, commands: Command[], chosen: Array<Set<number>>): string {
  let out = "";
  let copied = 0;
  commands.forEach((command, c) => {
    for (const k of [...chosen[c]].sort((a, b) => a - b)) {
      const start = command.starts[k];
      out += text.slice(copied, start) + maskWord(command.words[k]);
      copied = start + command.words[k].length;
    }
  });
  return out + text.slice(copied);
}

/** A command piped into a program that reads a secret from standard input, and the literals in it that may be the secret. */
export interface PipedSecret {
  /** The command's words, each between NULs, so a part of it is found as a substring. */
  words: string;
  /** The literals, each as written and without its quotes. */
  hide: ReadonlySet<string>;
}
const SEPARATOR = "\u0000";
const joinWords = (words: readonly string[]): string => SEPARATOR + words.join(SEPARATOR) + SEPARATOR;

/** Literals a command pipes into a program that reads a secret from standard input (`'pw' | ConvertTo-SecureString
 *  -AsPlainText`, `echo pw | docker login --password-stdin`), with the command they sit in. The literal is in the simple
 *  command before the pipe, which does not show it is a secret on its own: a caller that records each simple command apart
 *  masks these words in that command, or in a part of it it records apart (a group's inside), see `maskWords`. */
export function pipedSecrets(text: string): PipedSecret[] {
  const found: PipedSecret[] = [];
  const commands = splitCommands(text);
  commands.forEach((command, c) => {
    if (!command.piped || !commands[c + 1] || !readsSecret(commands[c + 1])) return;
    const hide = new Set<string>();
    for (const k of pipedWords(command)) {
      hide.add(command.words[k]);
      const bare = unquote(command.words[k]);
      if (bare) hide.add(bare);
    }
    if (hide.size) found.push({ words: joinWords(command.words), hide });
  });
  return found;
}

/** `text` with the piped literals masked in each command of it that is a piped command, or a run of its words. Another
 *  command that happens to use the same word (`… && rm token.txt`) keeps it. */
export function maskWords(text: string, piped: readonly PipedSecret[]): string {
  if (!piped.length) return text;
  const commands = splitCommands(text);
  return rebuild(text, commands, commands.map((command) => {
    const own = joinWords(command.words);
    const hide = new Set<number>();
    for (const p of piped) if (p.words.includes(own)) command.words.forEach((word, k) => { if (p.hide.has(word)) hide.add(k); });
    return hide;
  }));
}

function scrubCommands(text: string): string {
  const commands = splitCommands(text);
  const chosen = commands.map(secretWords);
  commands.forEach((command, c) => {
    if (command.piped && commands[c + 1] && readsSecret(commands[c + 1])) for (const k of pipedWords(command)) chosen[c].add(k);
  });
  return chosen.some((s) => s.size) ? rebuild(text, commands, chosen) : text;
}

// ---- quoted values ------------------------------------------------------------------------------------------------------

// After a quote, a character that ends a word: the quote closed a string rather than opened a value.
const ENDS_WORD = /[\s;&|)}\],]/;
const WORD_CHARACTER = /\w/;
const QUOTED_WORD_REST = /[^\s;,)}|&]*/y;

/** The value that starts with the quote at `at`: where it ends and whether its closing quote is there. A value is the quoted
 *  string when its closing quote ends the word (`'x'`, `"a b"`, `'x')`); with no closing quote, or one a letter follows (the
 *  quote that opens a later string: `-m "token = " -m "x"`), only the rest of the word the quote starts is the value. Null
 *  when the quote opens nothing: a blank, a separator or the end of the text follows it, so it closed an earlier string
 *  (`grep "password = " src/`), and no value follows. Only the secret is masked, never the rest of the command. */
function quotedValue(text: string, at: number): { end: number; closed: boolean } | null {
  const q = text[at];
  const next = text[at + 1];
  if (next === undefined || ENDS_WORD.test(next)) return null;
  const close = text.indexOf(q, at + 1);
  if (close >= 0 && !WORD_CHARACTER.test(text[close + 1] ?? "")) return { end: close + 1, closed: true };
  QUOTED_WORD_REST.lastIndex = at + 1;
  QUOTED_WORD_REST.exec(text);
  return QUOTED_WORD_REST.lastIndex > at + 1 ? { end: QUOTED_WORD_REST.lastIndex, closed: false } : null;
}

// ---- 'NAME', value -----------------------------------------------------------------------------------------------------

// A credential name given as a string argument and followed by its value: `[Environment]::SetEnvironmentVariable(
// 'DB_PASSWORD', 'x', 'User')` (also as the hook records the call's argument list on its own), `os.environ.setdefault(
// "API_KEY", "x")`, `$headers.Add("Authorization", "Bearer x")`, `['--token', 'x']`.
const NAME_ARGUMENT = /^[\w.:-]{1,128}$/;
const BARE_ARGUMENT = /[^\s,)\]}]+/y;

function scrubNamedArguments(text: string): string {
  let out = "";
  let copied = 0;
  for (let i = 0; i < text.length; i++) {
    const q = text[i];
    if (!isQuote(q)) continue;
    const close = text.indexOf(q, i + 1);
    if (close < 0) break;
    const name = text.slice(i + 1, close);
    i = close; // a string is read once; the scan goes on after it
    if (!NAME_ARGUMENT.test(name) || !isCredentialName(name)) continue;
    const comma = skipBlanks(text, close + 1);
    if (text[comma] !== ",") continue;
    const at = skipBlanks(text, comma + 1);
    let end: number;
    if (isQuote(text[at])) {
      const value = quotedValue(text, at);
      if (!value) continue;
      end = value.end;
    } else {
      BARE_ARGUMENT.lastIndex = at;
      if (!BARE_ARGUMENT.exec(text)) continue;
      end = BARE_ARGUMENT.lastIndex;
    }
    out += text.slice(copied, at) + masked(text.slice(at, end));
    copied = end;
    i = end - 1;
  }
  return out + text.slice(copied);
}

// ---- NAME = 'value' -----------------------------------------------------------------------------------------------------

// A name, then an optional closing quote (`'X-Api-Key' = …`) and "=" with optional blanks. Read one name run at a time.
const NAME_RUN = /[\w:.-]+/g;
const BARE_VALUE = /[^\s;,)}|&]+/y;
const ENTRY_VALUE = /[^;}&|#\n]+/y;

/** A credential-named assignment written with blanks around "=" or a quoted value: a PowerShell variable (`$token =
 *  '…'`, `$env:DB_PASSWORD = "…"`), a hashtable entry (`@{ Authorization = 'Bearer …' }`), a keyword argument
 *  (`password="a b"`), an INI line (`password = hunter2`); and a hashtable entry read without its quotes
 *  (`@{Authorization=Bearer x}`), to the entry's end. `NAME=value` otherwise is left to the callers' word rule, which
 *  masks the value alone: after a `;` outside a hashtable (`cd x;API_KEY=abc ./deploy.sh`) the program that follows stays. */
function scrubSpacedAssignments(text: string): string {
  let out = "";
  let copied = 0;
  // How many hashtables (`@{`) are open where the scan has read to, so a `;` is read as an entry's start only inside one.
  let tables = 0;
  let read = 0;
  NAME_RUN.lastIndex = 0;
  for (let run = NAME_RUN.exec(text); run; run = NAME_RUN.exec(text)) {
    for (; read < run.index; read++) {
      if (text[read] === "{") { if (tables > 0 || text[read - 1] === "@") tables++; }
      else if (text[read] === "}" && tables > 0) tables--;
    }
    let after = run.index + run[0].length;
    if (isQuote(text[after])) after++;
    const equals = skipBlanks(text, after);
    if (text[equals] !== "=") continue;
    const at = skipBlanks(text, equals + 1);
    const first = text[at];
    if (first === undefined || first === "=" || first === ">" || first === "~" || first === "$") continue; // ==, =>, =~, a variable
    const spaced = equals > after || at > equals + 1;
    const entry = !spaced && (text[run.index - 1] === "{" || (text[run.index - 1] === ";" && tables > 0));
    // The name is checked before the value is read, so a value is only ever read to be masked and skipped.
    if ((!spaced && !entry && !isQuote(first) && first !== "@") || !isCredentialName(run[0])) continue;
    let end: number;
    let replacement: string;
    if (isQuote(first)) {
      const value = quotedValue(text, at);
      if (!value) continue;
      end = value.end;
      replacement = value.closed ? first + MASK + first : first + MASK;
    } else if (first === "@" && isQuote(text[at + 1])) {
      const close = text.indexOf(text[at + 1] + "@", at + 2); // a here-string
      end = close < 0 ? text.length : close + 2;
      replacement = close < 0 ? `@${text[at + 1]}${MASK}` : `@${text[at + 1]}${MASK}${text[at + 1]}@`;
    } else {
      const value = entry ? ENTRY_VALUE : BARE_VALUE;
      value.lastIndex = at;
      if (!value.exec(text)) continue;
      end = value.lastIndex;
      replacement = MASK;
    }
    out += text.slice(copied, at) + replacement;
    copied = end;
    NAME_RUN.lastIndex = end;
  }
  return out + text.slice(copied);
}

/** Remove the shell credential shapes above from `text`. Ordinary commands come back unchanged. */
export function scrubShellSecrets(text: string): string {
  return scrubSpacedAssignments(scrubNamedArguments(scrubCommands(text)));
}
