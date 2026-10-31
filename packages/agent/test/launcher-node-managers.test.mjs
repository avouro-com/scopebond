// H3 (2026-10-27 review): the macOS/Linux launcher knew nvm and Homebrew's Node only. launchd starts it with a bare PATH,
// so removing the Node version it was set up with (fnm, Volta, mise, asdf) stopped Scopebond, silently, and launchd
// restarted it every 10 seconds forever. The launcher is run here with /bin/sh in a temporary home; the Nodes are stand-ins
// that print how they were started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { macLaunchAgent, posixLauncher, refreshPosixLauncher, launcherPath, POSIX_LAUNCHER_MARK } = await import("../dist/index.js");

const posix = { skip: process.platform === "win32" && "a POSIX shell launcher" };
const BARE_PATH = "/usr/bin:/bin";
/** Whether a Node outside the temporary home would be found first (then the version managers are never asked). */
const systemNode = () => spawnSync("/bin/sh", ["-c", "command -v node"], { env: { PATH: BARE_PATH } }).status === 0;
const systemCandidates = () => systemNode() || ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].some((p) => existsSync(p));

function home() {
  const root = mkdtempSync(join(tmpdir(), "sb-launcher-"));
  const cli = join(root, "lib", "node_modules", "@scopebond", "agent", "dist", "cli.js");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "");
  const launcher = join(root, "agent-launch.sh");
  // Set up with a Node that has since been removed.
  writeFileSync(launcher, posixLauncher(join(root, "removed", "bin", "node"), cli));
  return { root, cli, launcher };
}
function fakeNode(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "started $0 with $*"\n`);
  chmodSync(path, 0o755);
}
const run = (h, env = {}) => spawnSync("/bin/sh", [h.launcher], { encoding: "utf8", env: { HOME: h.root, PATH: BARE_PATH, ...env } });

test("the launcher finds the default Node of fnm, Volta, mise and asdf when the one it was set up with is gone", { ...posix, skip: posix.skip || (systemNode() && "a Node on the bare PATH is found first") }, () => {
  for (const where of [
    ".local/share/fnm/aliases/default/bin/node",
    "Library/Application Support/fnm/aliases/default/bin/node",
    ".volta/bin/node",
    ".local/share/mise/shims/node",
    ".asdf/shims/node",
  ]) {
    const h = home();
    const node = join(h.root, where);
    fakeNode(node);
    const r = run(h);
    assert.equal(r.status, 0, `${where}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), `started ${node} with --disable-warning=ExperimentalWarning ${h.cli} run`, where);
  }
  // A version manager's own folder, when the person set one.
  const h = home();
  const node = join(h.root, "elsewhere", "fnm", "aliases", "default", "bin", "node");
  fakeNode(node);
  assert.ok(run(h, { FNM_DIR: join(h.root, "elsewhere", "fnm") }).stdout.startsWith(`started ${node} `));
});

test("with no Node at all the launcher says so in the log and exits 1; launchd tries again after 30 seconds, not 10", posix, () => {
  const h = home();
  const text = readFileSync(h.launcher, "utf8");
  assert.ok(text.includes(POSIX_LAUNCHER_MARK));
  assert.match(text, /the Scopebond Agent cannot start: no Node found .* Run \\`scopebond-agent autostart on\\` in a terminal where node works\." >&2\n {2}exit 1\n/);
  if (!systemCandidates()) {
    const r = run(h);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ the Scopebond Agent cannot start: no Node found \(.*removed\/bin\/node is gone/);
  }
  assert.match(macLaunchAgent(h.launcher, join(h.root, "agent.log")), /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.match(macLaunchAgent(h.launcher, join(h.root, "agent.log")), /<key>StandardErrorPath<\/key><string>[^<]*agent\.log<\/string>/, "the line lands in agent.log");
});

test("an older launcher is rewritten when the agent starts; a current one is left alone", posix, () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-launcher-old-"));
  const file = launcherPath(dir, "darwin");
  writeFileSync(file, "#!/bin/sh\n# Scopebond Agent launcher: finds Node and the agent each time, so a Node upgrade never stops it.\nNODE='/gone/node'\n");
  assert.equal(refreshPosixLauncher(dir, "/opt/cli.js", "/usr/bin/node", "darwin"), true);
  assert.ok(readFileSync(file, "utf8").includes(POSIX_LAUNCHER_MARK));
  assert.ok(readFileSync(file, "utf8").includes("NODE='/usr/bin/node'"), "with the Node the agent runs on now");
  assert.equal(refreshPosixLauncher(dir, "/opt/cli.js", "/usr/bin/node", "darwin"), false);
  assert.equal(refreshPosixLauncher(mkdtempSync(join(tmpdir(), "sb-none-")), "/opt/cli.js", "/usr/bin/node", "darwin"), false, "no launcher: nothing written");
  assert.equal(refreshPosixLauncher(dir, "/opt/cli.js", "C:\\node.exe", "win32"), false, "Windows has its own launcher mark");
});
