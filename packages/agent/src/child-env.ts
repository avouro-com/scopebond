// What the agent never hands to a process it starts: the environment variables that make a Node.js program load code of
// someone else's choosing before its own (`NODE_OPTIONS=--require=…`, `--import=…`, and the REPL's external module). Any
// program running as the person can set them for every later sign-in (`setx`), and the agent starts Node programs: the
// updated agent, the hook's commands, npm. They are removed from the agent's own environment when it starts, so every child
// inherits the clean one, and from the environment of a handover, which is built before it is used.

/** The variables removed. */
export const NODE_INJECTION_VARS = ["NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE"] as const;

const injected = (key: string): boolean => (NODE_INJECTION_VARS as readonly string[]).includes(key.toUpperCase());

/** Remove the variables from `env` in place (any case: Windows names are not case-sensitive); returns the names removed. */
export function scrubNodeInjection(env: Record<string, string | undefined> = process.env): string[] {
  const removed = Object.keys(env).filter(injected);
  for (const key of removed) delete env[key];
  return removed;
}

/** A copy of `env` without the variables. */
export function withoutNodeInjection<T extends Record<string, string | undefined>>(env: T): T {
  const copy = { ...env };
  scrubNodeInjection(copy);
  return copy;
}
