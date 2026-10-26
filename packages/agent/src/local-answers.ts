// What an answer that arrives on the agent's local channel may do. The channel's token is in a file this computer's user can
// read, so any program running as that user (the coding agent among them) can send an answer: nothing on the channel shows
// that a person gave it. Until a local service can tell who is calling, an answer from the channel is applied on this
// computer only for the next try of that one action ("once"), and the allowance it makes is marked `local_unverified` in
// the record sent to the workspace. A longer choice (15 minutes, an hour, until tomorrow, "always", similar commands) is
// never applied here: it becomes a request ("Ask an admin") that a person approves in the workspace. Without a workspace,
// only once is possible. Asking an admin and keeping an action blocked allow nothing, and stay as they were.

import { readAllowances, writeAllowances, type SimilarOffer } from "@scopebond/hook";

/** The mark on an allowance made from an answer on the local channel: not verified to come from a person. */
export const LOCAL_APPROVAL = "local_unverified" as const;

const LONGER: readonly string[] = ["fifteen", "hour", "tomorrow", "always"];

/** Whether a choice would let more than the next try of this one action through (a length, "always", or similar commands). */
export function persistentChoice(choice: unknown, scope?: unknown): boolean {
  return scope === "similar" || (typeof choice === "string" && LONGER.includes(choice));
}

interface TrayOffers {
  once: boolean; fifteen: boolean; hour: boolean; tomorrow: boolean; always: boolean; always_days: number | null; always_needs_admin: boolean; ask: boolean;
  similar?: SimilarOffer | null;
}

/** What the tray may offer for a block from here: once as the workspace offers it; the lengths not at all; "always" and
 *  similar commands only as a request an admin approves (marked as needing one), and only on a computer connected to a
 *  workspace that takes requests for the block. */
export function localOffers<T extends TrayOffers>(offers: T, connected: boolean): T {
  const canRequest = connected && offers.ask;
  const always = offers.always && canRequest;
  return {
    ...offers, fifteen: false, hour: false, tomorrow: false, always, always_days: always ? offers.always_days : null, always_needs_admin: always,
    ...("similar" in offers ? { similar: canRequest && offers.similar ? { ...offers.similar, needs_admin: true } : null } : {}),
  };
}

/** Why a longer choice cannot be sent as a request from here, or null when it can: the computer is not connected, or the
 *  workspace takes no requests for this block. Says that once is all this computer can allow. */
export function longerRefused(connected: boolean, askOffered: boolean, onceOffered: boolean): { outcome: "needs_workspace" | "not_offered"; text: string } | null {
  const once = onceOffered ? "it can only be allowed once from here" : "it can only be allowed once from here, and this block does not offer that";
  if (!connected) return { outcome: "needs_workspace", text: `This computer is not connected to a workspace, so ${once}.` };
  if (!askOffered) return { outcome: "not_offered", text: `Your workspace does not take requests for this block, so ${once}.` };
  return null;
}

/** What the tray says after a longer choice was sent as a request: what was asked for, the command, and whether the action
 *  is allowed once now. */
export function requestedText(choice: string, allowedOnce: boolean, alwaysDays: number, workspace: string | null, command: string | null, similar = false): string {
  const on = command ? `: ${command.length > 120 ? `${command.slice(0, 119)}…` : command}` : "";
  const span = choice === "fifteen" ? "for 15 minutes" : choice === "hour" ? "for 1 hour" : choice === "tomorrow" ? "until tomorrow"
    : `for ${alwaysDays} day${alwaysDays === 1 ? "" : "s"}`;
  const what = `${similar ? "similar commands " : ""}${span}`;
  const where = workspace ?? "your workspace";
  return allowedOnce
    ? `Allowed once now${on} · asked ${where} to allow ${what}; an admin decides`
    : `Request sent to allow ${what}${on} · an admin decides in ${where}`;
}

/** Mark the allowances a person-side answer made just now for this action as `local_unverified` (the record sent to the
 *  workspace carries it; a workspace that does not know the field ignores it). */
export function markLocalApproval(dir: string, actionKey: string, now: number): void {
  const at = new Date(now).toISOString();
  try {
    writeAllowances(dir, readAllowances(dir).map((a) => (a.created_by === "person" && a.action_key === actionKey && a.created_at === at && !a.sent_at
      ? { ...a, approval: LOCAL_APPROVAL } : a)), now);
  } catch { /* the allowance stands; it is sent without the mark */ }
}
