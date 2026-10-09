// Node-only: keep key, credential and evidence files readable by their owner alone. On POSIX a file is created 0600 and a
// private folder is 0700. On Windows the mode is ignored and a new file inherits its folder's ACL, which on many machines
// lets every local user read it; there the inherited entries are removed and only the current user and SYSTEM are granted
// access. A private folder passes that on to everything already in it and everything created in it later, so a file made
// there is owner-only from its first byte, the journal files SQLite creates beside a database included. Best effort: a
// failure is reported to the caller, never thrown, because the hook and the gateway must still start (they warn instead).

import { closeSync, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { windowsSystemProgram } from "./node-programs.js";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const onWindows = (): boolean => process.platform === "win32";
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** Groups that stand for every local user (or every administrator): Everyone, Authenticated Users, Interactive, Anonymous,
 *  Users, Guests, Administrators. Entries for them are removed even when set on the file itself rather than inherited. */
const BROAD_GROUPS = ["*S-1-1-0", "*S-1-5-11", "*S-1-5-4", "*S-1-5-7", "*S-1-5-32-545", "*S-1-5-32-546", "*S-1-5-32-544"];

/** Replace the ACL of `path` with full control for the current user and SYSTEM; `inherit` passes it on to what a folder
 *  holds. Returns null when done, else why not. */
function grantOwnerOnly(path: string, inherit: boolean, timeoutMs: number): string | null {
  const user = process.env.USERNAME;
  if (!user) return "the current Windows user is unknown";
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  const flags = inherit ? "(OI)(CI)" : "";
  // *S-1-5-18 is SYSTEM; well-known accounts are named by SID so the command works in any Windows language. icacls resolves
  // every name before it changes anything, so an account it cannot resolve leaves the ACL as it was.
  try {
    // By full path: a bare name would be looked for in the current folder first, which is the project.
    execFileSync(windowsSystemProgram("icacls"), [path, "/inheritance:r", "/grant:r", `${account}:${flags}F`, `*S-1-5-18:${flags}F`, "/remove:g", ...BROAD_GROUPS], { stdio: "ignore", windowsHide: true, timeout: timeoutMs });
    return null;
  } catch (error) { return reason(error); }
}

/** Restrict `file` to its owner. Returns null when done (or nothing to do), else why it could not be. */
export function restrictToOwner(file: string): string | null {
  if (onWindows()) return existsSync(file) ? grantOwnerOnly(file, false, 10_000) : null;
  // Checked and changed on the open file, so the file whose mode was read is the one changed. Only group and other access is
  // removed: the owner's own bits stay (a file made read-only stays read-only).
  let fd: number;
  try { fd = openSync(file, "r"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : reason(error); }
  try {
    const mode = fstatSync(fd).mode;
    if ((mode & 0o077) !== 0) fchmodSync(fd, mode & 0o700);
    return null;
  } catch (error) { return reason(error); }
  finally { closeSync(fd); }
}

/** Windows: restrict a folder this process just made (a staging folder) to its owner, passed on to what is created in it. */
export function restrictFolderToOwner(dir: string): string | null {
  return grantOwnerOnly(dir, true, 10_000);
}

/** On Windows a private folder keeps a marker naming the folder it was made private for (a copy of the folder is another
 *  folder, made private again) and whether that worked, so the hook, which starts on every tool call, checks a small file
 *  instead of running icacls. Whoever can write the marker before the folder is private can already change everything
 *  else in it. */
const PRIVATE_DIR_MARKER = ".owner-only";
/** A folder that could not be made private (no ACLs on its volume, say) is tried again after a day. */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const folderId = (dir: string): string | null => {
  try { return String(statSync(dir, { bigint: true }).ino); } catch { return null; }
};

/** Windows: what the marker in `dir` says (null: never tried for this folder, or a failure long enough ago to try again). */
function markerState(dir: string): "private" | "failed" | null {
  try {
    const marker = join(dir, PRIVATE_DIR_MARKER);
    const [id, state] = readFileSync(marker, "utf8").trim().split(/\s+/);
    if (!id || id !== folderId(dir)) return null;
    if (state === "private") return "private";
    if (state === "failed" && Date.now() - statSync(marker).mtimeMs < RETRY_AFTER_MS) return "failed";
    return null;
  } catch { return null; }
}

/** Whether `dir` passes owner-only access on to the files created in it: on POSIX, a folder no group or other user can
 *  open; on Windows, one `ensurePrivateDir` made private. */
export function isPrivateDir(dir: string): boolean {
  if (onWindows()) return markerState(dir) === "private";
  try { return (statSync(dir).mode & 0o077) === 0; } catch { return false; }
}

/** Windows: whether the access of the files in `dir` is already decided by the folder (a folder `ensurePrivateDir` made
 *  private), so they are not restricted one by one, an icacls run each. A folder that could not be made private decides
 *  nothing: its files are restricted one by one (see `restrictOnce`). On POSIX that costs a chmod, so every file stays 0600
 *  whatever its folder: never decided by the folder. */
export function folderDecides(dir: string): boolean {
  return onWindows() && markerState(dir) === "private";
}

/** How the files in `dir` are kept owner-only, for `status` and `doctor`: "private" (the folder passes owner-only access on
 *  to them), "per-file" (the folder's own access could not be changed, so each file is restricted on its own), or null (not
 *  tried yet, or not a folder of Scopebond's own). */
export function ownerOnlyState(dir: string): "private" | "per-file" | null {
  if (!onWindows()) {
    try { return (statSync(dir).mode & 0o077) === 0 ? "private" : "per-file"; } catch { return null; }
  }
  try {
    const [id, state] = readFileSync(join(dir, PRIVATE_DIR_MARKER), "utf8").trim().split(/\s+/);
    if (!id || id !== folderId(dir)) return null;
    return state === "private" ? "private" : state === "failed" ? "per-file" : null;
  } catch { return null; }
}

// Windows: the files this user has restricted one by one outside a private folder, so each is restricted once (and checked
// again after a day) rather than every time it is opened: an icacls run costs tens of milliseconds, and a gateway or MCP proxy
// opens several such files on every start. A file is known by its volume, id and creation time, so a replaced or copied file
// is restricted again. The list is kept in this user's local application data, which other users cannot change.
const RECHECK_AFTER_MS = RETRY_AFTER_MS;
const RECORD_LIMIT = 1024;
let restricted: Map<string, number> | null = null;

function recordFile(): string | null {
  const base = process.env.LOCALAPPDATA ?? "";
  return /^[A-Za-z]:[\\/]/.test(base) ? join(base, "Scopebond", "owner-only-files.json") : null;
}
function readRecord(file: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [key, at] of Object.entries(parsed)) if (typeof at === "number") out.set(key, at);
  } catch { /* none yet, or unreadable: start again */ }
  return out;
}
const fileKey = (file: string): string | null => {
  try { const s = statSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.birthtimeNs}`; } catch { return null; }
};

function restrictedRecently(file: string): boolean {
  const record = recordFile();
  if (!record) return false;
  restricted ??= readRecord(record);
  const key = fileKey(file);
  const at = key === null ? undefined : restricted.get(key);
  return at !== undefined && Date.now() - at < RECHECK_AFTER_MS && at <= Date.now();
}

/** Windows: note that `file` was just restricted, in this process and in the record other processes read. */
export function noteRestricted(file: string): void {
  const record = recordFile();
  const key = onWindows() && record ? fileKey(file) : null;
  if (!record || key === null) return;
  restricted ??= readRecord(record);
  restricted.set(key, Date.now());
  // Merged with what other processes noted meanwhile, newest kept, and written through a new file renamed into place.
  const merged = readRecord(record);
  for (const [k, at] of restricted) if ((merged.get(k) ?? 0) < at) merged.set(k, at);
  const kept = [...merged].filter(([, at]) => Date.now() - at < RECHECK_AFTER_MS).sort((a, b) => b[1] - a[1]).slice(0, RECORD_LIMIT);
  restricted = new Map(kept);
  const temp = `${record}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(temp, JSON.stringify(Object.fromEntries(kept)), { flag: "wx" });
    renameSync(temp, record);
  } catch { try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ } }
}

/** Restrict `file` to its owner unless that was done within the last day (Windows; on POSIX it is a cheap chmod, always
 *  done). Returns null when done (or nothing to do), else why it could not be. */
export function restrictOnce(file: string): string | null {
  if (!onWindows()) return restrictToOwner(file);
  if (restrictedRecently(file)) return null;
  const failure = restrictToOwner(file);
  if (!failure) noteRestricted(file);
  return failure;
}

/** Make `dir`, one of Scopebond's own folders, readable by its owner alone, together with everything already in it (keys,
 *  the Cloud credential, databases and their journal files that an older version left under the folder's ACL), and
 *  everything created in it from now on. Cheap once done: a mode check on POSIX, a marker read on Windows. Never creates
 *  the folder, and never changes a file system root or the home folder itself (a folder configured as one of those keeps
 *  its access, and its files are restricted one by one). Returns null when done (or there is no folder), else why not. */
export function ensurePrivateDir(dir: string): string | null {
  const full = resolve(dir), home = resolve(homedir());
  if (dirname(full) === full || (onWindows() ? full.toLowerCase() === home.toLowerCase() : full === home)) return `${dir} is not a folder of Scopebond's own`;
  if (!onWindows()) {
    // Group and other access removed on the open folder; the owner's own bits stay.
    let fd: number;
    try { fd = openSync(dir, "r"); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : reason(error); }
    try {
      const mode = fstatSync(fd).mode;
      if ((mode & 0o077) !== 0) fchmodSync(fd, mode & 0o700);
      return null;
    } catch (error) { return reason(error); }
    finally { closeSync(fd); }
  }
  const id = folderId(dir);
  if (id === null) return null;
  const state = markerState(dir);
  if (state === "private") return null;
  if (state === "failed") return `${dir} could not be made private (tried within the last day)`;
  // The first time every file in the folder is updated too, a moment for the pinned hook copies. A folder too large to finish
  // within the limit counts as failed, so a tool call is never held up by it again the same day.
  const failure = grantOwnerOnly(dir, true, 20_000);
  // Written through a new file renamed into place, never through whatever is at the marker's name.
  const marker = join(dir, PRIVATE_DIR_MARKER);
  const temp = `${marker}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${id} ${failure ? "failed" : "private"}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, marker);
    // In a folder that stays open to others, the marker gets an access list of its own, so no one else can rewrite it to say
    // "private" and stop the files here from being restricted one by one.
    if (failure) grantOwnerOnly(marker, false, 10_000);
  } catch { try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ } }
  return failure;
}
