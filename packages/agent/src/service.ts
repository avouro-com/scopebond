// The resident loop: one cycle now, then one every interval, sooner after a change is asked for,
// backing off while the workspace is unreachable. Exactly one agent serves a Scopebond home: a
// second one finds the first answering and exits.

import { userHarnessFile, writeHarnessConfig, hookCommand, hookVersion, type Harness } from "@scopebond/hook";
import { computerStatus, expectedHarnesses, missingHookEntries, runCycle, type CycleResult } from "./agent.js";
import { callAgent, startControl } from "./ipc.js";

export const AGENT_VERSION = "agent/1";
const INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export interface ServiceOptions { dir: string; intervalMs?: number; fetchImpl?: typeof fetch; log?: (line: string) => void }

export interface Service { stop(): Promise<void>; cycleNow(): Promise<CycleResult>; port: number }

/** Put the Scopebond hook back into agent settings that lost it. A visible change: each one is
 *  logged and returned, and only settings of agents this computer has are touched. */
export function repairHookEntries(harnesses: Harness[] = expectedHarnesses()): Array<{ harness: Harness; file: string }> {
  const repaired: Array<{ harness: Harness; file: string }> = [];
  for (const harness of missingHookEntries(harnesses)) {
    const file = writeHarnessConfig(userHarnessFile(harness), harness, hookCommand(harness));
    repaired.push({ harness, file });
  }
  return repaired;
}

export async function startService(options: ServiceOptions): Promise<Service> {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  if (await callAgent(options.dir, "GET", "/status", undefined, 2_000)) throw new Error("a Scopebond Agent is already running for this computer");
  const interval = options.intervalMs ?? INTERVAL_MS;
  let last: CycleResult | null = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<CycleResult> | null = null;
  let stopped = false;

  const cycle = async (): Promise<CycleResult> => {
    if (running) return running;
    running = runCycle({ dir: options.dir, fetchImpl: options.fetchImpl }).then((result) => {
      last = result;
      failures = result.deliveryError ? failures + 1 : 0;
      if (result.delivered) log(`delivered ${result.delivered} record(s); ${result.pending} waiting`);
      if (result.deliveryError) log(`delivery problem: ${result.deliveryError}`);
      return result;
    }).finally(() => { running = null; });
    return running;
  };
  const schedule = () => {
    if (stopped) return;
    const delay = failures ? Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(failures, 6)) : interval;
    timer = setTimeout(() => { void cycle().finally(schedule); }, delay);
  };

  const control = await startControl(options.dir, `${AGENT_VERSION} hook/${hookVersion()}`, {
    "GET /status": () => ({ ...computerStatus(options.dir), agent: { pid: process.pid, version: AGENT_VERSION, last_cycle: last } }),
    "POST /flush": async () => ({ cycle: await cycle() }),
    "POST /repair": () => {
      const repaired = repairHookEntries();
      for (const r of repaired) log(`repaired the Scopebond hook entry in ${r.file}`);
      return { repaired };
    },
  });
  log(`Scopebond Agent running for ${options.dir} (control on 127.0.0.1:${control.endpoint.port})`);
  await cycle();
  schedule();
  return {
    port: control.endpoint.port,
    cycleNow: cycle,
    stop: async () => { stopped = true; if (timer) clearTimeout(timer); await running?.catch(() => undefined); await control.close(); },
  };
}
