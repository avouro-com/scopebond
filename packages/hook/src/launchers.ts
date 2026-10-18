// Package runners: the tool a simple command starts through `npx`, `pnpm exec`, `uv run`, `python -m`, `bundle exec` and
// the like. Engine knowledge (how a runner finds the tool it starts), shared by the rule-pack interpreter (packs.ts) and the
// install detection (typed-install.ts). It reads the command line only.

import { canonProgram, type SimpleCommand } from "./shell.js";

/** A package runner: the options it takes before its subcommand that take a value, its subcommands that run a tool (none:
 *  the tool comes first; `optional`: the tool may also come first, as `pnpm wrangler`), and the options of those
 *  subcommands that take a value (a package to install, a workspace to run in, a file of variables). */
interface Runner { pre: ReadonlySet<string>; subs: readonly string[]; optional?: true; post: ReadonlySet<string> }

const NODE_RUN_VALUED = new Set(["-p", "--package", "-c", "--call", "--filter", "-F", "-C", "--dir", "--workspace-dir", "--prefix", "--cwd", "-w", "--workspace",
  "--cache", "--userconfig", "--registry", "--loglevel", "--reporter", "--shell-mode"]);
const PY_RUN_VALUED = new Set(["--env-file", "--with", "--with-requirements", "--with-editable", "--project", "--package", "--python", "-p", "--group", "--extra",
  "--index", "--index-url", "--extra-index-url", "--find-links", "-f", "--directory", "-C", "-P", "--config-file", "--cache-dir", "--no-group", "--only-group", "-e", "--env",
  "--from", "--default-index"]);

const RUNNERS: Readonly<Record<string, Runner>> = {
  npx: { pre: NODE_RUN_VALUED, subs: [], post: NODE_RUN_VALUED },
  pnpx: { pre: NODE_RUN_VALUED, subs: [], post: NODE_RUN_VALUED },
  bunx: { pre: NODE_RUN_VALUED, subs: [], post: NODE_RUN_VALUED },
  uvx: { pre: PY_RUN_VALUED, subs: [], post: PY_RUN_VALUED },
  pnpm: { pre: NODE_RUN_VALUED, subs: ["exec", "dlx", "x"], optional: true, post: NODE_RUN_VALUED },
  yarn: { pre: NODE_RUN_VALUED, subs: ["exec", "dlx", "x"], optional: true, post: NODE_RUN_VALUED },
  bun: { pre: NODE_RUN_VALUED, subs: ["exec", "dlx", "x"], optional: true, post: NODE_RUN_VALUED },
  npm: { pre: NODE_RUN_VALUED, subs: ["exec", "x"], post: NODE_RUN_VALUED },
  uv: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  poetry: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  pipenv: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  pdm: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  hatch: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  pipx: { pre: PY_RUN_VALUED, subs: ["run"], post: PY_RUN_VALUED },
  bundle: { pre: new Set(["--gemfile"]), subs: ["exec"], post: new Set(["--gemfile"]) },
};

/** The index of the first word at or after `i` that is not an option (or an option's value). */
export function skipOptions(words: readonly string[], i: number, valued: ReadonlySet<string>): number {
  while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
    if (words[i] === "--") return i + 1;
    i += !words[i].includes("=") && valued.has(words[i]) ? 2 : 1;
  }
  return i;
}

export interface Launched {
  /** The runner (`npx`, `pnpm`, `uv`, `python`), or undefined when the program itself is the tool. */
  runner?: string;
  /** The runner's subcommand (`exec`, `dlx`, `run`), when it has one. */
  sub?: string;
  /** The word that names the tool as written (`prisma@5`, `@scope/cli@latest`). */
  spec: string;
  /** The tool's canonical program name: the spec without a version (`prisma`, `@scope/cli`). */
  tool: string;
  /** The tool's own arguments. */
  argv: string[];
  /** The runner's options before the tool (`-y`, `--package x`), for a reader that needs them. */
  runnerArgs: string[];
}

/** The tool a simple command runs: the program itself, or a tool started through a package runner. Null when the command is
 *  opaque or names no tool. */
export function launched(sc: SimpleCommand): Launched | null {
  if (sc.opaque) return null;
  const program = canonProgram(sc.program);
  if (program === "") return null;
  if (program === "python" || program === "python3" || program === "py") {
    // `python -I -m alembic`, `python -X dev -m alembic`: the module after `-m`.
    let k = 0;
    while (k < sc.argv.length && sc.argv[k] !== "-m") { if (!sc.argv[k].startsWith("-")) return null; k += sc.argv[k] === "-X" || sc.argv[k] === "-W" ? 2 : 1; }
    if (sc.argv[k] !== "-m" || sc.argv[k + 1] === undefined) return null;
    const spec = sc.argv[k + 1];
    return { runner: program, sub: "-m", spec, tool: canonProgram(spec), argv: sc.argv.slice(k + 2), runnerArgs: sc.argv.slice(0, k) };
  }
  const runner = RUNNERS[program];
  if (!runner) return null;
  let k = skipOptions(sc.argv, 0, runner.pre);
  let sub: string | undefined;
  if (runner.subs.length) {
    if (runner.subs.includes(sc.argv[k] ?? "")) { sub = sc.argv[k]; k = skipOptions(sc.argv, k + 1, runner.post); }
    else if (!runner.optional) return null;
  }
  const spec = sc.argv[k];
  if (spec === undefined || spec.startsWith("-")) return null;
  const at = spec.lastIndexOf("@");
  return { runner: program, ...(sub ? { sub } : {}), spec, tool: canonProgram(at > 0 ? spec.slice(0, at) : spec), argv: sc.argv.slice(k + 1), runnerArgs: sc.argv.slice(0, k) };
}

/** The names a simple command may run a tool under: its own program (canonical), then the tool a package runner starts. Empty
 *  for an opaque command. What a reader looks a tool up by: a rule pack's grammar names the programs it reads. */
export function toolNames(sc: SimpleCommand): string[] {
  if (sc.opaque) return [];
  const program = canonProgram(sc.program);
  const run = launched(sc);
  return [...(program ? [program] : []), ...(run && run.tool !== program ? [run.tool] : [])];
}
