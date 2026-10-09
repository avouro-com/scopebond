// Value scrubbing for evidence: credential shapes inside string values are removed before a receipt is signed and
// exported. Key-name minimization (receipts.ts) catches a value under `authorization` or `password`; this catches the
// same secret when it sits inside an ordinary value: a token in a URL query, a password literal in SQL, a Bearer header
// in a shell command, a key in an `export NAME=value`.
//
// The rules are the hook's structured-parameter rules (its `scrubParam`) plus URL query and SQL password shapes. Generic
// high-entropy blobs are deliberately not matched: a commit id or a content hash in a parameter is not a secret, and a
// policy may match on it. Every pattern is a single pass over simple character classes, so matching stays linear in the
// value's length. Pure string work: no Node built-ins, so it runs wherever the gateway does. Shell shapes with no label
// to key on (PowerShell's ways of setting a secret, a value piped into a secret reader, `$token = '…'`) are read by
// `scrubShellSecrets` (shell-secrets.ts, the same scanner the hook's command scrubber uses).

import { scrubShellSecrets } from "./shell-secrets.js";

const MASK = "***";
// A flag or header value: a quoted string or a run of non-whitespace.
const VALUE = String.raw`("[^"]*"|'[^']*'|\S+)`;
const NAME_WORDS = String.raw`(?:token|secret|passw(?:or)?d|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|auth|credentials?|session|signature)`;

// Each rule states its own replacement. `$1` keeps a non-secret label (a flag, header or parameter name); the secret
// itself is always dropped whole. Over-scrubbing is safe.
// A URL query parameter whose name looks like a credential (`?api_token=…`, `&X-Amz-Signature=…`). One regex
// (`[?&;][\w.-]*NAME[\w.-]*=`) retried the tail of a long name once per credential word inside it (quadratic), so the
// name is found first and checked on its own. A parameter that is not a credential is stepped over at its "=", so a
// separator inside its value (`?a=x;token=y`) still starts the next check.
const QUERY_NAME = /[?&;][\w.-]*=/g;
const QUERY_VALUE = /[^&#\s"']+/y;
// eslint-disable-next-line security/detect-non-literal-regexp -- built from the NAME_WORDS constant only
const CREDENTIAL_NAME = new RegExp(NAME_WORDS, "i");

function scrubQueryParameters(text: string): string {
  let out = "";
  let copied = 0;
  QUERY_NAME.lastIndex = 0;
  for (let m = QUERY_NAME.exec(text); m; m = QUERY_NAME.exec(text)) {
    if (!CREDENTIAL_NAME.test(m[0])) continue;
    QUERY_VALUE.lastIndex = QUERY_NAME.lastIndex;
    const value = QUERY_VALUE.exec(text);
    if (!value) continue;
    out += text.slice(copied, QUERY_NAME.lastIndex) + MASK;
    copied = QUERY_NAME.lastIndex = QUERY_VALUE.lastIndex;
  }
  return out + text.slice(copied);
}

// Each entry is a [pattern, replacement] pair or a function. The two `new RegExp` sources are built only from the
// constants above, never from input.
const SECRET_RULES: ReadonlyArray<readonly [RegExp, string] | ((text: string) => string)> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from the VALUE constant only
  [new RegExp(String.raw`(--?(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|auth|credentials?)[=\s]+)${VALUE}`, "gi"), `$1${MASK}`],
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from the VALUE constant only
  [new RegExp(String.raw`((?:^|\s)(?:-u|--user)[=\s]+)${VALUE}`, "g"), `$1${MASK}`],
  [/(Authorization:\s*(?:Bearer|Basic|Token)\s+)[^\s"']+/gi, `$1${MASK}`],
  [/((?:x-api-key|api-key|x-auth-token|x-access-token|private-token)\s*:\s*)[^\s"']+/gi, `$1${MASK}`],
  // URL userinfo, to the last "@" before the host as a URL parser splits it (a password may hold an "@"); the authority
  // ends at "/", "?" or "#", so an "@" in a path or query is left alone. Linear: the run after each "://" stops at "/".
  [/(:\/\/)[^\s/?#]*@/g, `$1${MASK}@`],
  scrubQueryParameters,
  // A password literal in SQL (`PASSWORD 'x'`, `IDENTIFIED BY "x"`, `PASSWORD = 'x'`). `\s*(?:=\s*)?`, not `\s*=?\s*`:
  // two adjacent whitespace runs split a long run of spaces every possible way (quadratic). A quote that a blank or a separator
  // follows opens no literal: it closes an earlier string (`grep "password " src/ && echo "x"`), and the text after it stays.
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: the inner \s* follows a literal "=", so the two runs cannot trade characters (tested on 50k input)
  [/(\b(?:password|identified\s+by)\s*(?:=\s*)?)('(?![\s;&|)])[^']*'|"(?![\s;&|)])[^"]*")/gi, `$1'${MASK}'`],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],                           // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],                         // GitHub fine-grained tokens
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],                             // GitLab tokens
  [/\bnpm_[A-Za-z0-9]{20,}/g, MASK],                                 // npm tokens
  [/\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g, MASK],                       // Slack tokens
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, MASK],                 // Stripe keys
  [/\bsk-[A-Za-z0-9_-]{20,}/g, MASK],                                // sk- style API keys
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],                               // Google API keys
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],                          // AWS access key ids
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK], // JWTs
];

const SECRET_NAME = /token|secret|passw|pwd|api_?key|access_?key|private_?key|auth|credential|session/i;
const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i;

// `NAME=value` where the name looks like a credential (`GH_TOKEN=…`, `export AWS_SECRET_ACCESS_KEY=…`). Done per
// whitespace-delimited word rather than with one regex so a long identifier cannot cause backtracking. A word that starts
// as a URL is left to the query and userinfo rules above, which keep the rest of the URL.
function scrubAssignments(text: string): string {
  return text.replace(/\S+/g, (word) => {
    if (URL_START.test(word)) return word;
    const eq = word.indexOf("=");
    if (eq <= 0 || eq === word.length - 1) return word;
    const name = word.slice(0, eq);
    if (name.startsWith("-") || !SECRET_NAME.test(name)) return word; // flags are handled by SECRET_RULES
    return `${name}=${MASK}`;
  });
}

/** Scrub credential shapes from one string value. Ordinary text (paths, refs, commit ids, plain URLs) is unchanged. */
export function scrubSecretText(text: string): string {
  let out = scrubAssignments(scrubShellSecrets(text));
  for (const rule of SECRET_RULES) out = typeof rule === "function" ? rule(out) : out.replace(rule[0], rule[1]);
  return out;
}
