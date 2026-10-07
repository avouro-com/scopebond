// Summary records (evidence class "summary"): one signed record that stands in for many routine receipts when a computer
// sends its evidence. Every action still has its own signed receipt on the computer; the summary carries an RFC 9162 root
// over the receipts it covers, their counts by action type, result, program and working folder, and the actions repeated
// in the window, so "the same `pnpm test` 40 times" is one line. Notable receipts are always sent in full and never covered.
//
// Notable, by default: anything not plainly allowed (a deny, an override, an approval, a timeout); a push; a write outside
// the working folder or to CI configuration or an agent's or Scopebond's own settings; an MCP tool call; a network fetch.
// An action a Monitor rule matched is recorded as out of policy (and allowed), so it is never routine either.

import { createHash, randomUUID } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";
import { summaryRoot, summarySigningInput, type SummaryCount, type SummaryPayload, type SummaryRecord, type SummaryRepeat } from "@scopebond/verify/summary";
import type { Attester, ReceiptPayload, SignedReceipt } from "./receipts.js";

export type { SummaryPayload, SummaryRecord } from "@scopebond/verify/summary";

const GROUP_FIELDS = new Set(["action_group", "action_group_size", "action_group_seq"]);
const ROUTINE_RESULTS = new Set(["allow", "not_evaluated"]);
const NOTABLE_TYPES = new Set(["git.push", "mcp.tool.call", "net.fetch"]);
const SENSITIVE_PATH = /(^|[\\/])(\.github|\.gitlab-ci\.ya?ml|\.circleci|azure-pipelines\.ya?ml|Jenkinsfile|\.claude|\.cursor|\.codex|\.scopebond)([\\/]|$)/i;
const OUTSIDE_PATH = /^(\/|~|[A-Za-z]:|\\\\)|(^|[\\/])\.\.([\\/]|$)/;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Whether a receipt must be sent in full (never covered by a summary), by the default rules above. */
export function isNotable(payload: ReceiptPayload): boolean {
  if (!ROUTINE_RESULTS.has(payload.realtime_result) || payload.override !== undefined) return true;
  const type = payload.intent?.action_type ?? "";
  if (!type) return true; // an action with no type is never counted as routine
  if (NOTABLE_TYPES.has(type)) return true;
  if (type === "file.write") {
    const path = payload.intent.params?.path;
    return typeof path !== "string" || path === "" || OUTSIDE_PATH.test(path) || SENSITIVE_PATH.test(path);
  }
  return false;
}

/** The same action, whatever tool call it came from: its type and parameters without the tool call's group fields. */
export function repeatKey(intent: { action_type?: string; params?: Record<string, unknown> }): string {
  const params = Object.fromEntries(Object.entries(intent.params ?? {}).filter(([k]) => !GROUP_FIELDS.has(k)));
  return sha256(canonical({ action_type: intent.action_type ?? "", params }));
}

/** At most 500 lines: the largest groups keep their program and folder; the rest fold into one line per action type and
 *  result, so the counts always add up. */
function capCounts(sorted: SummaryCount[]): SummaryCount[] {
  if (sorted.length <= 500) return sorted;
  const fold = (rest: SummaryCount[]) => {
    const m = new Map<string, SummaryCount>();
    for (const c of rest) {
      const k = `${c.action_type}\u0000${c.result}`;
      const o = m.get(k);
      if (o) o.count += c.count; else m.set(k, { action_type: c.action_type, result: c.result, program: null, cwd_digest: null, count: c.count });
    }
    return [...m.values()];
  };
  for (let keep = 499; keep >= 0; keep--) {
    const folded = fold(sorted.slice(keep));
    if (keep + folded.length <= 500) return [...sorted.slice(0, keep), ...folded];
  }
  return fold(sorted);
}

export interface SummaryOptions {
  attester: Attester;
  window: { kind: "interval" | "session"; start: string; end: string };
  sessionId?: string | null;
  harness?: string | null;
  /** Receipts in the window sent in full (not covered). */
  notableCount: number;
  now?: Date;
  /** The summary's id (default: a new one). */
  summaryId?: string;
}

/** Build and sign the summary of these routine receipts (in any order: the root is taken in `summaryOrder`). Throws when one is notable by
 *  the default rules or the list is empty: a summary never stands in for a notable action. */
export async function buildSummary(receipts: readonly SignedReceipt[], options: SummaryOptions): Promise<SummaryRecord> {
  if (receipts.length === 0) throw new RangeError("a summary covers at least one receipt");
  const counts = new Map<string, SummaryCount>();
  const repeats = new Map<string, SummaryRepeat>();
  for (const { payload } of receipts) {
    if (isNotable(payload)) throw new TypeError("a notable receipt cannot be summarised");
    const params = payload.intent.params ?? {};
    const program = typeof params.program === "string" && params.program.length > 0 ? params.program.slice(0, 100) : null;
    const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? sha256(params.cwd) : null;
    const result = payload.realtime_result as SummaryCount["result"];
    const countKey = canonical([payload.intent.action_type, result, program, cwd]);
    const c = counts.get(countKey);
    if (c) c.count += 1;
    else counts.set(countKey, { action_type: String(payload.intent.action_type).slice(0, 100), result, program, cwd_digest: cwd, count: 1 });
    const key = repeatKey(payload.intent);
    const r = repeats.get(key);
    if (r) { r.count += 1; if (payload.timestamp < r.first_at) r.first_at = payload.timestamp; if (payload.timestamp > r.last_at) r.last_at = payload.timestamp; }
    else repeats.set(key, { key, count: 1, first_at: payload.timestamp, last_at: payload.timestamp });
  }
  const countList = capCounts([...counts.values()].sort((a, b) => b.count - a.count));
  // The window always holds every receipt it covers.
  const times = receipts.map((r) => Date.parse(r.payload.timestamp)).filter(Number.isFinite);
  const start = new Date(Math.min(Date.parse(options.window.start), ...times)).toISOString();
  const end = new Date(Math.max(Date.parse(options.window.end), ...times)).toISOString();
  const payload: SummaryPayload = {
    type: "scopebond:summary", version: "1.0", canonicalization: "RFC8785", evidence_class: "summary",
    summary_id: options.summaryId ?? `sum_${randomUUID()}`,
    attester: { kind: "gateway", kid: options.attester.kid },
    session_id: options.sessionId ?? null,
    harness: options.harness ?? null,
    window: { kind: options.window.kind, start, end },
    receipt_count: receipts.length,
    receipts_root: await summaryRoot(receipts.map((r) => r.payload)),
    notable_count: options.notableCount,
    counts: countList,
    dedupe: [...repeats.values()].filter((r) => r.count >= 2).sort((a, b) => b.count - a.count).slice(0, 500),
    timestamp: (options.now ?? new Date()).toISOString(),
  };
  return { payload, signature: { alg: "Ed25519", sig: await options.attester.sign(summarySigningInput(payload)) } };
}
