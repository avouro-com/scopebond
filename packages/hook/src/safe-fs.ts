// Reading and creating local files without a separate existence check. A check followed by a read or write races a path
// swap between the two; here the read or the create is itself the check. Secrets (and the files that decide what the hook
// enforces) are written to a new file, owner-only from its first byte, that is linked or renamed into place, so a file or
// link someone else placed at the path never receives them and a reader never sees half of one.

import { closeSync, fstatSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { placeOwnerOnly } from "@scopebond/gateway/node";

export { loadOrCreateHexKey } from "@scopebond/gateway/node";

/** The error's code, e.g. ENOENT or EEXIST. */
export const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** The file's text, or undefined when there is no file. Any other error is thrown. */
export function readIfPresent(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
}

/** The file's text when it is at most `maxBytes`, else `null`. The file is opened once and its size checked on that
 *  descriptor, so the size that passed is the size read. Errors (a missing file among them) are thrown. */
export function readBounded(file: string, maxBytes: number): string | null {
  const fd = openSync(file, "r");
  try {
    if (fstatSync(fd).size > maxBytes) return null;
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** Create `file` only when it does not exist. True when this call created it. `text` may be a function, called only once
 *  the file is claimed; if it throws, the claimed (empty) file is removed again and the error thrown. */
export function createExclusive(file: string, text: string | (() => string), mode?: number): boolean {
  let fd: number;
  try { fd = openSync(file, "wx", mode); }
  catch (error) { if (errorCode(error) === "EEXIST") return false; throw error; }
  try {
    try { writeFileSync(fd, typeof text === "function" ? text() : text); } finally { closeSync(fd); }
  } catch (error) {
    try { rmSync(file, { force: true }); } catch { /* nothing to remove */ }
    throw error;
  }
  return true;
}

/** Replace `file` atomically with a new file, owner-only from its first byte, renamed over it: a file or link already
 *  there is replaced, never written through. */
export function replaceFile(file: string, text: string): void {
  placeOwnerOnly(file, text, false);
}
