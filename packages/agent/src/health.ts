// One line for a person: green, amber or red, what it means, and the one action that fixes it. The tray icon (Windows) and
// the notifications (macOS, Linux) show this; nothing else decides colour.

import type { StatusJson } from "@scopebond/hook";
import { hookCli, setupCli, type CommandContext } from "./commands.js";
import { installKind } from "./native-update.js";

export type HealthLevel = "green" | "amber" | "red";
export interface Health {
  level: HealthLevel;
  headline: string;
  /** The local-channel route that fixes it, with its button label, when one exists. */
  fix: { label: string; route: "/repair" | "/flush" | "/maintain" } | null;
  /** What a person types when no button can fix it. */
  hint: string | null;
}

/** `commands`: how this agent was installed, which decides the commands the hints name (default: this agent's). */
export function healthOf(status: StatusJson, selfCheck: { ok: boolean; failed: string[] } | null | undefined, commands: CommandContext = { kind: installKind(), platform: process.platform }): Health {
  if (status.state === "not_governing") {
    return { level: "red", headline: "Scopebond is not checking any coding agent on this computer", fix: { label: "Repair", route: "/repair" }, hint: null };
  }
  if (!status.delivery.connected) {
    // The signed install signs in from its own tray (Sign in…) or with its own setup, which also writes the hook entries
    // and turns autostart on; an npm install with the hook's sign-in.
    const hint = commands.kind === "npm"
      ? `Connect it: ${hookCli("login https://<your-workspace>", commands)}`
      : `Connect it: Sign in… in the Scopebond icon's menu, or run: ${setupCli("https://<your-workspace>", commands)}`;
    return { level: "red", headline: "Not connected to a workspace: records stay on this computer", fix: null, hint };
  }
  // While the hook's delivery queue cannot be opened, actions stay allowed and are recorded on this computer only; they are
  // sent once the queue can be written again.
  const queueError = (status.delivery as { queue_error?: string | null }).queue_error;
  if (queueError) {
    return { level: "red", headline: "Records stay on this computer: the delivery queue cannot be opened", fix: null, hint: `${queueError}. Free some disk space, or make that file and its -wal and -shm files writable (do not delete it).` };
  }
  if (status.delivery.connection_refused_since !== null) {
    return { level: "red", headline: "The workspace refuses this computer's connection", fix: null, hint: `Sign in again: ${hookCli("login https://<your-workspace>", commands)}` };
  }
  if (status.state === "recording_locally") {
    const n = status.delivery.pending;
    return { level: "amber", headline: `${n} record${n === 1 ? "" : "s"} waiting to be sent`, fix: { label: "Send now", route: "/flush" }, hint: null };
  }
  if (selfCheck && !selfCheck.ok) {
    return { level: "amber", headline: `The daily self-check failed: ${selfCheck.failed.join(", ")}`, fix: { label: "Check again", route: "/maintain" }, hint: null };
  }
  return { level: "green", headline: "Checking your coding agents and delivering to your workspace", fix: null, hint: null };
}
