// Whether this computer keeps itself delivering and up to date, in the words `status` and `doctor`
// print: the Scopebond version the workspace recommends (it says so on every rules check), and
// whether the Scopebond Agent, which delivers in the background and installs updates, runs here.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The versions the workspace recommends for its computers, as its last rules check said (null: it did not say). */
export interface Recommended { hook: string | null; agent: string | null }

const VERSION = /^\d+\.\d+\.\d+$/;

/** Reads the workspace's recommendation from a rules-check answer; null when it names none. */
export function recommendedFrom(headers: { get(name: string): string | null } | undefined): Recommended | null {
  const read = (name: string) => {
    const value = headers?.get?.(name)?.trim() ?? "";
    return VERSION.test(value) ? value : null;
  };
  const hook = read("x-scopebond-recommended-hook");
  const agent = read("x-scopebond-recommended-agent");
  return hook || agent ? { hook, agent } : null;
}

/** Whether `have` is an older release than `want` (major.minor.patch). */
export function olderVersion(have: string | null | undefined, want: string | null | undefined): boolean {
  if (!have || !want || !VERSION.test(have) || !VERSION.test(want)) return false;
  const a = have.split(".").map(Number), b = want.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

export type AgentPresence = { state: "running"; version: string | null } | { state: "stopped" } | { state: "not_installed" };

/** Whether the Scopebond Agent runs for this user. It writes its process id to `agent.json` in the
 *  Scopebond home while it runs; its launcher stays when it is stopped. `agent.key` is no sign of it:
 *  the hook writes that signing key itself on `init`. */
export function agentPresence(home: string, alive: (pid: number) => boolean = processAlive): AgentPresence {
  try {
    const endpoint = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")) as { pid?: unknown; version?: unknown };
    if (typeof endpoint.pid === "number" && Number.isSafeInteger(endpoint.pid) && endpoint.pid > 0 && alive(endpoint.pid)) {
      return { state: "running", version: typeof endpoint.version === "string" ? endpoint.version : null };
    }
  } catch { /* not running */ }
  const installed = ["agent-launch.cmd", "agent-launch.sh"].some((f) => existsSync(join(home, f)));
  return installed ? { state: "stopped" } : { state: "not_installed" };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const win = () => process.platform === "win32";
const agentCommand = (sub: string) => `scopebond-agent${win() ? ".cmd" : ""} ${sub}`;
const npx = () => (win() ? "npx.cmd" : "npx");

export interface HealthLine { label: string; text: string; problem: boolean }

/** The update and background-agent lines of `status` and `doctor`, each with the one command that fixes it. */
export function healthLines(input: {
  hookVersion: string; recommended: Recommended | null; agent: AgentPresence; connected: boolean; workspaceUrl?: string | null;
}): HealthLine[] {
  const lines: HealthLine[] = [];
  const { hookVersion, recommended, agent } = input;
  if (recommended?.hook && olderVersion(hookVersion, recommended.hook)) {
    lines.push({
      label: "update",
      text: `Scopebond ${hookVersion} is older than the ${recommended.hook} your workspace recommends. Update: ${npx()} -y @scopebond/hook@${recommended.hook} install`
        + (agent.state === "running" ? " (the Scopebond Agent also installs it within six hours)" : ""),
      problem: true,
    });
  }
  if (!input.connected) return lines;
  if (agent.state === "running") {
    if (recommended?.agent && olderVersion(agent.version, recommended.agent)) {
      lines.push({ label: "background agent", text: `running ${agent.version}; it updates itself to ${recommended.agent} within six hours`, problem: false });
    } else {
      lines.push({ label: "background agent", text: `running${agent.version ? ` ${agent.version}` : ""}: records send and Scopebond stays up to date without a coding agent open`, problem: false });
    }
  } else if (agent.state === "stopped") {
    lines.push({ label: "background agent", text: `installed but not running, so records send only while a coding agent works and nothing installs updates. Start it: ${agentCommand("autostart on")}`, problem: true });
  } else {
    const url = input.workspaceUrl ? ` ${input.workspaceUrl}` : " <your workspace>";
    lines.push({ label: "background agent", text: `not installed, so records send only while a coding agent works and nothing installs updates. Install it: ${npx()} -y @scopebond/agent@${recommended?.agent ?? "latest"} setup${url}`, problem: true });
  }
  return lines;
}
