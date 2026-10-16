// Framework adapters: wrap a framework's tool loop around the guard's `check`, so
// a denied tool call returns a synthetic denial result instead of executing. The
// adapters are duck-typed against each framework's tool shape — the framework is
// an optional peer, never a dependency.

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
    const decision = await guard.check(name, (args ?? {}));
    if (!decision.allowed) return deniedResult(opts, name, decision.reason, args);
    return execute(args, ...rest);
  };
}

export interface FunctionTool {
  name: string;
  execute?: (args: Record<string, unknown>, ...rest: unknown[]) => unknown;
  [key: string]: unknown;
}

/** Wrap a function-tool *definition* — `{ name, execute }` — so `execute` checks
 *  policy first. Use this on the definition you pass to the framework's tool
 *  constructor (OpenAI Agents SDK `tool({ name, execute })`, CrewAI, Claude Agent
 *  SDK function tools), not on an already-constructed tool object.
 *
 *  It throws if the tool has no `execute` function, rather than returning it
 *  unguarded: a silent passthrough on a shape it does not recognize would let a
 *  tool run with no policy check, which is exactly the failure a guard must not
 *  have. A tool exposed only through a runtime `invoke` (a constructed OpenAI
 *  Agents tool) is not guardable here — wrap its `execute` at definition time. */
export function guardedTool<T extends FunctionTool>(tool: T, guard: ToolGuard, opts: WrapOptions = {}): T {
  if (typeof tool.execute !== "function") {
    throw new Error(
      `scopebond: cannot guard tool "${tool.name ?? "<unnamed>"}" — it has no execute() function. ` +
      "Wrap the tool definition's execute before constructing the tool, or use guardExecute() directly.",
    );
  }
  return { ...tool, execute: guardExecute(tool.name, tool.execute, guard, opts) };
}

/** Wrap an array of OpenAI Agents SDK tool *definitions* so each `execute` checks
 *  policy before it runs. Throws on any tool lacking `execute` (never silently
 *  unguarded). Wrap definitions, then pass them to `tool()`/the agent. */
export function wrapOpenAITools<T extends FunctionTool>(tools: T[], guard: ToolGuard, opts: WrapOptions = {}): T[] {
  return tools.map((tool) => guardedTool(tool, guard, opts));
}

// —— Vercel AI SDK ——
// A `tools` record: { [name]: { description?, parameters?/inputSchema?, execute } }.
export interface VercelTool {
  /** Returns the result, or a promise of it. */
  execute?: (args: Record<string, unknown>, options?: unknown) => unknown;
  [key: string]: unknown;
}

/** Wrap a Vercel AI SDK `tools` record so each tool checks policy before it runs.
 *
 *  Like `guardedTool`, it throws on a tool with no `execute` function rather than return it
 *  unguarded. A tool the app deliberately runs on the client (no `execute`) is outside what the
 *  guard can check: keep it out of the record you wrap and add it beside the wrapped tools. */
export function wrapVercelTools<T extends Record<string, VercelTool>>(tools: T, guard: ToolGuard, opts: WrapOptions = {}): T {
  const wrapped: Record<string, VercelTool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const original = tool?.execute;
    if (typeof original !== "function") {
      throw new Error(
        `scopebond: cannot guard tool "${name}" — it has no execute() function. ` +
        "A client-side tool is not checked by the guard: leave it out of the record passed to wrapVercelTools.",
      );
    }
    wrapped[name] = {
      ...tool,
      execute: async (args: Record<string, unknown>, options?: unknown) => {
        const decision = await guard.check(name, args ?? {});
        if (!decision.allowed) return deniedResult(opts, name, decision.reason, args);
        return original(args, options);
      },
    };
  }
  return wrapped as T;
}

// —— LangGraph / LangChain ——
// A tool with `name` and `invoke(input)` (DynamicStructuredTool and friends).
export interface LangChainTool {
  name: string;
  /** Returns the result, or a promise of it. */
  invoke: (input: unknown, config?: unknown) => unknown;
  [key: string]: unknown;
}

/** The methods through which a LangChain-style tool runs. Each one present on the tool is
 *  guarded, so calling `call`, `_call`, `func`, `stream` or `batch` directly cannot skip the
 *  policy check that `invoke` has.
 *
 *  `invoke` and `call` (and `stream`/`batch`, which run `invoke`) take the tool's *input*: the
 *  arguments, or a LangGraph ToolCall (`{ name, args, id, type: "tool_call" }`) that the tool
 *  unwraps itself and parses with its schema before running. `_call` and `func` take arguments
 *  that are already parsed. */
const LANGCHAIN_INPUT_ENTRY_POINTS = ["invoke", "call"] as const;
const LANGCHAIN_PARSED_ENTRY_POINTS = ["_call", "func"] as const;

/** LangChain's own test for a ToolCall (`_isToolCall` in `@langchain/core`): `invoke` and `call`
 *  run such an input with `input.args`, not with the envelope. */
const isToolCall = (input: unknown): input is { name?: unknown; args?: unknown; type: "tool_call" } =>
  !!input && typeof input === "object" && (input as { type?: unknown }).type === "tool_call";

const isPlainArgs = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Wrap a LangChain/LangGraph tool so it checks policy before it runs. Returns a
 *  proxy that preserves the tool instance and guards every entry point it has
 *  (`invoke`, `call`, `_call`, `func`, `stream`, `batch`). The originals run against
 *  the unwrapped tool, so one allowed call is checked once.
 *
 *  The check sees the arguments the tool will run with. A ToolCall input (how LangGraph's
 *  `ToolNode` runs every tool) is checked on its `args`, and a ToolCall naming a different tool
 *  is denied. When the tool has a schema with `parseAsync` (a zod schema), the check sees the
 *  arguments after that parsing, as the tool does. */
export function wrapLangGraphTool<T extends LangChainTool>(tool: T, guard: ToolGuard, opts: WrapOptions = {}): T {
  type Fn = (...a: unknown[]) => unknown;
  type Decision = { denied: false } | { denied: true; value: unknown };
  const check = async (args: Record<string, unknown>, input: unknown): Promise<Decision> => {
    const decision = await guard.check(tool.name, args);
    return decision.allowed ? { denied: false } : { denied: true, value: deniedResult(opts, tool.name, decision.reason, input) };
  };
  const asArgs = (value: unknown): Record<string, unknown> => (isPlainArgs(value) ? value : { input: value });
  // Through invoke/call/stream/batch: the arguments the tool runs `input` with.
  const decideInput = async (input: unknown): Promise<Decision> => {
    let raw = input;
    if (isToolCall(input)) {
      if (input.name !== tool.name) {
        const reason = `the tool call names "${String(input.name)}", not "${tool.name}"`;
        return { denied: true, value: deniedResult(opts, tool.name, reason, input) };
      }
      raw = input.args;
    }
    let args = raw;
    const schema = (tool as Record<string, unknown>).schema as { parseAsync?: unknown } | null | undefined;
    if (schema && typeof schema.parseAsync === "function" && isPlainArgs(raw)) {
      try {
        const parsed = await (schema.parseAsync as (v: unknown) => Promise<unknown>).call(schema, raw);
        if (isPlainArgs(parsed)) args = parsed;
      } catch {
        // The tool refuses input its schema rejects, so it does not run; check the raw arguments.
      }
    }
    return check(asArgs(args), input);
  };
  // Through `_call` and `func`: exactly what they are given.
  const decideParsed = (input: unknown): Promise<Decision> => check(asArgs(input), input);
  const original = (prop: string): Fn | undefined => {
    const fn = (tool as Record<string, unknown>)[prop];
    return typeof fn === "function" ? (fn as Fn).bind(tool) : undefined;
  };
  const wrappers = new Map<PropertyKey, Fn>();
  const guardEntry = (prop: string, decide: (input: unknown) => Promise<Decision>): void => {
    const fn = original(prop);
    if (!fn) return;
    wrappers.set(prop, async (input: unknown, ...rest: unknown[]) => {
      const d = await decide(input);
      return d.denied ? d.value : fn(input, ...rest);
    });
  };
  for (const prop of LANGCHAIN_INPUT_ENTRY_POINTS) guardEntry(prop, decideInput);
  for (const prop of LANGCHAIN_PARSED_ENTRY_POINTS) guardEntry(prop, decideParsed);
  const stream = original("stream");
  if (stream) {
    wrappers.set("stream", async (input: unknown, ...rest: unknown[]) => {
      const d = await decideInput(input);
      if (!d.denied) return stream(input, ...rest);
      return (async function* () { yield await d.value; })(); // the same as `yield d.value`: an async generator awaits what it yields
    });
  }
  const batch = original("batch");
  const invoke = original("invoke");
  if (batch) {
    wrappers.set("batch", async (inputs: unknown, ...rest: unknown[]) => {
      if (!Array.isArray(inputs)) throw new TypeError(`scopebond: ${tool.name}.batch() expects an array of inputs`);
      const decisions = await Promise.all(inputs.map((input) => decideInput(input)));
      if (decisions.every((d) => !d.denied)) return batch(inputs, ...rest);
      // Some inputs are denied: run only the allowed ones, one by one, and keep the order.
      const config = Array.isArray(rest[0]) ? undefined : rest[0];
      return Promise.all(inputs.map((input, i) => {
        const d = decisions[i];
        if (d.denied) return d.value;
        if (!invoke) throw new TypeError(`scopebond: ${tool.name} has no invoke() to run an allowed batch item`);
        return invoke(input, config);
      }));
    });
  }
  return new Proxy(tool, {
    get(target, prop, receiver) {
      const wrapper = wrappers.get(prop);
      return wrapper ?? Reflect.get(target, prop, receiver);
    },
  });
}
