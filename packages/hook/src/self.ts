// How this program finds itself. Installed from npm it is Node running this package's cli.js; in the single executable
// (one signed file that is both the Scopebond Agent and this hook) it is that file, with `hook` before the command.
// Everything that starts the hook again, and everything that loads Node's SQLite, goes through here, so both builds work.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Whether this process is the single executable (Node's single executable application). */
export function isSingleExecutable(): boolean {
  try { return (process.getBuiltinModule("node:sea") as { isSea?: () => boolean } | undefined)?.isSea?.() === true; } catch { return false; }
}

/** Set to true by the engine bundle's build (esbuild `define`): the bundle is one file that is also the command line. */
declare const __SCOPEBOND_HOOK_BUNDLE__: boolean | undefined;

/** Whether this process runs a signed build: the single executable, or the signed engine bundle (which the executable loads,
 *  and which the agent runs with Node to check it). An npm install is neither. */
export function isSignedBuild(): boolean {
  return isSingleExecutable() || (typeof __SCOPEBOND_HOOK_BUNDLE__ === "boolean" && __SCOPEBOND_HOOK_BUNDLE__);
}

/** This package's command-line program (npm installs; meaningless in the single executable). In the engine bundle it is
 *  the bundle file itself, which Node runs as the command line. */
export function hookCliPath(): string {
  if (typeof __SCOPEBOND_HOOK_BUNDLE__ === "boolean" && __SCOPEBOND_HOOK_BUNDLE__) return fileURLToPath(import.meta.url);
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

/** The program and arguments that run this hook's command line with `args`, in either build. */
export function hookSelfCommand(args: readonly string[]): [string, string[]] {
  return isSingleExecutable() ? [process.execPath, ["hook", ...args]] : [process.execPath, [hookCliPath(), ...args]];
}

/** `node:sqlite` (Node 22.13+). A bundle cannot resolve it through a module path, so it is taken from Node's built-ins. */
export function nodeSqlite<T = { DatabaseSync: new (path: string, options?: Record<string, unknown>) => unknown }>(): T {
  const builtin = process.getBuiltinModule?.("node:sqlite");
  return (builtin ?? createRequire(import.meta.url)("node:sqlite")) as T;
}
