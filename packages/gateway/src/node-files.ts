// Node-only: read and create local files without a separate existence check. A check followed by a read or write races
// a path swap between the two; here the read or the create is itself the check. A secret is written to a new file that is
// owner-only from its first byte and complete when it appears at its name: a file or link someone else placed at the name
// never receives it, and a process reading the name never sees half of it.

import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { folderDecides, isPrivateDir, restrictFolderToOwner, restrictToOwner } from "./node-permissions.js";

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const random = (): string => randomBytes(6).toString("hex");

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

/** The file's text once it is `complete`, or undefined when there is no file. A file that is there but not complete may
 *  have just been claimed by another process that has not written it yet (on a file system without hard links, and with
 *  older versions, a new file is empty for a moment): it is read again for up to `waitMs` before it counts as damaged. */
export function readSettled(file: string, complete: (text: string) => boolean, waitMs = 500): string | undefined {
  const deadline = Date.now() + waitMs;
  for (let pause = 5; ; pause = Math.min(pause * 2, 50)) {
    const text = readIfPresent(file);
    if (text === undefined || complete(text) || Date.now() >= deadline) return text;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
  }
}

/** Windows, outside a private folder: a new subfolder of `dir`, restricted before anything is written in it. A file created
 *  there is owner-only from its first byte and keeps that ACL when it is linked or moved into place. Null when the
 *  subfolder cannot be restricted (the file is then written in `dir` and restricted once it is in place, the best left). */
function stagingFolder(dir: string): string | null {
  const path = join(dir, `.scopebond-${random()}.tmp`);
  try { mkdirSync(path); } catch { return null; }
  const made = lstatSync(path, { bigint: true });
  const failure = restrictFolderToOwner(path);
  const now = lstatSync(path, { bigint: true });
  if (now.isSymbolicLink() || !now.isDirectory() || now.ino !== made.ino) {
    throw new Error(`${path} was replaced while a secret was being written there`);
  }
  if (!failure) return path;
  try { rmdirSync(path); } catch { /* left behind empty */ }
  return null;
}

/** Claim `file` exclusively and fill it: for file systems without hard links. True when this call made it. */
function claimAndFill(file: string, text: string): boolean {
  let fd: number;
  try { fd = openSync(file, "wx", 0o600); }
  catch (error) { if (code(error) === "EEXIST") return false; throw error; }
  try {
    try { writeFileSync(fd, text); } finally { closeSync(fd); }
  } catch (error) {
    try { rmSync(file, { force: true }); } catch { /* nothing to remove */ }
    throw error;
  }
  return true;
}

/** Put `text` at `file` as a new file, readable by its owner alone from its first byte and complete the moment it appears
 *  at its name. Nothing already at `file` is written through: with `exclusive` a file or link there is left alone and false
 *  is returned (someone else made it first); otherwise it is replaced. True when this call put the file there. */
export function placeOwnerOnly(file: string, text: string, exclusive: boolean): boolean {
  const dir = dirname(file);
  // On POSIX the file is created 0600; in a private folder it inherits owner-only.
  const shared = process.platform === "win32" && !isPrivateDir(dir);
  const stage = shared ? stagingFolder(dir) : null;
  const temp = join(stage ?? dir, `${basename(file)}.${random()}.tmp`);
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    if (!exclusive) renameSync(temp, file);
    else {
      // A hard link is created only when nothing is at the name, and the name then shows the complete file.
      try { linkSync(temp, file); }
      catch (error) {
        if (code(error) === "EEXIST") return false;
        if (!claimAndFill(file, text)) return false;
      }
    }
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* removed with its folder, or never made */ }
    if (stage) { try { rmdirSync(stage); } catch { /* left behind empty */ } }
  }
  // Outside a private folder the file gets an explicit ACL of its own, so it does not depend on the staging folder's.
  if (shared) {
    const failure = restrictToOwner(file);
    if (failure) process.emitWarning(`could not restrict ${file} to this user: ${failure}`);
  }
  return true;
}

/** An existing key or evidence file, which an older version may have made under its folder's ACL (on POSIX, readable by
 *  others), restricted to its owner when it is opened. Skipped where the folder decides (a private folder), so the hook,
 *  which opens these on every tool call, does not pay for it. */
export function keepOwnerOnly(file: string): void {
  if (folderDecides(dirname(file))) return;
  const failure = restrictToOwner(file);
  if (failure) process.emitWarning(`could not restrict ${file} to this user: ${failure}`);
}

/** Before SQLite opens `path`, outside a private folder: the database and the journal files SQLite keeps beside it are
 *  restricted when they are there, else created empty and owner-only, so SQLite uses them instead of creating them under
 *  the folder's ACL. In a private folder they are owner-only anyway. A database in memory (or a temporary one) has no files. */
export function prepareOwnerOnlyDatabase(path: string): void {
  if (path === "" || path === ":memory:" || path.startsWith("file:") || folderDecides(dirname(path))) return;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    // The existence check only saves work: the exclusive create below is the real check.
    if (existsSync(file) || !placeOwnerOnly(file, "", true)) keepOwnerOnly(file);
  }
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const validKey = (text: string | undefined): string | undefined => {
  const hex = text?.trim();
  return hex !== undefined && HEX_KEY.test(hex) ? hex : undefined;
};
const isKey = (text: string): boolean => validKey(text) !== undefined;

/** A 32-byte hex secret kept in `file`: read when present and valid, else made, owner only. Processes that make it at the
 *  same moment all use the one that reached the name first. A file that holds no key is replaced, never written through. */
export function loadOrCreateHexKey(file: string): string {
  const existing = readSettled(file, isKey);
  const found = validKey(existing);
  if (found) { keepOwnerOnly(file); return found; }
  const hex = randomBytes(32).toString("hex");
  if (existing === undefined) {
    if (placeOwnerOnly(file, hex + "\n", true)) return hex;
    // Another process made it in the meantime: use its key.
    const raced = validKey(readSettled(file, isKey));
    if (raced) return raced;
  }
  placeOwnerOnly(file, hex + "\n", false);
  return hex;
}
