// The workspace's summary of this computer, for the tray. Optional: a workspace that does not implement
// `GET /v1/computer/summary` (a self-hosted gateway, the fake cloud) answers 404, and the tray leaves those rows out. The tray
// opens only links on the workspace this computer is connected to, never a URL from anywhere else.

import { spawn } from "node:child_process";
import { windowsSystemProgram } from "@scopebond/gateway/node";
import type { HookConnection } from "@scopebond/hook";

export interface ComputerSummary {
  workspace_name: string | null;
  environment_name: string | null;
  computer_name: string | null;
  computer_url: string | null;
  review_url: string | null;
  open_reviews: number;
  stage: string | null;
}

const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length <= max ? v : null);

export async function fetchComputerSummary(connection: HookConnection, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<ComputerSummary | null> {
  try {
    const res = await fetchImpl(`${connection.url.replace(/\/+$/, "")}/v1/computer/summary`, {
      headers: { authorization: `Bearer ${connection.credential}` }, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json() as Record<string, unknown>;
    const link = (v: unknown) => { const s = text(v, 2048); return s && sameOrigin(s, connection.url) ? s : null; };
    return {
      workspace_name: text(body.workspace_name), environment_name: text(body.environment_name), computer_name: text(body.computer_name),
      computer_url: link(body.computer_url), review_url: link(body.review_url),
      open_reviews: Number.isSafeInteger(body.open_reviews) && (body.open_reviews as number) >= 0 ? body.open_reviews as number : 0,
      stage: text(body.stage, 40),
    };
  } catch { return null; }
}

/** Whether `url` is an https (or loopback http) page on the same origin as the workspace. */
export function sameOrigin(url: string, workspace: string): boolean {
  try {
    const a = new URL(url), b = new URL(workspace);
    const safe = a.protocol === "https:" || (a.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(a.hostname));
    return safe && a.origin === b.origin;
  } catch { return false; }
}

/** Open a checked URL in the default browser. */
export function openInBrowser(url: string): void {
  const [command, args] = process.platform === "win32" ? [windowsSystemProgram("explorer"), [url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }); child.on("error", () => {}); child.unref(); } catch { /* no browser */ }
}
