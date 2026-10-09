// The bound on the MCP proxy's session history. Whatever the policy's windows, the history never holds more than a number
// of calls and of bytes: past either, the oldest calls are dropped, so a long-running proxy does not grow, or slow down,
// without end. A windowed clause (rate_limit, sequence, a windowed spend_limit) cannot count a call that was dropped, so
// while a dropped call may still be inside the policy's longest window, calls are refused rather than decided on a history
// that lost it: the bound never lets through more than the policy allows.

import { historyNeed } from "@scopebond/verify";

export interface HistoryLimit {
  /** The most calls the history holds (default 10,000). */
  maxCalls?: number;
  /** The most bytes of history, as JSON (default 8 MiB). */
  maxBytes?: number;
}

const DEFAULT_HISTORY_MAX_CALLS = 10_000;
const DEFAULT_HISTORY_MAX_BYTES = 8 * 1024 * 1024;

interface HistoryBound {
  /** Drops the oldest calls, in place, until the history is within the bound. */
  trim(history: Array<{ timestamp?: unknown }>): void;
  /** Why a call at `at` cannot be decided on the history kept (a dropped call may still be inside a window), or null. */
  refusal(at: string): string | null;
}

function limitOf(value: number | undefined, fallback: number, name: string): number {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < 1) throw new TypeError(`historyLimit.${name} must be a whole number of at least 1`);
  return v;
}

export function historyBound(policy: unknown, limit: HistoryLimit = {}): HistoryBound {
  const maxCalls = limitOf(limit.maxCalls, DEFAULT_HISTORY_MAX_CALLS, "maxCalls");
  const maxBytes = limitOf(limit.maxBytes, DEFAULT_HISTORY_MAX_BYTES, "maxBytes");
  const need = historyNeed(policy as never);
  const sizes = new WeakMap<object, number>();
  const sizeOf = (call: object): number => {
    let size = sizes.get(call);
    if (size === undefined) {
      try { size = Buffer.byteLength(JSON.stringify(call) ?? ""); } catch { size = maxBytes; }
      sizes.set(call, size);
    }
    return size;
  };
  // The newest time among the calls dropped so far (ms); Infinity once a call without a readable time was dropped.
  let droppedThrough = -Infinity;
  return {
    trim(history) {
      let total = 0;
      for (const call of history) total += sizeOf(call);
      let drop = 0;
      while (drop < history.length && (history.length - drop > maxCalls || total > maxBytes)) {
        const old = history[drop++];
        total -= sizeOf(old);
        const at = typeof old.timestamp === "string" ? Date.parse(old.timestamp) : NaN;
        droppedThrough = Math.max(droppedThrough, Number.isFinite(at) ? at : Infinity);
      }
      if (drop > 0) history.splice(0, drop);
    },
    refusal(at) {
      if (droppedThrough === -Infinity || need.kind === "none") return null;
      const atMs = Date.parse(at);
      if (need.kind === "window" && Number.isFinite(atMs) && droppedThrough <= atMs - need.ms) return null;
      return `the proxy's call history is full (at most ${maxCalls} calls and ${maxBytes} bytes) and dropped calls this policy's windowed clauses may still count, so calls are refused until those leave the policy's longest window`;
    },
  };
}
