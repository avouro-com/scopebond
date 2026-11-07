// Loaded before every test file (`node --test --import ./test/isolate-home.mjs`, the package's test script), and by the
// test runner itself, so that the suite never sees the computer it runs on.
//
// On a computer where Scopebond is installed for the person running the tests, the user-level install (its rules,
// trusted projects and store) would otherwise govern: a hook call honours SCOPEBOND_HOOK_DIR only while no user-level
// install exists, so tests that point the hook at a folder of their own found the person's rules instead. The home
// folder Scopebond uses is the operating system account's (os.userInfo, not HOME), which no variable moves, so the
// suite moves Scopebond's own home (SCOPEBOND_HOME, which an npm install reads from the environment) to an empty folder,
// and HOME, USERPROFILE and the XDG folders with it, so that nothing a test runs reads or writes the person's agent
// configuration either. Every other SCOPEBOND_ variable a shell may carry is cleared; the few that switch tests on or
// point them at a build are kept. Each test (and every process it starts with process.env) inherits the result.
//
// Only the tests change: what the hook reads in production is untouched.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The variables that configure the test run rather than Scopebond itself. */
const TEST_SWITCHES = new Set([
  "SCOPEBOND_WINDOWS_JOURNEY",
  "SCOPEBOND_BENCH",
  "SCOPEBOND_BENCH_RECEIPTS",
  "SCOPEBOND_BIN",
  "SCOPEBOND_CLI",
  "SCOPEBOND_ORACLE",
  "SCOPEBOND_PACK_DIR",
  "SCOPEBOND_RSS_OUT",
]);

for (const name of Object.keys(process.env)) {
  const upper = name.toUpperCase();
  if ((upper.startsWith("SCOPEBOND_") && !TEST_SWITCHES.has(upper)) || upper.startsWith("XDG_")) delete process.env[name];
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-test-home-")));
process.env.HOME = root;
process.env.USERPROFILE = root;
// Not created: as on a computer where Scopebond was never installed.
process.env.SCOPEBOND_HOME = join(root, ".scopebond");

process.on("exit", () => {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a file still open (Windows): the temp folder keeps it */ }
});
