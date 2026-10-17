// A local record of the hook's own failures. A fail-closed block (the hook could not decide) and a missed deadline used to be
// visible only in one person's agent transcript; `status` and `doctor` could not say "N actions were blocked because the hook
// failed". Each one now appends a line to `hook-errors.jsonl` in the hook's folder: when, the hook version, the agent, what
// kind of failure, and the message with the home folder masked and anything shaped like a credential removed. The file is
// rotated at 256 KB (one older file kept). Best effort: recording never changes or delays the block itself.
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { maskHomeFolder } from "./home-mask.js";

export const HOOK_ERRORS_FILE = "hook-errors.jsonl";
const MAX_BYTES = 256 * 1024;
const DAY_MS = 86_400_000;

export type HookErrorKind = "fail_closed" | "deadline";
export interface HookErrorLine { at: string; version: string | null; harness: string | null; kind: HookErrorKind; message: string }

let context: { dir: string; harness: string | null; version: string | null } | null = null;

/** Where this hook call records a failure: set once its folder is known. */
export function setHookErrorContext(dir: string, harness: string | null, version: string | null = null): void {
  context = { dir, harness, version };
}

/** The message as it is kept: home folder masked, credential-shaped values removed, at most 300 characters. */
export function redactHookError(message: string): string {
  return maskHomeFolder(message)
    .replace(/\bsb[a-z]_[A-Za-z0-9_-]{6,}/g, "[credential]")
    .replace(/\b(?:Bearer|token|key|secret|password)[=: ]+\S+/gi, "[removed]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

/** Append one failure. Never throws. */
export function recordHookError(kind: HookErrorKind, message: string, now = Date.now(), ctx = context): void {
  if (!ctx) return;
  try {
    const file = join(ctx.dir, HOOK_ERRORS_FILE);
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    const line: HookErrorLine = { at: new Date(now).toISOString(), version: ctx.version, harness: ctx.harness, kind, message: redactHookError(message) };
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch { /* the block already happened; a record that cannot be written changes nothing */ }
}

/** How many failures in the last 24 hours, and the newest. */
export function hookErrorSummary(dir: string, now = Date.now()): { last24h: number; newest: HookErrorLine | null } {
  let lines: HookErrorLine[] = [];
  try {
    lines = readFileSync(join(dir, HOOK_ERRORS_FILE), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as HookErrorLine; } catch { return null; } })
      .filter((l): l is HookErrorLine => !!l && typeof l.at === "string");
  } catch { return { last24h: 0, newest: null }; }
  const recent = lines.filter((l) => now - Date.parse(l.at) < DAY_MS);
  return { last24h: recent.length, newest: lines.at(-1) ?? null };
}

/** The `status` / `doctor` line, or null when the hook has not failed in the last 24 hours. */
export function hookErrorLine(dir: string, now = Date.now()): string | null {
  const { last24h, newest } = hookErrorSummary(dir, now);
  if (!last24h || !newest) return null;
  return `${last24h} action(s) blocked in the last 24 h because the hook itself failed; newest ${newest.at} (${newest.kind}): ${newest.message}`;
}
