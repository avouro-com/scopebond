import { existsSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { HARNESSES, adapterDirectory } from "@scopebond/hook";

export const DISCOVERY_FALLBACK_MS = 60_000;
export const DISCOVERY_DEBOUNCE_MS = 1_000;
export const DISCOVERY_MAX_WATCHERS = 12;
export interface DiscoveryLoopOptions {
  reconcile: () => Promise<void>;
  directories?: () => string[];
  watchDirectory?: (directory: string, changed: () => void) => { close(): void };
  onError?: () => void;
}

function watchDirectories(): string[] {
  const paths = new Set([homedir()]);
  for (const harness of HARNESSES) {
    const directory = adapterDirectory(harness);
    for (const candidate of [directory, dirname(directory)]) {
      let at = candidate;
      while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
      if (existsSync(at)) paths.add(at);
    }
  }
  return [...paths];
}

/** One worker, bounded watchers, first-event debounce and fallback independent of record delivery/backoff. */
export function startDiscoveryLoop(options: DiscoveryLoopOptions): { rescan(): void; stop(): void } {
  let stopped = false;
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watchers = new Map<string, { close(): void }>();
  const failed = () => options.onError?.();
  const request = (delay = DISCOVERY_DEBOUNCE_MS) => {
    if (stopped) return;
    pending = true;
    if (timer !== null || running) return;
    timer = setTimeout(() => { timer = null; void run(); }, delay);
    timer.unref?.();
  };
  const refresh = () => {
    const directories = [...new Set((options.directories ?? watchDirectories)())].slice(0, DISCOVERY_MAX_WATCHERS);
    for (const [directory, watcher] of watchers) {
      if (directories.includes(directory)) continue;
      watcher.close(); watchers.delete(directory);
    }
    for (const directory of directories) {
      if (watchers.has(directory)) continue;
      try {
        const watcher = options.watchDirectory ? options.watchDirectory(directory, () => request()) : watch(directory, { persistent: false }, () => request());
        if ("on" in watcher && typeof watcher.on === "function") watcher.on("error", () => { watcher.close(); watchers.delete(directory); failed(); });
        watchers.set(directory, watcher);
      } catch { failed(); }
    }
  };
  const run = async () => {
    if (stopped || running) return;
    running = true; pending = false;
    try { refresh(); await options.reconcile(); }
    catch { failed(); }
    finally { running = false; if (pending) request(); }
  };
  // Timers overdue after sleep run as soon as the event loop resumes. No elapsed idle interval counts as tool activity.
  const fallback = setInterval(() => request(0), DISCOVERY_FALLBACK_MS);
  fallback.unref?.();
  request(0);
  return {
    rescan: () => request(0),
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      clearInterval(fallback);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
