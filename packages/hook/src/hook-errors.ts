// A local record of the hook's own failures. A fail-closed block (the hook could not decide) and a missed deadline used to be
// visible only in one person's agent transcript; `status` and `doctor` could not say "N actions were blocked because the hook
// failed". Each one now appends a line to `hook-errors.jsonl` in the hook's folder: when, the hook version, the agent, what
// kind of failure, and the message with the home folder masked and anything shaped like a credential removed. The file is
// rotated at 256 KB (one older file kept). Best effort: recording never changes or delays the block itself.
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
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

/** The message as it is kept: home folder masked, credential-shaped values removed, at most 300 characters. A word such as
 *  "token" or "key" counts only with `=` or `:` after it, so a parser's "Unexpected token" keeps its detail. */
export function redactHookError(message: string): string {
  return maskHomeFolder(message)
    .replace(/\bsb[a-z]_[A-Za-z0-9_-]{6,}/g, "[credential]")
    .replace(/\bBearer\s+\S+|\b(?:token|key|secret|password)\s*[=:]\s*\S+/gi, "[removed]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

/** Append one failure. Never throws. Rotation works on the open file only (copy it to `.1`, then empty it), so nothing is
 *  checked by path and then used. The file is opened read-write rather than for appending (Windows cannot empty a file opened
 *  for appending) and the line goes at its end; two hook calls failing at the same moment can at worst lose one line. */
export function recordHookError(kind: HookErrorKind, message: string, now = Date.now(), ctx = context): void {
  if (!ctx) return;
  const file = join(ctx.dir, HOOK_ERRORS_FILE);
  const line: HookErrorLine = { at: new Date(now).toISOString(), version: ctx.version, harness: ctx.harness, kind, message: redactHookError(message) };
  let fd: number | null = null;
  try {
    fd = openSync(file, constants.O_RDWR | constants.O_CREAT, 0o600);
    let end = fstatSync(fd).size;
    if (end > MAX_BYTES) {
      const older = Buffer.alloc(end);
      readSync(fd, older, 0, end, 0);
      writeFileSync(`${file}.1`, older, { mode: 0o600 });
      ftruncateSync(fd, 0);
      end = 0;
    }
    writeSync(fd, `${JSON.stringify(line)}\n`, end);
  } catch { /* the block already happened; a record that cannot be written changes nothing */ } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* nothing to keep */ } }
  }
}

/** The lines of one file, oldest first; none when it cannot be read. */
function readLines(file: string): HookErrorLine[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as HookErrorLine; } catch { return null; } })
      .filter((l): l is HookErrorLine => !!l && typeof l.at === "string");
  } catch { return []; }
}

/** How many failures in the last 24 hours, and the newest. The rotated file is read too, so a rotation does not hide
 *  failures from the same day. */
export function hookErrorSummary(dir: string, now = Date.now()): { last24h: number; newest: HookErrorLine | null } {
  const file = join(dir, HOOK_ERRORS_FILE);
  const lines = [...readLines(`${file}.1`), ...readLines(file)];
  const recent = lines.filter((l) => now - Date.parse(l.at) < DAY_MS);
  return { last24h: recent.length, newest: lines.at(-1) ?? null };
}

/** The rules check's report of the hook's own failures: `<count in the last 24 h>;<newest kind>`, never a message. Sent only
 *  when there is one; a workspace that knows the `hook_failures` capability reads its absence as none. */
export const HOOK_FAILURES_HEADER = "x-scopebond-hook-failures";
export const HOOK_FAILURES_CAPABILITY = "hook_failures";

export function hookFailuresHeaderValue(dir: string, now = Date.now()): string | null {
  const { last24h, newest } = hookErrorSummary(dir, now);
  return last24h > 0 && newest ? `${last24h};${newest.kind}` : null;
}

/** The `status` / `doctor` line, or null when the hook has not failed in the last 24 hours. */
export function hookErrorLine(dir: string, now = Date.now()): string | null {
  const { last24h, newest } = hookErrorSummary(dir, now);
  if (!last24h || !newest) return null;
  return `${last24h} action(s) blocked in the last 24 h because the hook itself failed; newest ${newest.at} (${newest.kind}): ${newest.message}`;
}
