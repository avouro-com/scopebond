// Node-only: keep a key or evidence file readable by its owner alone. On POSIX a file is created 0600. On Windows the mode
// is ignored and a new file inherits its folder's ACL, which on many machines lets every local user read it; there the
// inherited entries are removed and only the current user and SYSTEM are granted access. Best effort: a failure is
// reported to the caller, never thrown, because the gateway must still start (it warns instead).

import { chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Restrict `file` to its owner. Returns null when done (or nothing to do), else why it could not be. */
export function restrictToOwner(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    if (process.platform === "win32") {
      const user = process.env.USERNAME;
      if (!user) return "the current Windows user is unknown";
      const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
      // *S-1-5-18 is SYSTEM, named by its well-known SID so the command works in any Windows language.
      execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${account}:F`, "*S-1-5-18:F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    } else {
      chmodSync(file, 0o600);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 200) : String(error);
  }
}
