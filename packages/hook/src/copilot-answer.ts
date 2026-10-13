// What the hook writes for a GitHub Copilot `deny` or `ask`. No imports, so the fail-closed handlers in cli.ts and
// hook-deadline.ts can use it before anything else loads.

/** Why an "ask" is a deny in the Copilot cloud agent, said in the deny itself. */
export const COPILOT_CLOUD_ASK_IS_DENY = "this action needs a person's approval, and the Copilot cloud agent has no one to ask, so it is denied";

export interface CopilotAnswer { stdout: string; stderr: string; exitCode: 0 | 2 }

/** What the hook writes for a Copilot `deny` or `ask`.
 *
 *  The decision is written in both shapes Copilot's surfaces read: the top-level `permissionDecision` and
 *  `permissionDecisionReason` (GitHub's hooks reference, "preToolUse decision control"; the Copilot CLI and VS Code's
 *  Copilot session target) and `hookSpecificOutput` (VS Code's Local hooks reference, "PreToolUse Output"). Both say the
 *  same thing, so whichever one a surface reads, the answer is the same.
 *
 *  A deny also exits 2, which the CLI treats as a deny whatever stdout says and the Local harness treats as a blocking
 *  error with stderr given to the model, so a deny holds even if the JSON were not read. An `ask` in the cloud agent
 *  (`cloud`) is answered as a deny with the reason spelled out: the cloud agent turns every "ask" into a deny because no
 *  one can answer it, and the agent should be told why rather than see a bare refusal. */
export function copilotAnswer(decision: "deny" | "ask", reason: string, cloud: boolean): CopilotAnswer {
  if (decision === "ask" && cloud) return copilotAnswer("deny", `Scopebond: ${COPILOT_CLOUD_ASK_IS_DENY}. ${reason.replace(/^Scopebond:\s*/, "")}`, cloud);
  const body = {
    permissionDecision: decision, permissionDecisionReason: reason,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  };
  const stdout = JSON.stringify(body) + "\n";
  if (decision === "ask") return { stdout, stderr: "", exitCode: 0 };
  return { stdout, stderr: `${reason.startsWith("Scopebond") ? reason : `Scopebond: ${reason}`}\n`, exitCode: 2 };
}
