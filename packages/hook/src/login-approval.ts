// What `login` tells its user once a workspace approved the code: which workspace, where it keeps its data, and who
// approved it. Anyone who can see a pending code could approve it into a workspace of their own; naming it lets the person
// at this computer refuse a connection they did not expect before anything is set up.

/** The approval as the workspace states it, or null when an older workspace does not say. */
export function approvalSummary(answer: Record<string, unknown>): string | null {
  const workspace = answer.workspace && typeof answer.workspace === "object" ? answer.workspace as Record<string, unknown> : null;
  const name = typeof workspace?.name === "string" && workspace.name.trim() ? clean(workspace.name) : null;
  if (!name) return null;
  const region = workspace?.region === "eu" ? "EU" : workspace?.region === "us" ? "US" : null;
  const by = typeof answer.approved_by === "string" && answer.approved_by.includes("@") ? clean(answer.approved_by) : null;
  return `Approved into workspace "${name}"${region ? ` (data in the ${region})` : ""}${by ? ` by ${by}` : ""}.`;
}

/** Printable text only: a workspace name is chosen by its owner and reaches this terminal. */
const clean = (text: string): string => text.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, " ").trim().slice(0, 120);

/** Seconds to wait before polling again after the workspace answered 429 or 503: its Retry-After, bounded. */
export function retryAfterSeconds(value: string | null | undefined, fallback = 10): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.max(seconds, 1), 120) : fallback;
}
