// Workspace-root scope for mutating file intents.
//
// A lexical check ("does the path start with the workspace?") is not a boundary: `..`
// segments, a symlink or an NTFS junction inside the workspace, and a rename whose
// destination lands elsewhere all leave the text looking in-scope. This module resolves
// the path physically — the nearest existing ancestor through the filesystem's own
// realpath, so links and junctions are followed — and compares the result with the
// allowed roots.
//
// Unknown is not clean: a path that cannot be resolved (permission error, loop, a
// component that is not a directory) is `unresolved`, and the compiled policy denies it
// like an outside path. Nothing here is consulted unless the rule set lists
// `allowed_roots`, so the default policy is unchanged.

import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { Mapped } from "./map.js";

export type RootScope = "inside" | "outside" | "unresolved";

export interface RootOptions {
  cwd: string;
  /** Allowed roots. `.` (or an empty string) means the working directory. */
  roots: string[];
  /** Injected for tests; defaults to `fs.realpathSync.native`. */
  realpath?: (path: string) => string;
}

const looksWindows = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || (p.includes("\\") && !p.startsWith("/"));

/** Resolve the physical location of `path` (which may not exist yet). Follows links for
 *  the nearest existing ancestor and re-attaches the not-yet-created remainder. */
function physical(path: string, api: typeof posix | typeof win32, realpath: (p: string) => string): string | null {
  let probe = path;
  const rest: string[] = [];
  for (let guard = 0; guard < 4096; guard++) {
    try {
      const real = realpath(probe);
      return rest.length ? api.join(real, ...rest.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return null;
      const parent = api.dirname(probe);
      if (parent === probe) return null;
      rest.push(api.basename(probe));
      probe = parent;
    }
  }
  return null;
}

/** Classify where a write to `path` lands relative to the allowed roots. */
export function classifyRoot(path: string, options: RootOptions): RootScope {
  const realpath = options.realpath ?? ((p: string) => realpathSync.native(p));
  const windows = looksWindows(options.cwd) || looksWindows(path);
  const api = windows ? win32 : posix;
  if (path === "" || path.includes("\0")) return "unresolved";
  // The mapper writes paths with "/"; give the platform API the spelling it expects.
  const spelled = windows ? path.replace(/\//g, "\\") : path;
  const absolute = api.resolve(options.cwd, spelled);
  const target = physical(absolute, api, realpath);
  if (target === null) return "unresolved";
  const fold = (p: string): string => (windows ? p.toLowerCase() : p);
  for (const root of options.roots.length ? options.roots : ["."]) {
    const rootAbs = api.resolve(options.cwd, root === "" ? "." : windows ? root.replace(/\//g, "\\") : root);
    const rootPhysical = physical(rootAbs, api, realpath) ?? rootAbs;
    const a = fold(target);
    const b = fold(rootPhysical);
    const sep = windows ? "\\" : "/";
    const prefix = b.endsWith(sep) ? b : b + sep;
    if (a === b || a.startsWith(prefix)) return "inside";
  }
  return "outside";
}

/** Set `root_scope` on every file.write intent (the file, a rename destination and a
 *  link target alike). Returns new objects; the input is not modified. */
export function applyRootScope(mapped: Mapped[], options: RootOptions): Mapped[] {
  return mapped.map((m) => {
    if (m.intent.action_type !== "file.write") return m;
    const path = String(m.intent.params.path ?? "");
    // A write whose target the mapper could not name is already not evaluated; keep it.
    if (!m.evaluated) return m;
    return { ...m, intent: { ...m.intent, params: { ...m.intent.params, root_scope: classifyRoot(path, options) } } };
  });
}
