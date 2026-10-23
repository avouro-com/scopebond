import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Harness } from "./adapters.js";
import { requestOverSocket } from "./local-socket.js";

export const HOOK_ACTIVITY_ROUTE = "/integration/callback";
export const HOOK_ACTIVITY_EVENTS = ["decision", "session_start", "session_end", "outcome"] as const;
export type HookActivityEvent = typeof HOOK_ACTIVITY_EVENTS[number];
export interface HookActivityReport { version: 1; id: string; harness: Harness; event: HookActivityEvent; sent_at: number }

/** Best-effort local telemetry, independent of Cloud enrollment. Authentication identifies a local caller,
 * not a native coding-tool process; this report cannot establish trust, execution success or coverage. */
export async function reportHookActivity(home: string, harness: Harness, event: HookActivityEvent): Promise<boolean> {
  try {
    const endpoint = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")) as { socket?: unknown; token?: unknown };
    if (typeof endpoint.socket !== "string" || !endpoint.socket || typeof endpoint.token !== "string" || endpoint.token.length > 200) return false;
    if (process.platform === "win32" ? !/^\\\\\.\\pipe\\scopebond-agent-[0-9a-f]{32}$/.test(endpoint.socket) : !isAbsolute(endpoint.socket)) return false;
    // Use only the authenticated local pipe/socket. An older endpoint without it simply lacks this optional telemetry.
    const report: HookActivityReport = { version: 1, id: randomUUID(), harness, event, sent_at: Date.now() };
    const answer = await requestOverSocket(endpoint.socket, "POST", HOOK_ACTIVITY_ROUTE,
      { "x-scopebond-agent-token": endpoint.token }, report, 20);
    return answer?.status === 200 && (answer.body as { accepted?: unknown } | null)?.accepted === true;
  } catch { return false; }
}
