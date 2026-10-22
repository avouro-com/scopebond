import { closeSync, copyFileSync, constants, lstatSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { errorCode, readIfPresent, replaceFile } from "./safe-fs.js";

/** Refuse links, junctions and non-files, including a linked ancestor of a new configuration. */
export function checkConfigPath(file: string): void {
  let part = resolve(file);
  for (;;) {
    try {
      const stat = lstatSync(part);
      if (stat.isSymbolicLink() || (part === resolve(file) ? !stat.isFile() || stat.nlink > 1 : !stat.isDirectory())) throw new Error("unsafe configuration path");
    } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    const parent = dirname(part);
    if (parent === part) return;
    part = parent;
  }
}

/** Bounded optimistic merge under a sibling writer lock. Recheck external edits before atomic replacement. */
export function editHarnessConfig(file: string, edit: (config: Record<string, unknown>) => void): string {
  checkConfigPath(file);
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.scopebond-lock`;
  const fd = openSync(lock, "wx", 0o600);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkConfigPath(file);
      const raw = readIfPresent(file);
      if (raw && raw.length > 4 * 1024 * 1024) throw new Error("configuration too large");
      let config: unknown;
      try { config = raw?.trim() ? JSON.parse(raw.replace(/^\uFEFF/, "")) : {}; }
      catch { throw new Error("configuration is not valid JSON; left unchanged"); }
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("configuration is not a JSON object");
      const before = JSON.stringify(config);
      edit(config as Record<string, unknown>);
      const after = JSON.stringify(config);
      checkConfigPath(file);
      if (readIfPresent(file) !== raw) continue;
      if (raw !== undefined && before === after) return file;
      if (raw !== undefined) {
        try { copyFileSync(file, `${file}.scopebond-backup`, constants.COPYFILE_EXCL); }
        catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      }
      checkConfigPath(file);
      if (readIfPresent(file) !== raw) continue;
      replaceFile(file, JSON.stringify(config, null, 2) + "\n");
      return file;
    }
    throw new Error("configuration changed during enrollment; retry later");
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}
