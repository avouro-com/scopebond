// The installed package version, read from the package's own package.json at
// runtime. Used to pin the `npx` command the hook installs into the agent config,
// so the harness always runs the exact version the user set up rather than a
// floating latest.

import { readFileSync } from "node:fs";
import { isSingleExecutable } from "./self.js";

/** Set by the single executable's build (esbuild `define`); absent from the npm package. */
declare const __SCOPEBOND_HOOK_VERSION__: string | undefined;

export function hookVersion(): string {
  if (typeof __SCOPEBOND_HOOK_VERSION__ === "string") return __SCOPEBOND_HOOK_VERSION__;
  try {
    // dist/version.js → ../package.json is the package root in both the source
    // tree and the published tarball.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "latest";
  } catch {
    return "latest";
  }
}

/** The command the agent harness runs for each tool call: a version-pinned npx
 *  invocation so a missing global binary is fetched rather than silently skipped
 *  (which a harness can treat as "no hook" and fail open). */
export function hookCommand(harness: "claude" | "cursor" | "codex"): string {
  return `npx -y @scopebond/hook@${hookVersion()} ${harness}`;
}

/** The command a person types to run one of this hook's commands (`log`, `verify`, `rules`, `login`, `connect`, ...), in
 *  the form this installation runs. Every command the hook prints for a person goes through here: the messages a coding
 *  agent shows when an action is blocked, `status`, `doctor`, help and next steps.
 *
 *  - The signed installer's single executable (which is also the Scopebond Agent): `scopebond-agent hook <sub>`. The
 *    installer puts its folder on PATH, and that computer may have no Node.js, so no npm form is printed there.
 *  - An npm install: the version-pinned `npx` form. After `npx @scopebond/hook init` there is no `scopebond-hook` binary on
 *    PATH, so a bare name would fail; `npx` also resolves to a global install when one exists. On Windows it is `npx.cmd`:
 *    PowerShell's default script policy refuses `npx` (which resolves to `npx.ps1`) with "running scripts is disabled on
 *    this system", while `npx.cmd` runs in both PowerShell and cmd. Everywhere else it is plain `npx`.
 *
 *  `native` defaults to whether this process is the single executable; tests pass it. */
export function cliCommand(sub: string, platform: NodeJS.Platform = process.platform, native: boolean = isSingleExecutable()): string {
  if (native) return `scopebond-agent hook ${sub}`;
  return `${platform === "win32" ? "npx.cmd" : "npx"} -y @scopebond/hook@${hookVersion()} ${sub}`;
}
