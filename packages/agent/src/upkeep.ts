// The local store's upkeep in a process of its own (D144). A pass can take up to its budget (30 s), and the first pass over
// an older file rewrites the whole file; both are synchronous SQLite work. Run inside the agent they kept it from answering
// the tray and the CLI for as long as they took, so the agent starts `scopebond-agent upkeep` and waits for it without
// blocking: the tray, `status` and the workspace's requests are answered meanwhile.

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { runStoreUpkeep } from "@scopebond/hook";
import { agentSelfCommand } from "./self.js";

export type UpkeepReport = ReturnType<typeof runStoreUpkeep>;

export const UPKEEP_BUDGET_MS = 30_000;
/** A pass that has not finished by then is stopped; the next maintenance pass carries on where the file stands. */
export const UPKEEP_TIMEOUT_MS = 10 * 60_000;

/** `scopebond-agent upkeep`: one pass over this home's store, its report as one JSON line (`null` when there is no store). */
export function upkeepCommand(dir: string, args: readonly string[]): void {
  const i = args.indexOf("--budget");
  const budget = i >= 0 ? Number(args[i + 1]) : UPKEEP_BUDGET_MS;
  const report = runStoreUpkeep(dir, { budgetMs: Number.isFinite(budget) && budget > 0 ? budget : UPKEEP_BUDGET_MS, allowFullVacuum: true });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

export interface UpkeepApartOptions {
  budgetMs?: number;
  timeoutMs?: number;
  /** The program and arguments to run instead of this agent's own `upkeep` (tests). */
  command?: [string, string[]];
}

/** Run one upkeep pass for `dir` in a child process and resolve with its report. Rejects when the pass fails or overruns. */
export function runUpkeepApart(dir: string, options: UpkeepApartOptions = {}): Promise<UpkeepReport> {
  const budget = options.budgetMs ?? UPKEEP_BUDGET_MS;
  const [program, args] = options.command ?? agentSelfCommand(["upkeep", "--budget", String(budget)]);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: tmpdir(), env: { ...process.env, SCOPEBOND_HOME: dir }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { if (out.length < 65_536) out += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { if (err.length < 8_192) err += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the local store upkeep did not finish within ${Math.round((options.timeoutMs ?? UPKEEP_TIMEOUT_MS) / 1000)} s`));
    }, options.timeoutMs ?? UPKEEP_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`the local store upkeep exited with ${code}: ${err.trim().split(/\r?\n/).pop() ?? ""}`.trim())); return; }
      const line = out.trim().split(/\r?\n/).pop() ?? "";
      try { resolve(JSON.parse(line) as UpkeepReport); } catch { reject(new Error("the local store upkeep gave no report")); }
    });
  });
}
