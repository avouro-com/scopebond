// Data minimization for the hook: file contents are never stored, shell commands
// are reduced to a scrubbed head plus a digest, and common secret shapes are
// removed before anything is written or signed (SB09).

import { createHash } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";

export const sha256 = (value: string): string => "sha256:" + createHash("sha256").update(value).digest("hex");
export const digest = (value: unknown): string => sha256(canonical(value as never));

// Command-line shapes that commonly carry secrets. Over-scrubbing is safe.
const SECRET_PATTERNS: RegExp[] = [
  /(--?(?:password|passwd|pwd|token|secret|api[-_]?key|auth)[=\s]+)(\S+)/gi,
  /(Authorization:\s*Bearer\s+)(\S+)/gi,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,           // GitHub tokens
  /\b(sk-[A-Za-z0-9]{20,})\b/g,                   // OpenAI-style keys
  /\b(AKIA[0-9A-Z]{16})\b/g,                      // AWS access key id
  /\b([A-Za-z0-9+/]{40,}={0,2})\b/g,              // long base64 blobs
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, p1: string, p2?: string) => (p2 !== undefined ? `${p1}***` : "***"));
  }
  return out;
}

/** A privacy-preserving representation of a shell command: a scrubbed, truncated
 *  head plus a digest of the full original. The full command is never retained. */
export function redactCommand(command: string, headLen = 64): string {
  const scrubbed = scrubSecrets(command);
  const head = scrubbed.length > headLen ? `${scrubbed.slice(0, headLen)}…` : scrubbed;
  return `${head} (${sha256(command)})`;
}
