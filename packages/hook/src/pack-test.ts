// `packs test <file|folder>…`: check rule pack files and run each pack's vectors through the real engine, for a pack's author
// and for CI.
//
// For each pack file (a folder means every `.json` file directly in it, in name order):
//   - the pack is checked as a local pack is (pack-local.ts `checkLocalPackText`): the closed format at this engine's level (its
//     `signature` may be left out), the engine level and action types it needs; and each of its rules must be one a local pack
//     may add to the starter policy (pack-rules.ts `localRuleProblem`). A pack that fails is reported and not run;
//   - each vector's input derives exactly the actions it expects (packs.ts `runPackVectors`): this is what passes or fails;
//   - each vector's input is also decided by the hook's runtime, with the starter policy and this pack alone in force as a local
//     pack, in a throwaway folder: the decision (allow, deny, ask, not_evaluated) and the rule that matched are reported beside
//     the result, so an author sees what a rule does with its default mode.
// Nothing here reads or changes this computer's own policy, packs or records.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packRef, type Pack } from "@scopebond/policy-schema/pack";
import { scaffold } from "./init.js";
import { mapClaudeToolUse } from "./map.js";
import { checkLocalPackText } from "./pack-local.js";
import { coveredTypes, localRuleProblem } from "./pack-rules.js";
import { activePacks, localPackIds, runPackVectors, setActivePacks, shadowPackIds } from "./packs.js";
import { createHookRuntime } from "./runtime.js";
import { hookVersion } from "./version.js";

/** One vector's outcome: whether it derived what it expects, and what the runtime decided for its input. */
export interface PackTestRow {
  pack: string;
  vector: string;
  pass: boolean;
  decision: "allow" | "deny" | "ask" | "not_evaluated" | "error";
  /** The rule that blocked (`deny`), or that recorded a match without blocking; null when none matched. */
  rule: string | null;
  expected?: unknown;
  actual?: unknown;
}

export interface PackTestReport {
  engine: string;
  /** The packs whose vectors ran, as `<id>@<version>`. */
  packs: string[];
  /** How many vectors passed. */
  vectors: number;
  failures: Array<{ pack: string; vector: string }>;
  /** Files that are not usable packs, and why. */
  invalid: Array<{ file: string; message: string }>;
  results: PackTestRow[];
  /** How long the run took, in milliseconds. */
  ms: number;
}

/** The pack files a list of files and folders names: a folder's `.json` files (not its subfolders), in name order. */
export function packFilesOf(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    let folder = false;
    try { folder = statSync(path).isDirectory(); } catch { /* reported when it is read */ }
    if (!folder) { out.push(path); continue; }
    for (const name of readdirSync(path).filter((n) => n.toLowerCase().endsWith(".json")).sort()) out.push(join(path, name));
  }
  return out;
}

/** The rule that matched an evaluated call: the clause of a deny, else the first receipt that recorded a match. */
function matchedRule(decision: { decision: string; clauseId?: string | null; receipts?: unknown[]; receipt?: unknown }): string | null {
  if (decision.decision === "deny" && decision.clauseId) return decision.clauseId;
  for (const receipt of decision.receipts ?? (decision.receipt ? [decision.receipt] : [])) {
    const payload = (receipt as { payload?: { realtime_result?: unknown; clause_id?: unknown } } | null)?.payload;
    if (payload?.realtime_result === "deny" && typeof payload.clause_id === "string") return payload.clause_id;
  }
  return null;
}

/** The tool call a vector stands for, as Claude Code would send it. */
function callOf(vector: Pack["vectors"][number], cwd: string): Record<string, unknown> {
  if (vector.mcp) return { tool_name: `mcp__${vector.mcp.server}__${vector.mcp.tool}`, tool_input: vector.mcp.args, cwd };
  const shell = vector.shell!;
  // As runPackVectors reads a PowerShell vector: its escapes and backslashes in the POSIX form the mapper reads.
  const command = shell.dialect === "powershell" ? shell.command.replace(/`(.)/g, "$1").replace(/\\/g, "/") : shell.command;
  return { tool_name: "Bash", tool_input: { command }, cwd };
}

/** Check the pack files and run their vectors (see the note at the top). Never throws for a bad file: it is reported. */
export async function testPackFiles(paths: readonly string[], options: { engine?: number } = {}): Promise<PackTestReport> {
  const started = Date.now();
  const report: PackTestReport = { engine: hookVersion(), packs: [], vectors: 0, failures: [], invalid: [], results: [], ms: 0 };
  // A throwaway folder with the starter policy: never this computer's own. Its real path, so the mapper's folder checks agree.
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "scopebond-packs-test-")));
  const before = { packs: activePacks(), shadow: [...shadowPackIds()], local: new Set(localPackIds()) };
  try {
    scaffold(home);
    const starter = JSON.parse(readFileSync(join(home, "policy.json"), "utf8")) as { clauses?: Array<{ id?: unknown }> };
    const clauses = starter.clauses ?? [];
    const taken = new Set(clauses.map((c) => String(c.id)));
    const covered = coveredTypes(clauses);
    // The folder each vector's command runs in: a project beside the throwaway setup.
    const project = join(home, "project");
    mkdirSync(project);
    for (const file of packFilesOf(paths)) {
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { report.invalid.push({ file, message: "the file cannot be read" }); continue; }
      const checked = checkLocalPackText(text, { engine: options.engine, vectors: false });
      if (!checked.ok) { report.invalid.push({ file, message: checked.message }); continue; }
      const pack = checked.pack;
      const ruleProblem = pack.rules.map((r) => localRuleProblem(r, taken, covered)).find((p) => p !== null);
      if (ruleProblem) { report.invalid.push({ file, message: ruleProblem }); continue; }
      const ref = packRef(pack);
      report.packs.push(ref);
      const derived = runPackVectors(pack);
      const failed = new Map(derived.failures.map((f) => [f.id, f]));
      report.vectors += derived.passed;
      // This pack alone in force, as a local pack, in a runtime built for it.
      setActivePacks([], [], [pack]);
      const runtime = createHookRuntime({ policyPath: join(home, "policy.json"), keyPath: join(home, "agent.key"), attesterPath: join(home, "attester.key"), dbPath: join(home, `receipts-${report.packs.length}.db`), restorable: () => false });
      try {
        for (const vector of pack.vectors) {
          let decision: PackTestRow["decision"] = "error";
          let rule: string | null = null;
          try {
            const made = await runtime.evaluate(mapClaudeToolUse(callOf(vector, project)));
            decision = made.decision;
            rule = matchedRule(made);
          } catch { /* reported as an error */ }
          const failure = failed.get(vector.id);
          if (failure) report.failures.push({ pack: ref, vector: vector.id });
          report.results.push({ pack: ref, vector: vector.id, pass: !failure, decision, rule, ...(failure ? { expected: failure.expected, actual: failure.actual } : {}) });
        }
      } finally { runtime.close(); }
    }
  } finally {
    setActivePacks(before.packs.filter((p) => !before.local.has(p.id)), before.shadow, before.packs.filter((p) => before.local.has(p.id)));
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }); } catch { /* the OS temp folder is cleaned later */ }
  }
  report.ms = Date.now() - started;
  return report;
}

/** The report as a short table: a line per pack, then a line per vector (pass or FAIL, its decision, and the rule). */
export function packTestLines(report: PackTestReport): string[] {
  const lines = [`engine ${report.engine}`];
  for (const bad of report.invalid) lines.push(`  not a usable pack: ${bad.file}: ${bad.message}`);
  for (const ref of report.packs) {
    const rows = report.results.filter((r) => r.pack === ref);
    const failed = rows.filter((r) => !r.pass).length;
    lines.push(`${ref}: ${failed ? `${failed} of ${rows.length} vectors fail` : `${rows.length} vectors pass`}`);
    const width = Math.min(40, Math.max(...rows.map((r) => r.vector.length), 6));
    for (const r of rows) {
      const outcome = r.rule ? `${r.decision} (${r.decision === "deny" ? "blocked by" : "recorded by"} ${r.rule})` : r.decision;
      lines.push(`  ${r.pass ? "pass" : "FAIL"}  ${r.vector.padEnd(width)}  ${outcome}`);
      if (!r.pass) {
        lines.push(`        expected ${JSON.stringify(r.expected)}`);
        lines.push(`        derived  ${JSON.stringify(r.actual)}`);
      }
    }
  }
  if (!report.packs.length && !report.invalid.length) lines.push("  no pack files found");
  lines.push(`${report.vectors} vectors pass, ${report.failures.length} fail, ${report.invalid.length} files not usable (${report.ms} ms)`);
  return lines;
}
