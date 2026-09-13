import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "scopebond-package-smoke-"));
const pnpmCli = process.env.npm_execpath;
assert.ok(pnpmCli, "run this check through pnpm so its pinned CLI can be reused");

try {
  execFileSync(process.execPath, [pnpmCli, "pack", "--pack-destination", scratch], {
    cwd: new URL("../packages/gateway/", import.meta.url),
    stdio: "inherit",
  });
  const archive = readdirSync(scratch).find((name) => name.endsWith(".tgz"));
  assert.ok(archive, "gateway package archive was not created");

  writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync(process.execPath, [pnpmCli, "add", "--ignore-scripts", join(scratch, archive)], {
    cwd: scratch,
    stdio: "inherit",
  });
  writeFileSync(join(scratch, "smoke.mjs"), `
    import { merkleRoot, sha256 } from "@scopebond/gateway";
    if (merkleRoot([sha256("candidate")]).length !== 64) process.exit(1);
  `);
  execFileSync(process.execPath, [join(scratch, "smoke.mjs")], { cwd: scratch, stdio: "inherit" });
  console.log("Packed @scopebond/gateway installs and imports in a clean consumer project.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
