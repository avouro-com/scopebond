// @scopebond/framework — the cooperative (M0) in-process tool guard and per-
// framework adapters. Before an agent runs a tool, it checks your policy and
// records a signed-intent receipt. Enforcement depends on the framework honoring
// the guard; code outside the tool loop is not covered.

export { createToolGuard } from "./guard.js";
export type { ToolGuard, ToolGuardConfig, ToolDecision } from "./guard.js";
export { wrapVercelTools, wrapLangGraphTool, guardExecute, guardedTool, wrapOpenAITools } from "./adapters.js";
export type { WrapOptions, VercelTool, LangChainTool, FunctionTool } from "./adapters.js";
export { generateAgentKey, starterToolPolicy } from "./starter.js";
export { connectCloud } from "./cloud.js";
export type { FrameworkConnection } from "./cloud.js";
