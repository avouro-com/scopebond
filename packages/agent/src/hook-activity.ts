import { HOOK_ACTIVITY_EVENTS, isHarness, type Harness, type HookActivityEvent } from "@scopebond/hook";
import type { IntegrationHealth } from "./integration-health.js";

export type HookCallbackActivity = { state: "unknown" } | {
  state: "callback_observed" | "stale"; last_callback_at: number; event: HookActivityEvent;
  source: "authenticated_local_callback"; surface: "unknown";
};
const FRESH_MS = 10_000;
const STALE_MS = 15 * 60_000;
const MAX_IDS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fields = new Set(["version", "id", "harness", "event", "sent_at"]);
const binding = (health: IntegrationHealth): string | null => health.scope.profile.state === "bound"
  && health.presence === "detected" && health.entry && health.executable && !health.duplicates
  && (health.integration === "awaiting_trust" || health.integration === "awaiting_restart") && health.definition_revision
  ? JSON.stringify([health.scope.profile.id, health.scope.execution, health.definition_revision]) : null;

/** Call accept only behind the existing control channel's token/origin checks. In-memory, bounded and reset at restart.
 * No caller-supplied claim can change integration, native verification, capabilities or licensing. */
export function createHookActivityTracker(readHealth: (harness: Harness) => IntegrationHealth, now: () => number = Date.now) {
  const seen = new Map<string, number>();
  const latest = new Map<Harness, { binding: string; at: number; event: HookActivityEvent }>();
  let lastClock = now();
  let elapsed = 0;
  const clock = () => {
    const at = now();
    if (at < lastClock) latest.clear();
    elapsed += Math.max(0, at - lastClock);
    lastClock = at;
    return at;
  };
  return {
    accept(body: unknown): { accepted: boolean } {
      const at = clock();
      if (!body || typeof body !== "object" || Array.isArray(body)) return { accepted: false };
      const report = body as Record<string, unknown>;
      if (Object.keys(report).some((key) => !fields.has(key)) || report.version !== 1 || !isHarness(report.harness)
        || typeof report.id !== "string" || !UUID.test(report.id) || typeof report.event !== "string"
        || !HOOK_ACTIVITY_EVENTS.includes(report.event as HookActivityEvent) || !Number.isSafeInteger(report.sent_at)
        || (report.sent_at as number) > at + 2_000 || at - (report.sent_at as number) > FRESH_MS) return { accepted: false };
      for (const [id, until] of seen) if (until < elapsed) seen.delete(id);
      if (seen.has(report.id) || seen.size >= MAX_IDS) return { accepted: false };
      const current = binding(readHealth(report.harness));
      if (!current) return { accepted: false };
      seen.set(report.id, elapsed + FRESH_MS + 2_000);
      latest.set(report.harness, { binding: current, at, event: report.event as HookActivityEvent });
      return { accepted: true };
    },
    apply(health: IntegrationHealth): IntegrationHealth {
      const at = clock();
      const record = latest.get(health.harness);
      if (!record || record.binding !== binding(health)) {
        latest.delete(health.harness);
        return { ...health, activity: { state: "unknown" } };
      }
      return { ...health, activity: {
        state: at - record.at > STALE_MS ? "stale" : "callback_observed", last_callback_at: record.at,
        event: record.event, source: "authenticated_local_callback", surface: "unknown",
      } };
    },
  };
}
