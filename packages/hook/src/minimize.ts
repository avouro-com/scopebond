// Data minimization for the hook: file contents are never stored, shell commands
// are reduced to a scrubbed head plus a digest, and common secret shapes are
// removed before anything is written or signed (SB09).

import { createHash } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";

export const sha256 = (value: string): string => "sha256:" + createHash("sha256").update(value).digest("hex");
export const digest = (value: unknown): string => sha256(canonical(value as never));

const MASK = "***";
// A flag or header value: a quoted string or a run of non-whitespace.
const VALUE = String.raw`("[^"]*"|'[^']*'|\S+)`;

// Each rule states its own replacement. `$1` keeps a non-secret label (a flag or
// header name); the secret itself is always dropped whole. Over-scrubbing is safe.
// Every pattern is a single pass over simple character classes (no nested
// quantifiers), so matching stays linear in the command length.
const SECRET_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [new RegExp(String.raw`(--?(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|auth|credentials?)[=\s]+)${VALUE}`, "gi"), `$1${MASK}`],
  [new RegExp(String.raw`((?:^|\s)(?:-u|--user)[=\s]+)${VALUE}`, "g"), `$1${MASK}`],
  [/(Authorization:\s*(?:Bearer|Basic|Token)\s+)[^\s"']+/gi, `$1${MASK}`],
  [/((?:x-api-key|api-key|x-auth-token|x-access-token|private-token)\s*:\s*)[^\s"']+/gi, `$1${MASK}`],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${MASK}@`],                     // URL userinfo
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
  // `auth` is omitted: `Authorization:` is handled above (with its Bearer/Basic label),
  // and other auth headers (`X-Auth-Token`) still match on `token`.
  [/(\b[\w-]*(?:secret|token|api[-_]?key|apikey|password|passwd|credential)[\w-]*\s*:\s*)[^\s"']+/gi, `$1${MASK}`],
];

// Generic high-entropy shapes. Applied to free text only (the command head), never to
// structured parameters a policy matches on: a long path or a commit id is not a secret.
const BLOB_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Fa-f0-9]{32,}\b/g, MASK],                                   // long hex blobs
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, MASK],                             // long base64/base64url blobs
];

const SECRET_NAME = /token|secret|passw|pwd|api_?key|access_?key|private_?key|auth|credential|session/i;

// `NAME=value` where the name looks like a credential (`GH_TOKEN=…`, `export
// AWS_SECRET_ACCESS_KEY=…`). Done per whitespace-delimited word rather than with
// one regex so a long identifier cannot cause backtracking.
function scrubAssignments(text: string): string {
  return text.replace(/\S+/g, (word) => {
    const eq = word.indexOf("=");
    if (eq <= 0 || eq === word.length - 1) return word;
    const name = word.slice(0, eq);
    if (name.startsWith("-") || !SECRET_NAME.test(name)) return word; // flags are handled by SECRET_RULES
    return `${name}=${MASK}`;
  });
}

/** Scrub a structured parameter (a program name, a remote, a URL path): credential
 *  assignments and recognizable token shapes only, so policy matching on ordinary
 *  values is unaffected. */
export function scrubParam(text: string): string {
  let out = scrubAssignments(text);
  for (const [re, replacement] of SECRET_RULES) out = out.replace(re, replacement);
  return out;
}

/** Scrub free text: everything `scrubParam` removes, plus the free-text-only argv and
 *  header shapes and generic high-entropy blobs. */
export function scrubSecrets(text: string): string {
  let out = scrubParam(text);
  for (const [re, replacement] of HEAD_RULES) out = out.replace(re, replacement);
  for (const [re, replacement] of BLOB_RULES) out = out.replace(re, replacement);
  return out;
}

/** A privacy-preserving representation of a shell command: a scrubbed, truncated head
 *  plus a digest of the scrubbed command. The full original is never retained, and the
 *  digest is taken over the scrubbed text so a secret the head removed cannot be
 *  brute-forced back from the digest. */
export function redactCommand(command: string, headLen = 64): string {
  const scrubbed = scrubSecrets(command);
  const head = scrubbed.length > headLen ? `${scrubbed.slice(0, headLen)}…` : scrubbed;
  return `${head} (${sha256(scrubbed)})`;
}
