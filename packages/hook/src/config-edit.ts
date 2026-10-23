import { closeSync, copyFileSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { errorCode, replaceFile } from "./safe-fs.js";

/** A hard byte bound also holds when a different writer grows the file during the read. */
export function readConfigText(file: string): string | undefined {
  checkConfigPath(file);
  let fd: number;
  try { fd = openSync(file, "r"); } catch (error) { if (errorCode(error) === "ENOENT") return undefined; throw error; }
  try {
    const limit = 4 * 1024 * 1024;
    const initial = fstatSync(fd).size;
    if (initial > limit) throw new Error("configuration too large");
    const buffer = Buffer.alloc(initial + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw new Error("configuration too large");
    if (size === buffer.length) throw new Error("configuration changed during read; retry later");
    return buffer.toString("utf8", 0, size);
  } finally { closeSync(fd); }
}

/** Refuse links, junctions and non-files, including a linked ancestor of a new configuration. */
export function checkConfigPath(file: string): void {
  let part = resolve(file);
  for (;;) {
    try {
      const stat = lstatSync(part);
      // macOS ships these root-owned aliases. They are outside the writable profile;
      // tool directories and every other linked ancestor remain refused.
      if (part !== resolve(file) && process.platform === "darwin" && (part === "/var" || part === "/tmp") && stat.uid === 0 && stat.isSymbolicLink() && realpathSync(part) === `/private${part}`) return;
      if (stat.isSymbolicLink() || (part === resolve(file) ? !stat.isFile() || stat.nlink > 1 : !stat.isDirectory())) throw new Error("unsafe configuration path");
    } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    const parent = dirname(part);
    if (parent === part) return;
    part = parent;
  }
}

/** Bounded optimistic merge under a sibling writer lock. Recheck external edits before atomic replacement. */
export function editHarnessConfig(file: string, edit: (config: Record<string, unknown>) => void, options: { mustExist?: boolean; removeWhen?: (config: Record<string, unknown>) => boolean } = {}): string {
  checkConfigPath(file);
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.scopebond-lock`;
  const fd = openSync(lock, "wx", 0o600);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkConfigPath(file);
      const raw = readConfigText(file);
      if (raw === undefined && options.mustExist) return file;
      let config: unknown;
      try { config = raw?.trim() ? JSON.parse(raw.replace(/^\uFEFF/, "")) : {}; }
      catch { throw new Error("configuration is not valid JSON; left unchanged"); }
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("configuration is not a JSON object");
      const before = JSON.stringify(config);
      edit(config as Record<string, unknown>);
      const after = JSON.stringify(config);
      const remove = options.removeWhen?.(config as Record<string, unknown>) === true;
      checkConfigPath(file);
      if (readConfigText(file) !== raw) continue;
      if (raw !== undefined && before === after && !remove) return file;
      if (raw !== undefined) {
        try { copyFileSync(file, `${file}.scopebond-backup`, constants.COPYFILE_EXCL); }
        catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      }
      checkConfigPath(file);
      if (readConfigText(file) !== raw) continue;
      if (remove) rmSync(file, { force: true });
      else replaceFile(file, JSON.stringify(config, null, 2) + "\n");
      return file;
    }
    throw new Error("configuration changed during enrollment; retry later");
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}
