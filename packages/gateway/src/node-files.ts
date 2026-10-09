// Node-only: read and create local files without a separate existence check. A check followed by a read or write races
// a path swap between the two; here the read or the create is itself the check. Secrets are created exclusively, owner
// only, and a damaged one is replaced through a fresh temporary file renamed over it, so a file or link that someone
// else placed at the path never receives the secret.

import { closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** The file's text, or undefined when there is no file. Any other error is thrown. */
export function readIfPresent(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if (code(error) === "ENOENT") return undefined; throw error; }
}

/** The file's text, or undefined when there is no file. The size is checked on the open file itself, so the size that
 *  passed is the size read; `tooLarge` is called (and must throw or return undefined) when it is over `maxBytes`. */
export function readBoundedIfPresent(file: string, maxBytes: number, tooLarge: () => undefined): string | undefined {
  let fd: number;
  try { fd = openSync(file, "r"); }
  catch (error) { if (code(error) === "ENOENT") return undefined; throw error; }
  try {
    if (fstatSync(fd).size > maxBytes) return tooLarge();
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** Replace `file` atomically: write a new temporary file beside it (created exclusively, owner only) and rename it over. */
export function replaceFile(file: string, text: string, mode = 0o600): void {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { mode, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    if (code(error) !== "EEXIST") { try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ } }
    throw error;
  }
}

/** Create `file` with `text` only if it does not exist. True when this call created it. */
export function createExclusive(file: string, text: string, mode?: number): boolean {
  try { writeFileSync(file, text, { flag: "wx", ...(mode === undefined ? {} : { mode }) }); return true; }
  catch (error) { if (code(error) === "EEXIST") return false; throw error; }
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const validKey = (text: string | undefined): string | undefined => {
  const hex = text?.trim();
  return hex !== undefined && HEX_KEY.test(hex) ? hex : undefined;
};

/** A 32-byte hex secret kept in `file`: read when present and valid, else made. A new file is created exclusively and
 *  owner only; a file that holds no valid key is replaced atomically with a new one. */
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
