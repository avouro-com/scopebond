// The proxy's local secret file, read and made without a separate existence check: a check followed by a read or write
// races a path swap between the two. A new file is created exclusively and owner only; a file that holds no valid key is
// replaced through a fresh temporary file renamed over it, so a file or link someone else placed there never gets the key.

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

function readIfPresent(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if (code(error) === "ENOENT") return undefined; throw error; }
}

const validKey = (text: string | undefined): string | undefined => {
  const hex = text?.trim();
  return hex !== undefined && /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
};

/** A 32-byte hex secret kept in `file`: read when present and valid, else made (0600). */
export function loadOrCreateHexKey(file: string): string {
  const existing = readIfPresent(file);
  const found = validKey(existing);
  if (found) return found;
  const hex = randomBytes(32).toString("hex");
  if (existing === undefined) {
    try { writeFileSync(file, hex + "\n", { mode: 0o600, flag: "wx" }); return hex; }
    catch (error) { if (code(error) !== "EEXIST") throw error; }
    // Another process made it in the meantime: use its key when it is valid.
    const raced = validKey(readIfPresent(file));
    if (raced) return raced;
  }
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, hex + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    if (code(error) !== "EEXIST") { try { rmSync(temp, { force: true }); } catch { /* nothing to remove */ } }
    throw error;
  }
  return hex;
}
