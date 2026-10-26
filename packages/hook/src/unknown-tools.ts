// Host tools Scopebond has no taxonomy mapping for. A tool known to be harmless is recorded and not evaluated, as before
// (strict mode denies it through the policy). Any other tool name is answered by the runtime with a deny, or an "ask" where
// the host can ask the person (runtime.ts): an unrecognised tool is never let through unchecked.
//
// A known-safe tool only reads, or only drives the coding agent's own task list, plan, question to the person, or its
// own background work; a tool that writes, runs a command, or reaches a service Scopebond decides on by name (an MCP
// server) is not on these lists. The tools Scopebond maps (shells, file reads and edits, web fetches, MCP calls) are
// mapped in map.ts and never reach these lists.

/** Claude Code tool names (as Claude Code sends them in `tool_name`). GitHub Copilot sends these names too under its
 *  PascalCase events, and its own names are translated to them (map.ts `COPILOT_TOOLS`).
 *  - `TodoWrite`, `TodoRead`: the agent's own task list.
 *  - `EnterPlanMode`, `ExitPlanMode`: plan mode, which only changes how the agent asks before it acts.
 *  - `AskUserQuestion`: a question to the person.
 *  - `WebSearch`: a search the host runs; it only brings back results.
 *  - `ToolSearch`: loads the definitions of the agent's own tools.
 *  - `BashOutput`, `TaskOutput`: read the output of a command the hook already checked; `KillShell`, `KillBash`, `TaskStop`
 *    stop one.
 *  - `Task`, `Agent`: start a sub-agent of the same host. Each tool the sub-agent uses is its own tool call, sent to the same
 *    hook entries; `capabilities` still lists nested orchestration as not covered, as before.
 *  Not on the list: `Skill` and `SlashCommand` (a skill or command file can run shell commands the host runs itself),
 *  `ListMcpResourcesTool` and `ReadMcpResourceTool` (they reach an MCP server outside the MCP rules), and every other name. */
export const CLAUDE_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "TodoWrite", "TodoRead", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "WebSearch", "ToolSearch",
  "BashOutput", "TaskOutput", "KillShell", "KillBash", "TaskStop", "Task", "Agent",
]);

/** GitHub Copilot: the Claude Code names above, and Copilot's own names that map to none of them.
 *  - `read_bash`, `list_bash`, `stop_bash`: read, list or stop a shell session (`write_bash`, which types into one, is
 *    checked as a command).
 *  - `report_intent`: tells the person what the agent is doing.
 *  - `fetch_copilot_cli_documentation`: reads Copilot's own documentation. */
export const COPILOT_SAFE_TOOLS: ReadonlySet<string> = new Set([
  ...CLAUDE_SAFE_TOOLS, "read_bash", "list_bash", "stop_bash", "report_intent", "fetch_copilot_cli_documentation",
]);

/** OpenAI Codex tool names.
 *  - `update_plan`: the agent's own plan.
 *  - `request_user_input`: a question to the person.
 *  - `web_search`: a search the host runs; it only brings back results.
 *  - `spawn_agent`: starts a sub-agent of the same host (as Claude Code's `Task`). */
export const CODEX_SAFE_TOOLS: ReadonlySet<string> = new Set(["update_plan", "request_user_input", "web_search", "spawn_agent"]);

/** Cursor: Scopebond registers only the events it maps (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`,
 *  `afterFileEdit`), so no other event is known to be harmless. */
export const CURSOR_SAFE_EVENTS: ReadonlySet<string> = new Set();

/** The `code` on a decision made because the tool is not one Scopebond knows. */
export const UNKNOWN_TOOL_REASON = "unknown_tool" as const;

/** What the person and the coding agent are told about a tool Scopebond does not know: its name, why it is not let
 *  through, and how to allow it (`allowHow`). `instruction`: the final instruction to the coding agent on a block; null:
 *  the host asks the person instead. */
export function unknownToolReason(tool: string, actionType: string, allowHow: string, instruction: string | null): string {
  const ask = instruction === null;
  const name = tool.length > 80 ? `${tool.slice(0, 80)}…` : tool;
  const shown = name === "" ? "a tool with no name" : `the tool "${name}"`;
  const lead = ask
    ? `Scopebond does not know ${shown}, so it cannot check what it does. Allow it only if you trust it.`
    : `Scopebond blocked ${shown}: Scopebond does not know this tool, so it cannot check what it does.`;
  const allow = `To allow ${actionType} from now on, ${allowHow}. A Scopebond update may also add it.`;
  return ask ? `${lead}\n${allow}` : `${lead}\n${allow}\nWhat to do: ${instruction}`;
}
