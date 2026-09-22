// The installed package version, read from the package's own package.json at
// runtime. Used to pin the `npx` command the hook installs into the agent config,
// so the harness always runs the exact version the user set up rather than a
// floating latest.

import { readFileSync } from "node:fs";

export function hookVersion(): string {
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
export function hookCommand(harness: "claude" | "cursor"): string {
  return `npx -y @scopebond/hook@${hookVersion()} ${harness}`;
}

/** The command a user runs by hand for a CLI subcommand (`log`, `verify`, `test`,
 *  `init`, `connect`). After `npx @scopebond/hook init` there is no `scopebond-hook`
 *  binary on PATH, so printed guidance must use the same version-pinned `npx` form,
 *  which also resolves to a global install when one exists. */
export function cliCommand(sub: string): string {
  return `${process.platform === "win32" ? "npx.cmd" : "npx"} -y @scopebond/hook@${hookVersion()} ${sub}`;
}
