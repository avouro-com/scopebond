// The agent works in the same folder as the hook (the Cloud credential, the signing keys, the delivery queue, the chain
// heads): its first cycle makes that folder readable by this user alone, the files an older version left there included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { runCycle } from "../dist/index.js";

const sandbox = mkdtempSync(join(tmpdir(), "sb-agent-owner-only-home-"));
for (const k of ["HOME", "USERPROFILE", "SCOPEBOND_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) process.env[k] = sandbox;

const windows = process.platform === "win32";
const self = (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : String(process.env.USERNAME)).toLowerCase();

/** Windows: the principals other than this user and SYSTEM in the ACL of `path`. */
function others(path) {
  const lines = execFileSync("icacls", [path], { encoding: "utf8" }).split(/\r?\n/);
  lines[0] = lines[0].slice(path.length);
  return lines.map((l) => l.trim()).filter((l) => l.includes(":("))
    .map((l) => l.slice(0, l.indexOf(":(")).toLowerCase())
    .filter((name) => name !== self && !/(^|\\)system$/.test(name));
}

test("a cycle makes the folder readable by this user alone, files an older version left included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-agent-folder-"));
  // *S-1-5-11 is Authenticated Users: a folder other local users may open, as outside the user profile.
  if (windows) execFileSync("icacls", [dir, "/grant", "*S-1-5-11:(OI)(CI)M"], { stdio: "ignore" });
  else chmodSync(dir, 0o755);
  const older = join(dir, "digest.key");
  writeFileSync(older, randomBytes(32).toString("hex") + "\n", { mode: 0o644 });
  try {
    const result = await runCycle({ dir });
    assert.equal(result.connected, false, "nothing to deliver: only the folder is in question");
    if (windows) {
      assert.deepEqual(others(dir), []);
      assert.deepEqual(others(older), []);
    } else {
      assert.equal(statSync(dir).mode & 0o077, 0, "no group or other access to the folder");
    }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});
