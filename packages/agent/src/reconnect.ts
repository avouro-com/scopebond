// SB392 (D143): "Reconnect…" from the tray, with no terminal. The agent runs the hook's own sign-in (`login <workspace>
// --no-install`) for the workspace this computer is already connected to, never a URL from a link or a notification. It reads
// the code the sign-in prints, opens the approval page on that workspace, and the sign-in keeps waiting for the approval in
// the background. The workspace lets the same computer keep its key, so records waiting on it are delivered as they are.

import { spawn, type ChildProcess } from "node:child_process";
import { hookSelfCommand, loadConnection } from "@scopebond/hook";
import { openInBrowser, sameOrigin } from "./summary.js";

export interface ReconnectStart { user_code: string; verification_url: string }

/** The code and approval link in the sign-in's output, or null. */
export function parseLoginPrompt(output: string): ReconnectStart | null {
  const url = /To connect this computer, open:\s+(\S+)/.exec(output)?.[1];
  const code = /shows the code\s+([A-Z]{4}-[A-Z]{4})/.exec(output)?.[1];
  return url && code ? { user_code: code, verification_url: url } : null;
}

export interface Reconnecting { child: ChildProcess; started: ReconnectStart }

/** Start the sign-in. Resolves with the code once the sign-in prints it (or an error); `onDone` runs when it finishes. */
export function startReconnect(dir: string, onDone: (ok: boolean) => void, spawnImpl: typeof spawn = spawn, open: (url: string) => void = openInBrowser): Promise<{ started: ReconnectStart; child: ChildProcess } | { error: string }> {
  const connection = loadConnection(dir);
  if (!connection) return Promise.resolve({ error: "this computer was never connected to a workspace; sign in from a terminal first" });
  const origin = new URL(connection.url).origin;
  // The hook this agent carries: its cli.js from npm, or this same file in the single executable.
  const [program, args] = hookSelfCommand(["login", origin, "--no-install"]);
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawnImpl(program, args, {
      env: { ...process.env, SCOPEBOND_HOME: dir }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ error: "the workspace did not start a sign-in in time" }); } }, 30_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const started = parseLoginPrompt(output);
      if (started && !settled) {
        settled = true; clearTimeout(timer);
        if (sameOrigin(started.verification_url, origin)) open(started.verification_url);
        resolve({ started, child });
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ error: error.message }); } });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!settled) { settled = true; resolve({ error: output.trim().split("\n").at(-1)?.slice(0, 200) || `the sign-in stopped (exit ${code})` }); }
      onDone(code === 0);
    });
  });
}
