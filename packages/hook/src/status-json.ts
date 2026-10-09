// The machine-readable delivery and identity status every connector reports in one shape (the
// delivery and identity conformance contract): what `status --json` prints, and what the
// desktop agent and the workspace read. Additive only: fields are added, never renamed.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConnection } from "./cloud.js";
import { readDeliveryState, waitingUntil } from "./delivery-state.js";
import { deliveryStalled, queueStatus } from "./delivery-report.js";

export const STATUS_SCHEMA = "scopebond.status.v1";

export interface StatusJson {
  schema: typeof STATUS_SCHEMA;
  version: string;
  /** delivering: connected and nothing stuck. recording_locally: records are kept on this
   *  computer but not reaching a workspace (not connected, refused, or failing). not_governing:
   *  no agent is wired to the hook or there is no policy, so nothing is checked. */
  state: "delivering" | "recording_locally" | "not_governing";
  delivery: {
    connected: boolean;
    last_success_at: number | null;
    last_attempt_at: number | null;
    last_error: string | null;
    last_error_code: string | null;
    connection_refused_since: number | null;
    pending: number;
    oldest_pending_age_s: number | null;
    /** Records that missed normal delivery, by reason, over the queue's lifetime (not only its retained gap rows). */
    gaps_by_reason: Record<string, number>;
    /** Their total over the queue's lifetime. A queue made before the counts by reason may count more here than by reason. */
    gaps_total: number;
    /** The workspace asked this computer to wait (HTTP 429, or 503 with Retry-After): nothing is sent before this time (ms
     *  since epoch). Null when no wait is in force. */
    backoff_until: number | null;
    /** The delivery queue could not be opened (a full disk, a read-only file). Actions stay allowed and are recorded on this
     *  computer; each record written meanwhile is queued once the queue can be written again. */
    queue_error: string | null;
  };
  identity: {
    installation_id: string | null;
    generation: number | null;
    key_kid: string | null;
    credential_expires_at: string | null;
  };
  /** user_connection_shadowed: the user-level sign-in is connected, but a project setup takes
   *  precedence from here. */
  config: { active: string; others: string[]; user_connection_shadowed: boolean };
  agents: { claude: boolean; cursor: boolean; codex: boolean };
}

/** A pending record older than this, with a delivery error, means the computer is not delivering. */
const STUCK_AFTER_MS = 60 * 60 * 1000;

export function buildStatusJson(input: {
  version: string; activeDir: string; candidateDirs: string[]; hasPolicy: boolean;
  /** The user-level config dir, to report a project setup that takes precedence over its connection. */
  userDir?: string;
  agents: { claude: boolean; cursor: boolean; codex: boolean }; now?: number;
}): StatusJson {
  const now = input.now ?? Date.now();
  const dir = input.activeDir;
  const connection = loadConnection(dir);
  const state = readDeliveryState(dir);
  const { pending, oldest, error: queueError, gapsTotal, gapsByReason } = queueStatus(dir);
  const code = /\(([a-z_]+)\)/.exec(state.last_error ?? "")?.[1] ?? (state.last_status ? `http_${state.last_status}` : null);
  const governing = input.hasPolicy && (input.agents.claude || input.agents.cursor || input.agents.codex);
  // Stuck with a known error for an hour, or stalled: nothing accepted since the oldest waiting
  // record was queued, error or not (an attempt cut off by its time limit used to record none).
  const stuck = (pending > 0 && oldest !== null && now - oldest > STUCK_AFTER_MS && state.last_error !== null)
    || deliveryStalled(state, pending, oldest, now);
  const overall: StatusJson["state"] = !governing ? "not_governing"
    : !connection || state.invalid_since !== null || stuck || queueError ? "recording_locally" : "delivering";
  return {
    schema: STATUS_SCHEMA,
    version: input.version,
    state: overall,
    delivery: {
      connected: !!connection,
      last_success_at: state.last_success_at,
      last_attempt_at: state.last_attempt_at,
      // An unusable queue is the error that matters, whatever delivery said last. It does not block actions: they stay allowed
      // and are recorded on this computer, and are sent once the queue can be written again.
      last_error: queueError ? `delivery queue unusable: ${queueError}` : state.last_error,
      last_error_code: queueError ? "queue_unusable" : code,
      queue_error: queueError ?? null,
      connection_refused_since: state.invalid_since,
      pending,
      oldest_pending_age_s: oldest !== null ? Math.max(0, Math.round((now - oldest) / 1000)) : null,
      gaps_by_reason: gapsByReason,
      gaps_total: gapsTotal,
      backoff_until: waitingUntil(state, now),
    },
    identity: {
      installation_id: connection ? ((connection as { installation_id?: string }).installation_id ?? connection.gateway_id) : null,
      generation: connection ? ((connection as { installation_generation?: number }).installation_generation ?? null) : null,
      key_kid: connection?.attester_kid ?? null,
      credential_expires_at: connection?.expires_at ?? null,
    },
    config: {
      active: dir,
      others: input.candidateDirs.filter((d) => d !== dir && existsSync(join(d, "policy.json"))),
      user_connection_shadowed: !!input.userDir && resolve(input.userDir) !== resolve(dir) && !!loadConnection(input.userDir),
    },
    agents: input.agents,
  };
}
