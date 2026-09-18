// Framework adapters: wrap a framework's tool loop around the guard's `check`, so
// a denied tool call returns a synthetic denial result instead of executing. The
// adapters are duck-typed against each framework's tool shape — the framework is
// an optional peer, never a dependency (D40).

import type { ToolGuard } from "./guard.js";

export interface WrapOptions {
  /** Produce the value a denied tool "returns" to the model. Defaults to a string. */
  onDenied?: (toolName: string, reason: string, args: unknown) => unknown;
}

const deniedResult = (opts: WrapOptions, name: string, reason: string, args: unknown): unknown =>
  opts.onDenied ? opts.onDenied(name, reason, args) : `Denied by Scopebond policy: ${reason}`;

// —— Generic ——
// Any framework whose tool has a name and an async execute is covered by these.

/** Wrap a single tool's execute function so it checks policy first. A denied call
 *  returns a synthetic denial result instead of running. Framework-agnostic. */
export function guardExecute<A extends Record<string, unknown>>(
  name: string,
  execute: (args: A, ...rest: unknown[]) => unknown,
  guard: ToolGuard,
  opts: WrapOptions = {},
): (args: A, ...rest: unknown[]) => Promise<unknown> {
  return async (args: A, ...rest: unknown[]) => {
    const decision = await guard.check(name, (args ?? {}) as Record<string, unknown>);
    if (!decision.allowed) return deniedResult(opts, name, decision.reason, args);
    return execute(args, ...rest);
  };
}

export interface FunctionTool {
  name: string;
  execute?: (args: Record<string, unknown>, ...rest: unknown[]) => unknown;
  [key: string]: unknown;
}

/** Wrap a `{ name, execute }` tool (OpenAI Agents SDK, CrewAI, Claude Agent SDK
 *  MCP tools and any framework with function tools). */
export function guardedTool<T extends FunctionTool>(tool: T, guard: ToolGuard, opts: WrapOptions = {}): T {
  if (!tool.execute) return { ...tool };
  return { ...tool, execute: guardExecute(tool.name, tool.execute, guard, opts) };
}

/** Wrap an OpenAI Agents SDK tools array so each tool checks policy before it runs. */
export function wrapOpenAITools<T extends FunctionTool>(tools: T[], guard: ToolGuard, opts: WrapOptions = {}): T[] {
  return tools.map((tool) => guardedTool(tool, guard, opts));
}

// —— Vercel AI SDK ——
// A `tools` record: { [name]: { description?, parameters?/inputSchema?, execute } }.
export interface VercelTool {
  execute?: (args: Record<string, unknown>, options?: unknown) => Promise<unknown> | unknown;
  [key: string]: unknown;
}

/** Wrap a Vercel AI SDK `tools` record so each tool checks policy before it runs. */
export function wrapVercelTools<T extends Record<string, VercelTool>>(tools: T, guard: ToolGuard, opts: WrapOptions = {}): T {
  const wrapped: Record<string, VercelTool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const original = tool.execute;
    wrapped[name] = original
      ? {
          ...tool,
          execute: async (args: Record<string, unknown>, options?: unknown) => {
            const decision = await guard.check(name, args ?? {});
            if (!decision.allowed) return deniedResult(opts, name, decision.reason, args);
            return original(args, options);
          },
        }
      : { ...tool };
  }
  return wrapped as T;
}

// —— LangGraph / LangChain ——
// A tool with `name` and `invoke(input)` (DynamicStructuredTool and friends).
export interface LangChainTool {
  name: string;
  invoke: (input: unknown, config?: unknown) => Promise<unknown> | unknown;
  [key: string]: unknown;
}

/** Wrap a LangChain/LangGraph tool so it checks policy before it runs. Returns a
 *  proxy that preserves the tool instance and overrides only `invoke`. */
export function wrapLangGraphTool<T extends LangChainTool>(tool: T, guard: ToolGuard, opts: WrapOptions = {}): T {
  const originalInvoke = tool.invoke.bind(tool);
  return new Proxy(tool, {
    get(target, prop, receiver) {
      if (prop === "invoke") {
        return async (input: unknown, config?: unknown) => {
          const args = input && typeof input === "object" ? (input as Record<string, unknown>) : { input };
          const decision = await guard.check(target.name, args);
          if (!decision.allowed) return deniedResult(opts, target.name, decision.reason, input);
          return originalInvoke(input, config);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
