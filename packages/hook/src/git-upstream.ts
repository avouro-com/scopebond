// The branch a bare push reaches when the current branch cannot be read: what git says the upstream is. A bare `git push`
// (or `git push --force-with-lease` with no refspec) names no destination; the hook fills it with the current branch
// (map.ts `fillPushBranch`). When that cannot be read either, the push used to be judged as one whose destination is unknown,
// and denied. Before that, git is asked for the upstream it would push to, briefly; if git cannot tell, the deny stands.

import { execFileSync } from "node:child_process";
import { programPath } from "@scopebond/gateway/node";

/** How long git may take to answer, at most: the call is on a tool call's path. */
const UPSTREAM_TIMEOUT_MS = 1_500;

/** The branch the upstream of the current branch in `cwd` names (`origin/feature/x` gives `feature/x`), or null when git
 *  cannot tell (no repository, no upstream, a detached head, no answer in time). git is started by its full path from PATH,
 *  never from `cwd`, which is the project and could hold a git of its own. */
export function upstreamBranch(cwd: string, timeoutMs = UPSTREAM_TIMEOUT_MS): string | null {
  let out: string;
  try {
    out = execFileSync(programPath("git"), ["-C", cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch { return null; }
  // `<remote>/<branch>`; an upstream on this repository itself (remote ".") is the branch name alone.
  const slash = out.indexOf("/");
  const branch = slash < 0 ? out : out.slice(slash + 1);
  return branch === "" || branch === "HEAD" || /\s/.test(branch) ? null : branch;
}
