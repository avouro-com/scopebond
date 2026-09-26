// Pinning the hook to a stable path, so the harness does not pay `npx` on every
// tool call.
//
// `init` installs a hook command into the agent's config, and that command runs
// once per tool call — hundreds of times an hour. The obvious command,
// `npx -y @scopebond/hook@<version> claude`, costs about 830 ms a call on a warm
// cache; running the same CLI directly costs about 110 ms. The ~720 ms difference
// is npm resolving a package that is already on disk.
//
// The reason `init` used `npx` anyway is sound: a hook entry that cannot start is
// worse than no hook, because a harness can read the failure as "no hook", and an
// absolute path into npm's `_npx` cache is not durable — npm may clear it.
//
// So: copy the tree npx already materialised into the Scopebond home once per
// machine and per version, and pin *that*. It is durable, self-contained, needs no
// network, lives under the home the governed agent's own policy protects, and
// `doctor` re-checks that the path still resolves. If anything here fails, the
// caller keeps the `npx` form — slow beats broken.

import { existsSync, mkdirSync, cpSync, rmSync, renameSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { userHome } from "./install.js";

/** Where pinned copies live: one directory per hook version. */
export function runtimeRoot(): string {
  return join(userHome(), "runtime");
}

export function runtimeDirFor(version: string): string {
  return join(runtimeRoot(), version);
}

/** The CLI inside a pinned copy. */
export function pinnedCliPath(version: string): string {
  return join(runtimeDirFor(version), "node_modules", "@scopebond", "hook", "dist", "cli.js");
}

/** True when a path sits in npm's throwaway `npx` cache, which npm may clear at any
 *  time. Anything else — a project `node_modules`, a global install, a pinned copy —
 *  is durable enough to reference from a config file. */
export function isEphemeralPath(file: string): boolean {
  return `${sep}${file.replace(/[\\/]/g, sep)}${sep}`.includes(`${sep}_npx${sep}`);
}

/** Walk up from `dist/cli.js` to the `node_modules` directory that contains the whole
 *  materialised dependency tree (`node_modules/@scopebond/hook/dist/cli.js` → four up).
 *  Returns null if the layout is not what we expect, rather than copying the wrong thing. */
export function nodeModulesRootOf(cliFile: string): string | null {
  let dir = dirname(cliFile); // .../dist
  for (let i = 0; i < 6; i += 1) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    if (parent.endsWith(`${sep}node_modules`) || parent.endsWith("/node_modules")) return parent;
    dir = parent;
  }
  return null;
}

/** A pinned copy is usable only if the CLI and its sibling packages are all there —
 *  a half-copied tree would fail closed on every tool call. */
function pinnedCopyIsComplete(version: string): boolean {
  const cli = pinnedCliPath(version);
  if (!existsSync(cli)) return false;
  const scope = join(runtimeDirFor(version), "node_modules", "@scopebond");
  try {
    // The hook cannot run without the gateway and sdk it imports at startup.
    const names = new Set(readdirSync(scope));
    return names.has("hook") && names.has("gateway") && names.has("sdk");
  } catch { return false; }
}

export interface PinResult {
  /** The CLI path to pin, or null to keep the `npx` form. */
  cli: string | null;
  /** Why, in one phrase, for the line `init` prints. */
  how: "already-durable" | "pinned" | "reused" | "unavailable";
}

/** Make sure a durable copy of this CLI exists and say which path to pin.
 *
 *  Never throws: every failure degrades to `{ cli: null }` so the caller falls back
 *  to `npx`, which is slower but always starts. */
export function ensureDurableRuntime(cliFile: string, version: string): PinResult {
  try {
    if (!existsSync(cliFile)) return { cli: null, how: "unavailable" };
    // Already installed somewhere npm will not delete — pin it as it stands.
    if (!isEphemeralPath(cliFile)) return { cli: cliFile, how: "already-durable" };
    if (pinnedCopyIsComplete(version)) return { cli: pinnedCliPath(version), how: "reused" };
    const source = nodeModulesRootOf(cliFile);
    if (!source || !existsSync(source)) return { cli: null, how: "unavailable" };
    const target = runtimeDirFor(version);
    // Copy to a staging directory and move it into place, so an interrupted copy
    // never leaves a partial tree that looks complete.
    const staging = `${target}.incoming-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    cpSync(source, join(staging, "node_modules"), { recursive: true, dereference: true });
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
    if (!pinnedCopyIsComplete(version)) {
      rmSync(target, { recursive: true, force: true });
      return { cli: null, how: "unavailable" };
    }
    return { cli: pinnedCliPath(version), how: "pinned" };
  } catch {
    return { cli: null, how: "unavailable" };
  }
}
