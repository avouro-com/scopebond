// Value scrubbing for evidence: credential shapes inside string values are removed before a receipt is signed and
// exported. Key-name minimization (receipts.ts) catches a value under `authorization` or `password`; this catches the
// same secret when it sits inside an ordinary value: a token in a URL query, a password literal in SQL, a Bearer header
// in a shell command, a key in an `export NAME=value`.
//
// The rules are the hook's structured-parameter rules (its `scrubParam`) plus URL query and SQL password shapes. Generic
// high-entropy blobs are deliberately not matched: a commit id or a content hash in a parameter is not a secret, and a
// policy may match on it. Every pattern is a single pass over simple character classes, so matching stays linear in the
// value's length. Pure string work: no Node built-ins, so it runs wherever the gateway does.

const MASK = "***";
// A flag or header value: a quoted string or a run of non-whitespace.
const VALUE = String.raw`("[^"]*"|'[^']*'|\S+)`;
const NAME_WORDS = String.raw`(?:token|secret|passw(?:or)?d|pwd|api[-_]?key|apikey|access[-_]?key|private[-_]?key|auth|credentials?|session|signature)`;

// Each rule states its own replacement. `$1` keeps a non-secret label (a flag, header or parameter name); the secret
// itself is always dropped whole. Over-scrubbing is safe.
const SECRET_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [new RegExp(String.raw`(--?(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|auth|credentials?)[=\s]+)${VALUE}`, "gi"), `$1${MASK}`],
  [new RegExp(String.raw`((?:^|\s)(?:-u|--user)[=\s]+)${VALUE}`, "g"), `$1${MASK}`],
  [/(Authorization:\s*(?:Bearer|Basic|Token)\s+)[^\s"']+/gi, `$1${MASK}`],
  [/((?:x-api-key|api-key|x-auth-token|x-access-token|private-token)\s*:\s*)[^\s"']+/gi, `$1${MASK}`],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${MASK}@`],                     // URL userinfo
  // A URL query parameter whose name looks like a credential (`?api_token=…`, `&X-Amz-Signature=…`).
  [new RegExp(String.raw`([?&;][\w.-]*${NAME_WORDS}[\w.-]*=)[^&#\s"']+`, "gi"), `$1${MASK}`],
  // A password literal in SQL (`PASSWORD 'x'`, `IDENTIFIED BY "x"`, `PASSWORD = 'x'`).
  [/(\b(?:password|identified\s+by)\s*=?\s*)('[^']*'|"[^"]*")/gi, `$1'${MASK}'`],
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
  let out = scrubAssignments(text);
  for (const [re, replacement] of SECRET_RULES) out = out.replace(re, replacement);
  return out;
}
