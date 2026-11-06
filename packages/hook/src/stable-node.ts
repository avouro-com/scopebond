// The Node a hook entry names. A pinned hook entry runs `<node> <cli.js> <harness>` by absolute path, so it does not
// depend on the coding agent's PATH. When that Node belongs to a version manager (fnm, Volta, nvm, asdf, mise, nodenv),
// its path names one installed version, and uninstalling that version (`fnm uninstall 22.20.0`) leaves every hook entry
// pointing at nothing. Claude Code, Codex and Cursor treat a hook that cannot start as a non-blocking error, so every
// action would then run unchecked.
//
// So a version-managed Node is swapped, when one can be found, for a launcher that outlives a version change:
//
//   1. fnm's default alias (`<fnm dir>/aliases/default/bin/node`): a link fnm moves when the default version changes, and
//      a fixed Node whatever folder the coding agent runs the hook in.
//   2. A Node installed outside any version manager at a fixed path (Homebrew's /opt/homebrew/bin/node, /usr/local/bin,
//      /usr/bin): upgraded in place, and its path stays.
//
// Each candidate must exist, start, and be a Node the hook supports (MIN_NODE). Not used, on purpose:
//   - `/usr/bin/env node`: whichever `node` is first on the coding agent's PATH, which an app started from the Dock does
//     not share with the terminal, and which a project folder can change.
//   - Volta, asdf and mise shims: they pick the Node pinned by the project the hook runs in, which can be one too old for
//     the hook (a project pinned to Node 18), so the hook would fail to start in exactly that project.
//   - nvm: it has no stable binary path (its default alias is a file naming a version, not a link).
// When nothing qualifies the running Node is kept, and the health checks (`hookCommandResolves`: doctor, the agent's
// self-check and upkeep, integration health) notice when it goes away and write the entry again with a Node that exists.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The oldest Node the hook runs on (package.json `engines`). */
export const MIN_NODE = "22.13.0";

/** Folders that hold one version of Node installed by a version manager. */
const VERSION_MANAGED = [
  /[\\/]node-versions[\\/][^\\/]+[\\/]installation[\\/]/, // fnm
  /[\\/]fnm_multishells[\\/]/, // fnm's per-shell links
  /[\\/]\.volta[\\/]tools[\\/]image[\\/]node[\\/]/, // Volta
  /[\\/]\.?nvm[\\/]versions[\\/]node[\\/]/, // nvm (also under NVM_DIR elsewhere)
  /[\\/]versions[\\/]node[\\/]v\d+\.\d+\.\d+[\\/]/, // nvm with any NVM_DIR
  /[\\/]\.?asdf[\\/]installs[\\/]nodejs[\\/]/, // asdf
  /[\\/]mise[\\/]installs[\\/]node[\\/]/, // mise
  /[\\/]rtx[\\/]installs[\\/]node[\\/]/, // mise under its old name
  /[\\/]\.nodenv[\\/]versions[\\/]/, // nodenv
];

/** Whether `path` is a Node installed by a version manager (one version, which can be uninstalled). */
export function isVersionManagedNode(path: string): boolean {
  return VERSION_MANAGED.some((re) => re.test(path));
}

export interface StableNodeDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
  /** The Node version `path` reports (`22.20.0`), or null when it does not start. */
  version: (path: string) => string | null;
}

const systemDeps = (): StableNodeDeps => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
  exists: existsSync,
  realpath: (p) => realpathSync(p),
  version: (p) => {
    const run = spawnSync(p, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5_000, windowsHide: true, env: { PATH: process.env.PATH ?? "" } });
    return run.status === 0 ? run.stdout.trim() : null;
  },
});

const atLeast = (version: string, min: string): boolean => {
  const a = version.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** fnm's own folders: FNM_DIR, the folder the running Node is in, then fnm's defaults. */
function fnmDirs(execPath: string, d: StableNodeDeps): string[] {
  const dirs: string[] = [];
  if (d.env.FNM_DIR) dirs.push(d.env.FNM_DIR);
  let real = execPath;
  try { real = d.realpath(execPath); } catch { /* the path as given */ }
  const m = /^(.*)[\\/]node-versions[\\/]/.exec(real);
  if (m) dirs.push(m[1]);
  if (d.platform === "win32") {
    if (d.env.APPDATA) dirs.push(join(d.env.APPDATA, "fnm"));
  } else {
    dirs.push(join(d.env.XDG_DATA_HOME || join(d.home, ".local", "share"), "fnm"));
    if (d.platform === "darwin") dirs.push(join(d.home, "Library", "Application Support", "fnm"));
    dirs.push(join(d.home, ".fnm"));
  }
  return [...new Set(dirs)];
}

/** The launchers tried in order, for a version-managed Node (see the top of this file). */
export function stableNodeCandidates(execPath: string, deps: Partial<StableNodeDeps> = {}): string[] {
  const d = { ...systemDeps(), ...deps };
  const alias = fnmDirs(execPath, d).map((dir) => d.platform === "win32" ? join(dir, "aliases", "default", "node.exe") : join(dir, "aliases", "default", "bin", "node"));
  const system = d.platform === "win32"
    ? [join(d.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe")]
    : ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  return [...alias, ...system];
}

const cache = new Map<string, string>();

/** The Node a hook entry should name: `execPath` itself unless it is a version-managed Node and a stable launcher that
 *  starts a supported Node exists (see the top of this file). Remembered per process. */
export function stableNodePath(execPath: string = process.execPath, deps: Partial<StableNodeDeps> = {}): string {
  const injected = Object.keys(deps).length > 0;
  if (!injected && cache.has(execPath)) return cache.get(execPath)!;
  const d = { ...systemDeps(), ...deps };
  let chosen = execPath;
  if (isVersionManagedNode(execPath) || (() => { try { return isVersionManagedNode(d.realpath(execPath)); } catch { return false; } })()) {
    for (const candidate of stableNodeCandidates(execPath, d)) {
      if (candidate === execPath || !d.exists(candidate)) continue;
      // A system candidate that is itself only a link into a version manager would break the same way.
      const isAlias = /[\\/]aliases[\\/]default[\\/]/.test(candidate);
      if (!isAlias) { try { if (isVersionManagedNode(d.realpath(candidate))) continue; } catch { continue; } }
      const v = d.version(candidate);
      if (v && /^\d+\.\d+\.\d+$/.test(v) && atLeast(v, MIN_NODE)) { chosen = candidate; break; }
    }
  }
  if (!injected) cache.set(execPath, chosen);
  return chosen;
}
