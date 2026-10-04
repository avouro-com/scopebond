// `recover` — deliver receipts this computer recorded but never delivered because the key
// that signed them was revoked first (the computer was replaced, disconnected or retired
// while records were still queued). The receipts are already signed; nothing is re-signed.
// The workspace checks each one against the revoked key it kept, accepts them only after
// an owner or admin approves, and labels them Recovered. Nothing here makes a revoked key
// usable again.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SignedReceipt } from "@scopebond/gateway";
import { SqliteReceiptStore, loadOrCreateAttester } from "@scopebond/gateway/node";
import type { HookConnection } from "./cloud.js";

/** The workspace accepts at most 1 MiB and 100 receipts per request. */
const MAX_BATCH_BYTES = 900 * 1024;
const MAX_BATCH_COUNT = 100;
const MAX_RECEIPT_BYTES = 128 * 1024;
const PAGE = 500;
/** How long one batch is retried through lost connections and server errors. */
const RETRY_FOR_MS = 15 * 60_000;

export interface KeyGroup { kid: string; count: number; first: string | null; last: string | null }

export interface RecoverIo {
  log(line: string): void;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const kidOf = (r: SignedReceipt): string | null => {
  const kid = (r.payload as { attester?: { kid?: unknown } }).attester?.kid;
  return typeof kid === "string" ? kid : null;
};

/** Walk the whole local log once and count receipts per signing key other than `currentKid`. */
export function groupByEarlierKey(store: SqliteReceiptStore, currentKid: string): KeyGroup[] {
  const groups = new Map<string, KeyGroup>();
  for (let after = 0; ;) {
    const page = store.page(after, PAGE);
    if (!page.length) break;
    for (const { id, receipt } of page) {
      after = id;
      const kid = kidOf(receipt);
      if (!kid || kid === currentKid) continue;
      const group = groups.get(kid) ?? { kid, count: 0, first: null, last: null };
      group.count += 1;
      const at = receipt.payload.timestamp;
      if (!group.first || at < group.first) group.first = at;
      if (!group.last || at > group.last) group.last = at;
      groups.set(kid, group);
    }
  }
  return [...groups.values()].sort((a, b) => (a.first ?? "").localeCompare(b.first ?? ""));
}

interface Answer { status: number; json: Record<string, unknown> }

async function call(io: RecoverIo, connection: HookConnection, path: string, body?: unknown): Promise<Answer> {
  const response = await io.fetch(new URL(path, connection.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${connection.credential}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown> };
}

export interface RecoverOptions { wait: boolean; waitMs: number; pollMs: number }

export interface RecoverResult { groups: number; accepted: number; duplicates: number; rejected: number; pending: number; skipped: number; failed: boolean }

/** Recover every earlier key's receipts, one approval per key. */
export async function recoverEarlierReceipts(
  dir: string, connection: HookConnection, io: RecoverIo, options: RecoverOptions,
): Promise<RecoverResult> {
  const result: RecoverResult = { groups: 0, accepted: 0, duplicates: 0, rejected: 0, pending: 0, skipped: 0, failed: false };
  const dbPath = join(dir, "receipts.db");
  if (!existsSync(dbPath)) { io.log("No local log here, so there is nothing to recover."); return result; }
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const store = new SqliteReceiptStore(dbPath);
  try {
    io.log("Reading the local log…");
    const groups = groupByEarlierKey(store, attester.kid);
    if (!groups.length) { io.log("✓ Every local record was signed by this computer's current key. Nothing to recover."); return result; }
    result.groups = groups.length;
    for (const group of groups) {
      io.log(`\n${group.count.toLocaleString()} records signed by an earlier key (${group.kid}), recorded ${group.first} – ${group.last}.`);
      const asked = await call(io, connection, "/v1/recover", { source_kid: group.kid, claimed_count: group.count, first_at: group.first, last_at: group.last });
      if (asked.json.code === "key_not_revoked") {
        io.log("  Skipped: that key is still connected elsewhere, so its records are delivered from there, not recovered.");
        result.skipped += group.count; continue;
      }
      if (asked.status === 401) { io.log("  This computer's own connection is not valid. Reconnect it first (login), then run recover again."); result.failed = true; return result; }
      if (asked.status >= 400) { io.log(`  The workspace refused: ${String(asked.json.error ?? `HTTP ${asked.status}`)}`); result.skipped += group.count; continue; }
      const id = String(asked.json.id ?? "");
      let status = String(asked.json.status ?? "");
      if (status === "pending") {
        io.log(`  Waiting for an owner or admin to approve it on Activity:\n\n    ${String(asked.json.approve_url ?? connection.url)}\n`);
        if (!options.wait) { result.pending += group.count; io.log("  Run recover again after it is approved."); continue; }
        const deadline = io.now() + options.waitMs;
        while (status === "pending" && io.now() < deadline) {
          await io.sleep(options.pollMs);
          const polled = await call(io, connection, `/v1/recover/${encodeURIComponent(id)}`).catch(() => null);
          if (polled?.status === 200) status = String(polled.json.status ?? status);
        }
      }
      if (status === "declined") { io.log("  Declined in the workspace. Nothing was sent."); result.skipped += group.count; continue; }
      if (status !== "approved") { io.log(status === "pending" ? "  Not approved yet. Run recover again after it is approved." : `  This recovery is ${status}. Run recover again to ask anew.`); result.pending += group.count; continue; }
      io.log("  ✓ Approved. Sending…");
      const sent = await uploadGroup(store, group, id, connection, io);
      result.accepted += sent.accepted; result.duplicates += sent.duplicates; result.rejected += sent.rejected;
      if (sent.stopped) { result.failed = true; return result; }
      await call(io, connection, `/v1/recover/${encodeURIComponent(id)}/complete`, {}).catch(() => null);
      io.log(`  ✓ ${sent.accepted.toLocaleString()} recovered, ${sent.duplicates.toLocaleString()} were already in the workspace, ${sent.rejected.toLocaleString()} refused.`);
    }
    return result;
  } finally {
    store.close();
  }
}

async function uploadGroup(
  store: SqliteReceiptStore, group: KeyGroup, id: string, connection: HookConnection, io: RecoverIo,
): Promise<{ accepted: number; duplicates: number; rejected: number; stopped: boolean }> {
  const totals = { accepted: 0, duplicates: 0, rejected: 0, stopped: false };
  let batch: string[] = [];
  let bytes = 0;
  let sent = 0;
  const send = async (): Promise<boolean> => {
    if (!batch.length) return true;
    const body = `{"receipts":[${batch.join(",")}]}`;
    const started = io.now();
    for (let attempt = 1; ; attempt++) {
      const answer = await call(io, connection, `/v1/recover/${encodeURIComponent(id)}/receipts`, body).catch((error: Error) => ({ status: 0, json: { error: error.message } } as Answer));
      if (answer.status === 200) {
        totals.accepted += Number(answer.json.accepted ?? 0);
        totals.duplicates += Number(answer.json.duplicates ?? 0);
        totals.rejected += Number(answer.json.rejected_count ?? 0);
        break;
      }
      // Durable but not yet readable, or a network error: the same batch is safe to resend.
      // A laptop that sleeps or changes networks loses the connection for minutes, not
      // seconds: keep resending with backoff for up to RETRY_FOR_MS before giving up.
      if ((answer.status === 0 || answer.status >= 500) && io.now() - started < RETRY_FOR_MS) {
        const wait = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5));
        io.log(`  ${answer.status === 0 ? "Connection lost" : `The workspace answered ${answer.status}`}; trying the same batch again in ${Math.round(wait / 1000)} s…`);
        await io.sleep(wait);
        continue;
      }
      io.log(`  Stopped: ${String(answer.json.error ?? `HTTP ${answer.status}`)}. Records already sent stay recovered; run recover again to continue.`);
      totals.stopped = true;
      return false;
    }
    sent += batch.length;
    if (sent % 1000 < batch.length || sent === group.count) io.log(`  … ${sent.toLocaleString()} of ${group.count.toLocaleString()}`);
    batch = []; bytes = 0;
    return true;
  };
  for (let after = 0; ;) {
    const page = store.page(after, PAGE);
    if (!page.length) break;
    for (const { id: row, receipt } of page) {
      after = row;
      if (kidOf(receipt) !== group.kid) continue;
      const json = JSON.stringify(receipt);
      const size = Buffer.byteLength(json);
      if (size > MAX_RECEIPT_BYTES) { totals.rejected += 1; continue; }
      if (batch.length >= MAX_BATCH_COUNT || bytes + size + 1 > MAX_BATCH_BYTES) { if (!(await send())) return totals; }
      batch.push(json); bytes += size + 1;
    }
  }
  if (!(await send())) return totals;
  return totals;
}
