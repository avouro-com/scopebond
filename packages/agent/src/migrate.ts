// From an npm install of the agent to the signed Windows install. When the signed agent starts (or `setup` runs) and finds
// the npm one, it takes over before anything else, so the two never run side by side:
//
//   - the npm agent, if it runs, is asked to stop through its control channel (the `stop` it already answers);
//   - its sign-in entry (the `ScopebondAgent` Run value) and its launcher go: beside the native tray the tray starts the
//     agent, and without the tray autostart is pointed at this executable instead;
//   - its Settings -> Apps entry and that entry's uninstall script go (the installer has its own entry);
//   - every Scopebond hook entry in the coding agents' settings is pointed at this executable (`"<exe>" hook <harness>`).
//
// The npm package itself stays where npm put it: the agent never runs npm. It says, once, that
// `npm uninstall -g @scopebond/agent` removes it, and `status` keeps saying so while both are there.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "@scopebond/hook";
import { expectedHarnesses } from "./agent.js";
import { UNINSTALL_KEY, UNINSTALL_SCRIPT } from "./apps-entry.js";
import { enableAutostart, launcherPath, retireLauncherRunValue, type RegRunner } from "./autostart.js";
import { hasForeignHookEntries, useNativeHookEntries, type EntryChange } from "./hook-entries.js";
import { callAgent } from "./ipc.js";
import { windowsTool, type InstallKind } from "./native-update.js";
import { npmProgram } from "./commands.js";

/** What is left of an npm install of the agent for this user. */
export interface NpmInstall {
  /** The `ScopebondAgent` Run value (autostart of the launcher). */
  runValue: boolean;
  /** The launcher in the Scopebond folder is the npm one (it finds Node and cli.js). */
  npmLauncher: boolean;
  /** Its Settings -> Apps entry, and the uninstall script that entry runs. */
  appsEntry: boolean;
  uninstallScript: boolean;
  /** The package in npm's default global folder for this user, when it is there. */
  packageDir: string | null;
  /** Coding agents whose Scopebond hook entry runs something other than this executable. */
  hookEntries: Harness[];
}

export interface MigrateDeps {
  reg: RegRunner;
  exists: (path: string) => boolean;
  readText: (path: string) => string | null;
  callAgent: typeof callAgent;
  harnesses: () => Harness[];
  /** This executable (the hook entries' program). */
  exe: string;
  /** The folder npm installs global packages in for this user by default. */
  npmGlobal: string | null;
  enableAutostart: (dir: string) => string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const systemReg: RegRunner = (args) => {
  try { execFileSync(windowsTool("reg"), args, { stdio: "ignore", windowsHide: true }); return true; } catch { return false; }
};

function defaultMigrateDeps(): MigrateDeps {
  return {
    reg: systemReg,
    exists: existsSync,
    readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
    callAgent,
    harnesses: expectedHarnesses,
    exe: process.execPath,
    npmGlobal: process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null,
    enableAutostart: (dir) => enableAutostart(dir, process.execPath),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

/** An npm launcher finds Node and the agent's cli.js; the single executable's starts the executable itself. */
export function isNpmLauncher(text: string | null): boolean {
  return text !== null && /^set "CLI=/m.test(text);
}

/** What of an npm install of the agent is on this computer for this user. */
export function findNpmInstall(dir: string, deps: MigrateDeps = defaultMigrateDeps()): NpmInstall {
  const packageDir = deps.npmGlobal ? join(deps.npmGlobal, "@scopebond", "agent") : null;
  let hookEntries: Harness[] = [];
  try { hookEntries = deps.harnesses().filter((h) => hasForeignHookEntries(h, deps.exe)); } catch { /* unreadable settings: left alone */ }
  return {
    runValue: deps.reg(["query", RUN_KEY, "/v", "ScopebondAgent"]),
    npmLauncher: isNpmLauncher(deps.readText(launcherPath(dir, "win32"))),
    appsEntry: deps.reg(["query", UNINSTALL_KEY]),
    uninstallScript: deps.exists(join(dir, UNINSTALL_SCRIPT)),
    packageDir: packageDir && deps.exists(join(packageDir, "package.json")) ? packageDir : null,
    hookEntries,
  };
}

/** Whether anything of an npm install is there that the signed install takes over. */
export function hasNpmInstall(found: NpmInstall): boolean {
  return found.npmLauncher || found.appsEntry || found.uninstallScript || found.packageDir !== null || found.hookEntries.length > 0;
}

/** Kept once the signed install took over from an npm one: when, and whether the person was told how to remove it. */
export const MIGRATED_FILE = "migrated-from-npm.json";

export interface Migration { at: number; package_dir: string | null; steps: string[] }

export function readMigration(dir: string): Migration | null {
  try {
    const r = JSON.parse(readFileSync(join(dir, MIGRATED_FILE), "utf8")) as Partial<Migration>;
    return typeof r.at === "number" ? { at: r.at, package_dir: typeof r.package_dir === "string" ? r.package_dir : null, steps: Array.isArray(r.steps) ? r.steps.map(String) : [] } : null;
  } catch { return null; }
}

/** What removes the npm copy, in the words a person types. */
export function npmRemovalCommand(): string {
  return `${npmProgram("win32")} uninstall -g @scopebond/agent`;
}

/** Take over from an npm install, if there is one. Only the signed install does this (`kind` per-user or per-machine);
 *  `tray` is the native tray beside it, or null. Returns what it did (empty when there was nothing to do). Never throws. */
export async function migrateFromNpm(dir: string, kind: InstallKind, tray: string | null, log: (line: string) => void, deps: MigrateDeps = defaultMigrateDeps()): Promise<string[]> {
  if (kind === "npm") return [];
  const steps: string[] = [];
  try {
    const found = findNpmInstall(dir, deps);
    if (!hasNpmInstall(found)) return [];
    // 1. The npm agent, while it runs, holds this folder's lock and control channel: ask it to stop first. Only an agent
    //    that is not a signed install itself (an older npm agent does not say what it is).
    const running = await deps.callAgent(dir, "GET", "/status", undefined, 2_000) as { agent?: { install_kind?: unknown } | null } | null;
    const kindOfRunning = running?.agent?.install_kind;
    if (running && kindOfRunning !== "per-user" && kindOfRunning !== "per-machine") {
      await deps.callAgent(dir, "POST", "/stop", {}, 3_000);
      for (let i = 0; i < 40 && await deps.callAgent(dir, "GET", "/status", undefined, 1_000); i++) await deps.sleep(250);
      steps.push("stopped the Scopebond Agent installed with npm");
    }
    // 2. Its sign-in entry and its launcher. Beside the native tray the tray starts the agent; without it, autostart
    //    starts this executable instead (a new launcher and Run value).
    if (tray) {
      if (found.runValue && retireLauncherRunValue(deps.reg)) steps.push("removed the npm agent's ScopebondAgent sign-in entry");
      if (found.npmLauncher) { rmSync(launcherPath(dir, "win32"), { force: true }); steps.push("removed the npm agent's launcher"); }
    } else if (found.npmLauncher) {
      steps.push(deps.enableAutostart(dir));
    }
    // 3. Its Settings -> Apps entry and uninstall script: Windows lists the signed install itself.
    if (found.appsEntry || found.uninstallScript) {
      if (found.appsEntry) deps.reg(["delete", UNINSTALL_KEY, "/f"]);
      rmSync(join(dir, UNINSTALL_SCRIPT), { force: true });
      steps.push("removed the npm agent's entry in Settings -> Apps");
    }
    // 4. The hook entries: every one runs this executable from now on.
    const moved: EntryChange[] = useNativeHookEntries(deps.harnesses(), deps.exe);
    for (const change of moved) steps.push(`${change.reason}: ${change.file}`);
    if (!steps.length && !found.packageDir) return [];
    const told = readMigration(dir);
    const record: Migration = { at: told?.at ?? deps.now(), package_dir: found.packageDir, steps: [...(told?.steps ?? []), ...steps].slice(-20) };
    try { writeFileSync(join(dir, MIGRATED_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 }); } catch { /* said again next time */ }
    for (const step of steps) log(`moving from the npm install: ${step}`);
    // Once: how to remove the npm package, which the agent leaves to the person.
    if (!told && found.packageDir) log(`the Scopebond Agent installed with npm is no longer used; remove it with: ${npmRemovalCommand()}`);
  } catch (error) {
    log(`moving from the npm install did not finish: ${(error as Error).message}`);
  }
  return steps;
}
