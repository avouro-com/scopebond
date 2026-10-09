// Reading and creating local files without a separate existence check. A check followed by a read or write races a path
// swap between the two; here the read or the create is itself the check. Secrets are created exclusively, owner only, and
// a damaged one is replaced through a fresh temporary file renamed over it, so a file or link that someone else placed at
// the path never receives the secret.

import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

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

/** Replace `file` atomically: a new temporary file beside it (created exclusively), renamed over it. */
export function replaceFile(file: string, text: string, mode = 0o600): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { mode, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") { try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ } }
    throw error;
  }
}

const validKey = (text: string | undefined): string | undefined => {
  const hex = text?.trim();
  return hex !== undefined && /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
};

/** A 32-byte hex secret kept in `file`: read when present and valid, else made. A new file is created exclusively and
 *  owner only (0600); a file that holds no valid key is replaced atomically with a new one. */
export function loadOrCreateHexKey(file: string): string {
  const existing = readIfPresent(file);
  const found = validKey(existing);
  if (found) return found;
  const hex = randomBytes(32).toString("hex");
  if (existing === undefined) {
    if (createExclusive(file, hex + "\n", 0o600)) return hex;
    // Another process made it in the meantime: use its key when it is valid.
    const raced = validKey(readIfPresent(file));
    if (raced) return raced;
  }
  replaceFile(file, hex + "\n");
  return hex;
}
