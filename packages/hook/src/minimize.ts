// Data minimization for the hook: file contents are never stored, shell commands
// are reduced to a scrubbed head plus a digest, and common secret shapes are
// removed before anything is written or signed.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { loadOrCreateHexKey } from "./safe-fs.js";
import { join } from "node:path";
import { canonical } from "@scopebond/policy-schema/canonical";
import { isCredentialName, scrubShellSecrets } from "@scopebond/gateway";

/** A plain SHA-256 content hash, for values that are not secret. */
export const sha256 = (value: string): string => "sha256:" + createHash("sha256").update(value).digest("hex");

// Digests of what an agent ran — a scrubbed shell command, an MCP tool's arguments — are
// keyed. The scrubber cannot recognise every secret, and a plain hash of a command whose
// head is shown beside it leaves only the unseen remainder to guess: a short password the
// scrubber missed could be recovered offline by anyone holding the receipt. Keyed with a
// per-machine secret that never leaves `.scopebond/`, the digest still tells two identical
// actions on this machine apart from different ones, but cannot be tested against guesses.
let digestKey: Buffer | null = null;

/** Set the key for keyed digests (32 random bytes, hex). Without one, a random key for
 *  this process is used — safe, but digests then compare only within the process. */
export function useDigestKey(key: string | null): void {
  digestKey = key ? Buffer.from(key, "hex") : null;
}

/** The per-machine digest key in a config dir, created on first use. */
export function loadOrCreateDigestKey(dir: string): string {
  return loadOrCreateHexKey(join(dir, "digest.key"));
}

/** HMAC-SHA-256 under the digest key, labelled so it is never mistaken for a plain hash. */
export const keyedDigest = (value: string): string =>
  "hmac-sha256:" + createHmac("sha256", (digestKey ??= randomBytes(32))).update(value).digest("hex");
export const digest = (value: unknown): string => keyedDigest(canonical(value));

const MASK = "***";
// A flag or header value: a quoted string or a run of non-whitespace.
const VALUE = String.raw`("[^"]*"|'[^']*'|\S+)`;

// Each rule states its own replacement. `$1` keeps a non-secret label (a flag or
// header name); the secret itself is always dropped whole. Over-scrubbing is safe.
// Every pattern is a single pass over simple character classes (no nested
// quantifiers), so matching stays linear in the command length.
const SECRET_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // eslint-disable-next-line security/detect-non-literal-regexp -- a constant pattern built from literals (VALUE); no input reaches the source
  [new RegExp(String.raw`(--?(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|auth|credentials?|key|[a-z]+-key|[a-z]+-secret|[a-z]+-password)[=\s]+)${VALUE}`, "gi"), `$1${MASK}`],
  // eslint-disable-next-line security/detect-non-literal-regexp -- a constant pattern built from literals (VALUE); no input reaches the source
  [new RegExp(String.raw`((?:^|\s)(?:-u|--user)[=\s]+)${VALUE}`, "g"), `$1${MASK}`],
  [/(Authorization:\s*(?:Bearer|Basic|Token)\s+)[^\s"']+/gi, `$1${MASK}`],
  [/((?:x-api-key|api-key|x-auth-token|x-access-token|private-token)\s*:\s*)[^\s"']+/gi, `$1${MASK}`],
  // Any URL userinfo: user:password@, a token alone (an Azure DevOps or GitHub token as the user), or :password@. It runs
  // to the last "@" before the host, as a URL parser splits it (a password may hold an "@"); the authority ends at "/",
  // "?" or "#", so an "@" in a path or query is left alone. Linear: the run after each "://" stops at "/".
  [/(:\/\/)[^\s/?#]*@/g, `$1${MASK}@`],
  // A credential in a URL query (an Azure SAS signature, an OAuth token or code).
  [/([?&](?:sig|signature|sas|token|access_token|refresh_token|id_token|key|api_?key|code|password|secret|client_secret)=)[^&\s"'#]+/gi, `$1${MASK}`],
  // Cookies: the header's value runs to the end of the quoted string; curl's -b/--cookie takes one value.
  [/(\bCookie:\s*)[^"'\n]+/gi, `$1${MASK}`],
  // eslint-disable-next-line security/detect-non-literal-regexp -- a constant pattern built from literals (VALUE); no input reaches the source
  [new RegExp(String.raw`((?:^|\s)(?:-b|--cookie)[=\s]+)${VALUE}`, "g"), `$1${MASK}`],
  // PowerShell's secret shapes (a plain-text secure string, `$env:NAME = "value"`, `Set-Item Env:…`, `$token = '…'`) are
  // read by `scrubShellSecrets` (the gateway's shell-secrets.ts), in `scrubParam` below.
  [/(\bhv[sb]\.)[A-Za-z0-9_-]{20,}/g, `$1${MASK}`],                  // Vault tokens
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, MASK],          // SendGrid keys
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],                           // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],                         // GitHub fine-grained tokens
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],                             // GitLab tokens
  [/\bnpm_[A-Za-z0-9]{20,}/g, MASK],                                 // npm tokens
  [/\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g, MASK],                       // Slack tokens
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, MASK],                 // Stripe keys
  [/\bsk-[A-Za-z0-9_-]{20,}/g, MASK],                                // OpenAI/Anthropic-style keys
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],                               // Google API keys
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],                          // AWS access key ids
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK], // JWTs
];

// Free-text-only rules (the command head), never applied to structured parameters a
// policy matches on. These cover common shapes that carry a secret on argv without a
// recognizable token format:
//  - an attached `-p`/`-u` value (`mysql -phunter2`, `psql -uadmin`) — the single most
//    common way a password reaches a shell. A space-separated `-p value` (the mkdir
//    flag, or `-u origin`) is not attached and is left alone; the `--password`/`--user`
//    forms are handled by the labelled rules above.
//  - a header whose name looks like a credential (`X-Custom-Secret: …`, `My-Token: …`).
//    Bare `key:` is deliberately excluded so ordinary `key: value` text is untouched.
const HEAD_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\s)(-[pu])[^\s=-]\S*/g, `$1$2${MASK}`],
];

// A space-separated `-p <password>` after a program whose -p is a password (it is a port or a parent flag elsewhere),
// within the same simple command. Read with a scan rather than one pattern: as
// `\b(?:sshpass|…)\b[^|;&\n]*?\s-p\s+VALUE` every mention of such a program rescanned the rest of its command, quadratic
// in a command that names one many times. A mention whose command holds no such flag means no later mention in the same
// command can have one either, so the scan moves to the command's end.
const PASSWORD_PROGRAM = /\b(?:sshpass|login|mysql|mysqladmin|mariadb|htpasswd|redis-cli)\b/g;
const COMMAND_END = /[|;&\n]/g;
// eslint-disable-next-line security/detect-non-literal-regexp -- a constant pattern built from literals (VALUE); no input reaches the source
const SPACED_PASSWORD = new RegExp(String.raw`\s-p\s+${VALUE}`, "y");
function scrubSpacedPasswords(text: string): string {
  let out = "";
  let last = 0;
  PASSWORD_PROGRAM.lastIndex = 0;
  for (let program = PASSWORD_PROGRAM.exec(text); program; program = PASSWORD_PROGRAM.exec(text)) {
    const from = program.index + program[0].length;
    COMMAND_END.lastIndex = from;
    const end = COMMAND_END.exec(text)?.index ?? text.length;
    let found = false;
    // The flag's leading blank may be the line end that closes the command.
    for (let q = from; q <= end && q < text.length; q++) {
      if (text[q + 1] !== "-" || text[q + 2] !== "p" || !/\s/.test(text[q])) continue;
      SPACED_PASSWORD.lastIndex = q;
      const flag = SPACED_PASSWORD.exec(text);
      if (!flag) continue;
      const after = q + flag[0].length;
      out += text.slice(last, after - flag[1].length) + MASK;
      last = after;
      PASSWORD_PROGRAM.lastIndex = after;
      found = true;
      break;
    }
    if (!found) PASSWORD_PROGRAM.lastIndex = Math.max(PASSWORD_PROGRAM.lastIndex, end);
  }
  return out + text.slice(last);
}

// A header whose name looks like a credential (`X-Custom-Secret: …`, `My-Token: …`); its value is masked. `auth` is
// omitted: `Authorization:` is handled above (with its Bearer/Basic label), and other auth headers (`X-Auth-Token`)
// still match on `token`. Read one run of name characters at a time: as `\b[\w-]*(?:secret|…)[\w-]*\s*:\s*` a long
// hyphenated run (`secret-secret-…`) backtracked cubically. The name is the whole run from its first word character
// (a header value must follow the run directly), so it qualifies when the run holds one of the words anywhere.
const NAME_RUN = /[\w-]+/g;
const SECRET_HEADER_WORD = /secret|token|api[-_]?key|apikey|password|passwd|credential/i;
const HEADER_VALUE = /(\s*:\s*)[^\s"']+/y;
function scrubSecretHeaders(text: string): string {
  let out = "";
  let last = 0;
  NAME_RUN.lastIndex = 0;
  for (let run = NAME_RUN.exec(text); run; run = NAME_RUN.exec(text)) {
    const end = run.index + run[0].length;
    HEADER_VALUE.lastIndex = end;
    const value = HEADER_VALUE.exec(text);
    if (!value || !SECRET_HEADER_WORD.test(run[0])) continue;
    out += text.slice(last, end) + value[1] + MASK;
    last = end + value[0].length;
    NAME_RUN.lastIndex = last;
  }
  return out + text.slice(last);
}

// Generic high-entropy shapes. Applied to free text only (the command head), never to
// structured parameters a policy matches on: a long path or a commit id is not a secret.
const BLOB_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Fa-f0-9]{32,}\b/g, MASK],                                   // long hex blobs
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, MASK],                             // long base64/base64url blobs
];

// `NAME=value` where the name looks like a credential (`GH_TOKEN=…`, `export
// AWS_SECRET_ACCESS_KEY=…`, `DB_PASS=…`, `SERVICE_KEY=…`). Done per whitespace-delimited word rather than with
// one regex so a long identifier cannot cause backtracking. A spaced or quoted assignment (`$env:NAME = "value"`,
// `$token = '…'`, `password="a b"`) is read before this by `scrubShellSecrets`.
function scrubAssignments(text: string): string {
  return text.replace(/\S+/g, (word) => {
    const eq = word.indexOf("=");
    if (eq <= 0 || eq === word.length - 1) return word;
    const name = word.slice(0, eq);
    if (name.startsWith("-") || !isCredentialName(name.replace(/^.*[?&/]/, ""))) return word; // flags are handled by SECRET_RULES
    return `${name}=${MASK}`;
  });
}

/** A URL path as a record keeps it: segments that look like a secret (long and mixing letters and digits, or a bot token)
 *  or carry an email address are masked; short, ordinary segments stay for policy matching. */
export function scrubUrlPath(path: string): string {
  return scrubParam(path).split("/").map((segment) => {
    if (segment.includes("@")) return MASK;
    if (/^bot\d+:/i.test(segment)) return `bot${MASK}`;
    if (segment.length >= 20 && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment)) return MASK;
    return segment;
  }).join("/");
}

/** Scrub a structured parameter (a program name, a remote, a URL path): credential
 *  assignments and recognizable token shapes only, so policy matching on ordinary
 *  values is unaffected. */
export function scrubParam(text: string): string {
  let out = scrubAssignments(scrubShellSecrets(text));
  for (const [re, replacement] of SECRET_RULES) out = out.replace(re, replacement);
  return out;
}

// A credential name and its value joined by a comma, as an argument list reads once the shell parser has taken its quotes
// off (`[Environment]::SetEnvironmentVariable('DB_PASSWORD','x')` records `('DB_PASSWORD','x')` as a command of its own,
// with `DB_PASSWORD,x` read as its program). Free text only: the rest of the word after the comma is masked.
const OPENING = new Set(["(", "[", "{", "@", "'", '"']);
const QUOTE = new Set(["'", '"']);
function scrubJoinedArguments(text: string): string {
  return text.replace(/\S+/g, (word) => {
    const comma = word.indexOf(",");
    if (comma <= 0 || comma === word.length - 1) return word;
    let start = 0;
    let end = comma;
    while (start < end && OPENING.has(word[start])) start++;
    while (end > start && QUOTE.has(word[end - 1])) end--;
    return isCredentialName(word.slice(start, end)) ? `${word.slice(0, comma + 1)}${MASK}` : word;
  });
}

/** Scrub free text: everything `scrubParam` removes, plus the free-text-only argv and
 *  header shapes and generic high-entropy blobs. */
export function scrubSecrets(text: string): string {
  let out = scrubJoinedArguments(scrubParam(text));
  for (const [re, replacement] of HEAD_RULES) out = out.replace(re, replacement);
  out = scrubSecretHeaders(scrubSpacedPasswords(out));
  for (const [re, replacement] of BLOB_RULES) out = out.replace(re, replacement);
  return out;
}

/** A privacy-preserving representation of a shell command: a scrubbed, truncated head
 *  plus a keyed digest of the scrubbed command. The full original is never retained; the
 *  digest is taken over the scrubbed text so a secret the head removed is not in it, and
 *  it is keyed so a secret the scrubber missed cannot be guessed back from it. */
export function redactCommand(command: string, headLen = 64): string {
  const scrubbed = scrubSecrets(command);
  const head = scrubbed.length > headLen ? `${scrubbed.slice(0, headLen)}…` : scrubbed;
  return `${head} (${keyedDigest(scrubbed)})`;
}
