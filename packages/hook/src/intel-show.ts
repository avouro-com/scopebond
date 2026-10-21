// `intel show`: what the next upload of records to Scopebond Cloud will contain, for a person who wants to see it.
//
// It runs this computer's own record uploader (cloud.ts `exporterOptions`, the gateway's exporter: the same batching,
// summaries, record numbers and serializer) against a copy of the delivery queue that changes nothing: records the uploader
// takes out are hidden from the copy only, summary windows are claimed in the copy only, and every request is captured and
// answered as an accepting workspace would, never sent. What it shows is each request's body as the uploader built it, with two
// changes for the screen: a plugin's opaque slot (`payload.intel`) is shown as `<opaque, N bytes>` unless `--raw` asks for its
// base64, and every text value of an action's parameters goes through the hook's parameter masking again (minimize.ts
// `scrubParam`), which leaves a value the hook already masked as it is.
//
// The category summary counts what those requests carry: the kinds of actions, the parameters they name, the rule results
// and the rules that matched, the coding tools, and how many records carry a plugin slot.
//
// When nothing is waiting, it says so and shows what one record carries: a record made now, in a throwaway folder, for a
// harmless command (it is not queued and not sent).

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudExporter, type CloudDeliveryGap, type CloudOutbox, type CloudOutboxEntry } from "@scopebond/gateway";
import { exporterOptions, ingestUrl, loadConnection, openDeliveryQueue, type HookConnection } from "./cloud.js";
import { OUTBOX_FILE } from "./delivery-report.js";
import { scaffold } from "./init.js";
import { mapClaudeToolUse } from "./map.js";
import { scrubParam } from "./minimize.js";
import { createHookRuntime } from "./runtime.js";

/** One request the next upload makes: where it goes and the body as the uploader built it (before the screen's changes). */
export interface UploadRequest { route: string; bytes: number; body: Record<string, unknown> }

export interface UploadPreview {
  connected: boolean;
  /** The workspace address records go to (its ingest address), or null when not connected. */
  workspace: string | null;
  /** How many records wait in the delivery queue. */
  queued: number;
  requests: UploadRequest[];
  /** Routine records held back until their summary window closes (sent later, as one summary). */
  held: { routine: number; until: number | null };
}

/** The most requests a preview follows (a queue is never drained further than this in one look). */
const MAX_REQUESTS = 1000;

/** A copy of the delivery queue that changes nothing: what the uploader takes out is hidden here only. */
function previewQueue(base: CloudOutbox): CloudOutbox {
  const gone = new Set<string>();
  const windows = new Map<number, { summaryId: string; sent: boolean }>();
  const full = new Map<number, number>();
  return {
    enqueue: () => ({ queued: false, duplicate: false }),
    peek: (limit: number, now: number, exclude?: ReadonlySet<string>): CloudOutboxEntry[] => base.peek(limit, now, new Set([...(exclude ?? []), ...gone])),
    acknowledge: (entries) => { for (const e of entries) gone.add(e.id); },
    status: () => { const s = base.status(); return { ...s, pending: Math.max(0, s.pending - gone.size) }; },
    pendingCount: () => Math.max(0, (base.pendingCount?.() ?? base.status().pending) - gone.size),
    recordGap: (id: string | null, reason: CloudDeliveryGap["reason"]): CloudDeliveryGap => ({ id, reason, at: Date.now() }),
    ...(base.claimWindow ? {
      claimWindow: (windowStart: number, summaryId: string, now: number) => {
        const mine = windows.get(windowStart);
        if (mine) return { state: mine.sent ? "sent" as const : "claimed" as const, summaryId: mine.summaryId };
        // The queue's own state of the window, read without claiming it (another process may be sending it).
        const seen = base.peekWindow?.(windowStart, now) ?? { state: "claimed" as const, summaryId: null };
        if (seen.state !== "claimed") return { state: seen.state, summaryId: seen.summaryId ?? summaryId };
        windows.set(windowStart, { summaryId: seen.summaryId ?? summaryId, sent: false });
        return { state: "claimed" as const, summaryId: seen.summaryId ?? summaryId };
      },
      releaseWindow: (windowStart: number) => { if (!windows.get(windowStart)?.sent) windows.delete(windowStart); },
      markWindowSent: (windowStart: number) => { const w = windows.get(windowStart); if (w) w.sent = true; },
      countFull: (windowStart: number, n: number) => { full.set(windowStart, (full.get(windowStart) ?? 0) + n); },
      fullCount: (windowStart: number) => (base.fullCount?.(windowStart) ?? 0) + (full.get(windowStart) ?? 0),
    } : {}),
  };
}

/** Run the uploader against a copy of the queue in `dir` and capture every request it would make. Sends nothing, changes
 *  nothing in the queue. */
export async function previewNextUpload(dir: string): Promise<UploadPreview> {
  const connection = loadConnection(dir);
  if (!connection) return { connected: false, workspace: null, queued: 0, requests: [], held: { routine: 0, until: null } };
  const outboxPath = join(dir, OUTBOX_FILE);
  let exists = true;
  try { statSync(outboxPath); } catch { exists = false; }
  // No queue yet: nothing was ever queued here (and none is made just to look).
  if (!exists) return { connected: true, workspace: ingestUrl(connection), queued: 0, requests: [], held: { routine: 0, until: null } };
  const queue = openDeliveryQueue(outboxPath);
  try {
    return await previewWith(outboxPath, connection, queue);
  } finally { queue.close(); }
}

async function previewWith(outboxPath: string, connection: HookConnection, queue: CloudOutbox): Promise<UploadPreview> {
  const requests: UploadRequest[] = [];
  const capture = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const text = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(text || "{}") as Record<string, unknown>;
    if (requests.length >= MAX_REQUESTS) return Promise.resolve(new Response("{}", { status: 503 }));
    requests.push({ route: url.pathname, bytes: Buffer.byteLength(text, "utf8"), body });
    const accepted = Array.isArray(body.summaries) ? body.summaries.length : Array.isArray(body.receipts) ? body.receipts.length : 0;
    return Promise.resolve(new Response(JSON.stringify({ accepted }), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  const copy = previewQueue(queue);
  const queued = queue.pendingCount?.() ?? queue.status().pending;
  // The uploader's own settings, without what only a real delivery does: no wait the workspace asked for (this looks at what
  // the next upload holds, whenever it goes), and no chain head kept (no answer carries one).
  const exporter = createCloudExporter({ ...exporterOptions(outboxPath, connection, copy, capture), onChainHead: undefined, flushMs: 24 * 60 * 60 * 1000 });
  try {
    await exporter.flush();
    return { connected: true, workspace: ingestUrl(connection), queued, requests, held: exporter.held?.() ?? { routine: 0, until: null } };
  } finally { exporter.stop(); }
}

// ---- what a person sees -----------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
/** A value as a category name: a string as it is, anything else as "unknown". */
const named = (value: unknown): string => (typeof value === "string" && value !== "" ? value : "unknown");

/** The bytes an opaque slot holds (it is padded base64). */
const slotBytes = (slot: string): number => Buffer.from(slot, "base64").length;

/** Every text value of an action's parameters through the parameter masking again. */
function maskParams(value: unknown): unknown {
  if (typeof value === "string") return scrubParam(value);
  if (Array.isArray(value)) return value.map(maskParams);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskParams(v)]));
  return value;
}

/** A receipt as shown: its parameters masked again, and its opaque slot as `<opaque, N bytes>` unless `raw`. */
export function shownReceipt(receipt: unknown, raw = false): unknown {
  if (!isObject(receipt) || !isObject(receipt.payload)) return receipt;
  const payload: Json = { ...receipt.payload };
  if (isObject(payload.intent)) payload.intent = { ...payload.intent, params: maskParams(payload.intent.params) };
  if (typeof payload.intel === "string" && !raw) payload.intel = `<opaque, ${slotBytes(payload.intel)} bytes>`;
  return { ...receipt, payload };
}

/** A request's body as shown (see `shownReceipt`). */
export function shownBody(body: Json, raw = false): Json {
  return Array.isArray(body.receipts) ? { ...body, receipts: body.receipts.map((r) => shownReceipt(r, raw)) } : body;
}

export interface UploadCategories {
  requests: number;
  bytes: number;
  /** Records sent one by one, and summaries with how many records they stand for. */
  records: number;
  summaries: number;
  summarized_records: number;
  action_kinds: Record<string, number>;
  /** The parameters the records' actions name (path, host, ref, command, …), by how many records name each. */
  parameters: Record<string, number>;
  rule_results: Record<string, number>;
  /** The rules that matched a record (blocked it, or recorded a match). */
  rules: Record<string, number>;
  coding_tools: Record<string, number>;
  /** Records that carry a plugin's opaque slot. */
  with_slot: number;
}

const bump = (map: Record<string, number>, key: string, n = 1): void => { map[key] = (map[key] ?? 0) + n; };

/** What the requests carry, by category. */
export function uploadCategories(requests: readonly UploadRequest[]): UploadCategories {
  const out: UploadCategories = { requests: requests.length, bytes: 0, records: 0, summaries: 0, summarized_records: 0, action_kinds: {}, parameters: {}, rule_results: {}, rules: {}, coding_tools: {}, with_slot: 0 };
  for (const request of requests) {
    out.bytes += request.bytes;
    for (const receipt of Array.isArray(request.body.receipts) ? request.body.receipts : []) {
      const payload = isObject(receipt) && isObject(receipt.payload) ? receipt.payload : {};
      const intent = isObject(payload.intent) ? payload.intent : {};
      out.records++;
      bump(out.action_kinds, named(intent.action_type));
      for (const name of Object.keys(isObject(intent.params) ? intent.params : {})) bump(out.parameters, name);
      bump(out.rule_results, named(payload.realtime_result));
      if (typeof payload.clause_id === "string") bump(out.rules, payload.clause_id);
      bump(out.coding_tools, isObject(payload.context) && typeof payload.context.harness === "string" ? payload.context.harness : "not named");
      if (typeof payload.intel === "string") out.with_slot++;
    }
    // Each item is `{ summary, seq }`: the signed summary, and which of the queue's record numbers it stands for.
    for (const item of Array.isArray(request.body.summaries) ? request.body.summaries : []) {
      const summary = isObject(item) && isObject(item.summary) ? item.summary : {};
      const payload = isObject(summary.payload) ? summary.payload : {};
      out.summaries++;
      out.summarized_records += Number(payload.receipt_count ?? 0);
      for (const count of Array.isArray(payload.counts) ? payload.counts : []) {
        if (!isObject(count)) continue;
        bump(out.action_kinds, named(count.action_type), Number(count.count ?? 0));
        bump(out.rule_results, named(count.result), Number(count.count ?? 0));
      }
      bump(out.coding_tools, typeof payload.harness === "string" ? payload.harness : "not named", Number(payload.receipt_count ?? 0));
    }
  }
  return out;
}

/** One record as it would be made now for a harmless command, in a throwaway folder: what one record carries. Not queued. */
export async function exampleRecord(): Promise<unknown> {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "scopebond-intel-show-")));
  try {
    scaffold(home);
    const project = join(home, "project");
    mkdirSync(project);
    const runtime = createHookRuntime({ policyPath: join(home, "policy.json"), keyPath: join(home, "agent.key"), attesterPath: join(home, "attester.key"), dbPath: join(home, "receipts.db"), restorable: () => false });
    try {
      const decision = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: project }));
      return decision.receipt ?? null;
    } finally { runtime.close(); }
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5 }); } catch { /* the OS temp folder is cleaned later */ }
  }
}

const listed = (map: Record<string, number>): string =>
  Object.entries(map).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

/** The preview as lines for a terminal: the categories, then the first request's body as it is sent (with the screen's
 *  changes), then one line for each request after it. With `raw`, each opaque slot's base64 follows the body. */
export function intelShowLines(preview: UploadPreview, example: unknown, raw = false): string[] {
  const lines: string[] = [];
  if (!preview.connected) {
    lines.push("This computer is not connected to a Scopebond Cloud workspace: nothing is uploaded. Records stay in the local log.");
  } else if (!preview.requests.length) {
    lines.push(`Nothing is waiting to be sent to ${preview.workspace}.`);
    if (preview.held.routine) lines.push(`${preview.held.routine} routine record${preview.held.routine === 1 ? " waits" : "s wait"} for its summary window${preview.held.until ? ` (it closes at ${new Date(preview.held.until).toISOString()})` : ""}; they then go as one summary.`);
  }
  if (!preview.requests.length) {
    lines.push("", "One record carries these fields (a record made now for `git status` in a throwaway folder; it is not sent):");
    lines.push(JSON.stringify(shownReceipt(example), null, 2));
    return lines;
  }
  const c = uploadCategories(preview.requests);
  lines.push(`The next upload to ${preview.workspace}: ${c.requests} request${c.requests === 1 ? "" : "s"}, ${c.bytes} bytes (${preview.queued} records queued).`);
  lines.push(`  records        ${c.records} sent one by one${c.summaries ? `, ${c.summaries} summar${c.summaries === 1 ? "y" : "ies"} standing for ${c.summarized_records} more` : ""}`);
  if (preview.held.routine) lines.push(`  held           ${preview.held.routine} routine record${preview.held.routine === 1 ? " waits" : "s wait"} for its summary window${preview.held.until ? ` (closes ${new Date(preview.held.until).toISOString()})` : ""}`);
  lines.push(`  action kinds   ${listed(c.action_kinds)}`);
  lines.push(`  parameters     ${listed(c.parameters)}`);
  lines.push(`  rule results   ${listed(c.rule_results)}${Object.keys(c.rules).length ? ` (rules matched: ${listed(c.rules)})` : ""}`);
  lines.push(`  coding tools   ${listed(c.coding_tools)}`);
  lines.push(`  plugin slot    ${c.with_slot ? `${c.with_slot} record${c.with_slot === 1 ? " carries" : "s carry"} an opaque slot (shown as its size${raw ? ", and its base64" : ""})` : "no record carries one"}`);
  const [first, ...rest] = preview.requests;
  lines.push("", `POST ${first.route} (${first.bytes} bytes):`);
  lines.push(JSON.stringify(shownBody(first.body), null, 2));
  if (raw) {
    for (const receipt of Array.isArray(first.body.receipts) ? first.body.receipts : []) {
      const payload = isObject(receipt) && isObject(receipt.payload) ? receipt.payload : {};
      if (typeof payload.intel === "string") lines.push(`opaque slot of ${named(isObject(payload.action_ref) ? payload.action_ref.action_id : null)} (base64): ${payload.intel}`);
    }
  }
  for (const request of rest) {
    const n = Array.isArray(request.body.receipts) ? `${request.body.receipts.length} records` : Array.isArray(request.body.summaries) ? `${request.body.summaries.length} summaries` : "";
    lines.push(`then POST ${request.route} (${n}, ${request.bytes} bytes); --json shows it`);
  }
  return lines;
}

/** The preview for `--json`: the categories, and every request's body (with the screen's changes). */
export function intelShowJson(preview: UploadPreview, example: unknown, raw = false): Json {
  return {
    connected: preview.connected, workspace: preview.workspace, queued: preview.queued, held: preview.held,
    categories: uploadCategories(preview.requests),
    uploads: preview.requests.map((r) => ({ route: r.route, bytes: r.bytes, body: shownBody(r.body, raw) })),
    ...(preview.requests.length ? {} : { example: shownReceipt(example, raw) }),
  };
}
