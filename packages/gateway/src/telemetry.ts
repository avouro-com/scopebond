// Anonymous, opt-out usage telemetry for the `scopebond-gateway` CLI.
//
// Privacy by design: it sends NO personally identifiable information, NO policy
// contents or values, NO receipts, NO hostnames, NO addresses — only coarse,
// aggregate signal (see the exact list below and TELEMETRY.md). It is used only
// by the standalone CLI server, never by the embedded library, and never per
// request — one event at startup.
//
// It is DISABLED unless a telemetry key is configured, and can be turned off any
// time with `SCOPEBOND_TELEMETRY=0` (or off/false/no) or the standard
// `DO_NOT_TRACK=1`.

export interface TelemetryInfo {
  gatewayVersion: string;
  clauseTypes: string[]; // clause *types* only, sorted+unique — never ids, values, or thresholds
  clauseCount: number;
  storeKind: string; // "sqlite" | "file" | "memory"
  nodeVersion: string;
  platform: string; // process.platform, e.g. "linux"
}

// PostHog-compatible ingest. Empty key = telemetry off (the shipped default).
const KEY = process.env.SCOPEBOND_TELEMETRY_KEY ?? "";
const HOST = process.env.SCOPEBOND_TELEMETRY_HOST ?? "https://us.i.posthog.com";

export function optedOut(): boolean {
  const v = (process.env.SCOPEBOND_TELEMETRY ?? "").toLowerCase();
  if (["0", "off", "false", "no"].includes(v)) return true;
  const dnt = (process.env.DO_NOT_TRACK ?? "").toLowerCase();
  if (dnt && dnt !== "0" && dnt !== "false") return true;
  return false;
}

export function telemetryEnabled(): boolean {
  return Boolean(KEY) && !optedOut();
}

/** Fire-and-forget a single anonymous startup event. Never throws, never blocks
 *  the gateway, times out fast. */
export async function sendStartupTelemetry(info: TelemetryInfo, distinctId: string): Promise<void> {
  if (!telemetryEnabled()) return;
  const body = {
    api_key: KEY,
    event: "gateway_start",
    distinct_id: distinctId,
    properties: {
      gateway_version: info.gatewayVersion,
      clause_types: info.clauseTypes,
      clause_count: info.clauseCount,
      store_kind: info.storeKind,
      node_version: info.nodeVersion,
      platform: info.platform,
      $lib: "scopebond-gateway",
    },
    timestamp: new Date().toISOString(),
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    await fetch(`${HOST}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).catch(() => {});
    clearTimeout(timer);
  } catch {
    /* telemetry must never disrupt the gateway */
  }
}
