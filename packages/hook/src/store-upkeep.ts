// Keeping the local store small (SB401–SB405, D144). Every action still gets a signed receipt here; what is bounded is how
// long the computer keeps one the workspace already holds. A receipt is removed only after the workspace acknowledged it,
// and only once the retention window (30 days by default, 7–365 as the workspace sets it) has passed. A computer with no
// workspace keeps everything until `prune`. The Scopebond Agent runs the upkeep; a hook-only install runs a short pass
// itself once a day, and starts a background compaction for an older file.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteReceiptStore, type StoreMaintenanceReport } from "@scopebond/gateway/node";
// A namespace import, so a hook running beside an older gateway (one without `historyNeed`) still loads; it then keeps
// every receipt, which is the safe answer.
import * as gatewayCore from "@scopebond/gateway";

type HistoryNeedOf = (policy: unknown) => { kind: "none" } | { kind: "all" } | { kind: "window"; ms: number };
import { loadConnection } from "./cloud.js";
import { OUTBOX_FILE } from "./delivery-report.js";
import { readMeta } from "./managed.js";

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const UPKEEP_FILE = "store-upkeep.json";
const HOOK_UPKEEP_EVERY_MS = DAY_MS;
const HOUR_MS = 60 * 60 * 1000;
/** A hook call's upkeep waits this long at most for another process's lock, then leaves the pass for later. */
const CALL_BUSY_MS = 100;

/** The workspace's local retention, from the rules check's `x-scopebond-local-retention-days` header. Out of range is clamped;
 *  anything unreadable is ignored (the last good value, or the default, stays). */
export function retentionDaysFrom(headers: { get(name: string): string | null } | undefined): number | null {
  const raw = headers?.get?.("x-scopebond-local-retention-days")?.trim() ?? "";
  if (!/^\d{1,4}$/.test(raw)) return null;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Number(raw)));
}

/** How long this computer keeps receipts the workspace acknowledged, in days, or null to keep everything (no workspace, or
 *  a policy that reads its whole history). A policy that reads a window keeps at least that window and a day. */
export function localRetentionDays(dir: string): number | null {
  if (!loadConnection(dir)) return null;
  const set = readMeta(dir).local_retention_days;
  let days = typeof set === "number" && Number.isFinite(set)
    ? Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(set)))
    : DEFAULT_RETENTION_DAYS;
  const historyNeed = (gatewayCore as { historyNeed?: HistoryNeedOf }).historyNeed;
  if (!historyNeed) return null;
  try {
    const need = historyNeed(JSON.parse(readFileSync(join(dir, "policy.json"), "utf8").replace(/^﻿/, "")));
    if (need.kind === "all") return null;
    if (need.kind === "window") days = Math.max(days, Math.ceil(need.ms / DAY_MS) + 1);
  } catch { return null; } // no readable policy: keep everything
  return days;
}

export interface UpkeepOptions {
  now?: number;
  /** How long a step waits for another process's write lock (default 15 s; a hook call passes a short one). */
  busyTimeoutMs?: number;
  budgetMs?: number;
  batch?: number;
  /** One full rewrite of an older file so later passes can shrink it in steps (the agent and `prune --compact`). */
  allowFullVacuum?: boolean;
}

/** One bounded upkeep pass over `<dir>/receipts.db`. Null when there is no store. */
export function runStoreUpkeep(dir: string, options: UpkeepOptions = {}): StoreMaintenanceReport | null {
  const dbPath = join(dir, "receipts.db");
  if (!existsSync(dbPath)) return null;
  const now = options.now ?? Date.now();
  const days = localRetentionDays(dir);
  const store = new SqliteReceiptStore(dbPath, options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs });
  try {
    const report = store.maintain({
      now,
      ...(days === null ? {} : { retainAcknowledgedMs: days * DAY_MS }),
      outboxPath: join(dir, OUTBOX_FILE),
      budgetMs: options.budgetMs,
      batch: options.batch,
      allowFullVacuum: options.allowFullVacuum,
    });
    writeUpkeep(dir, { ...readUpkeep(dir), at: new Date(now).toISOString(), layout_current: report.layoutCurrent, more: report.more });
    return report;
  } finally {
    store.close();
  }
}

/** What a hook call does when nothing else keeps the store: once a day, a short retention pass. Rewriting an older file (its
 *  layout, then the whole file to return the space) reads most of it, so a separate process does that and no tool call
 *  waits; it is asked at most once an hour while the file is old, then once a day. Never throws: the decision is already
 *  recorded when this runs. */
export function upkeepIfDue(dir: string, now = Date.now(), compact: (dir: string) => void = compactInBackground): void {
  try {
    const last = readUpkeep(dir);
    const askedAt = Date.parse(last.compact_requested_at ?? "");
    const ask = (every: number) => {
      if (Number.isFinite(askedAt) && now - askedAt < every) return;
      writeUpkeep(dir, { ...readUpkeep(dir), compact_requested_at: new Date(now).toISOString() });
      compact(dir);
    };
    if (last.layout_current === false) { ask(HOUR_MS); return; }
    const lastAt = Date.parse(last.at ?? "");
    if (Number.isFinite(lastAt) && now - lastAt < HOOK_UPKEEP_EVERY_MS) return;
    const dbPath = join(dir, "receipts.db");
    if (!existsSync(dbPath)) return;
    const store = new SqliteReceiptStore(dbPath, { busyTimeoutMs: CALL_BUSY_MS });
    let current: boolean;
    try { current = store.layoutCurrent(); } finally { store.close(); }
    if (!current) {
      writeUpkeep(dir, { ...readUpkeep(dir), layout_current: false });
      ask(HOUR_MS);
      return;
    }
    const report = runStoreUpkeep(dir, { now, budgetMs: 300, batch: 500, busyTimeoutMs: CALL_BUSY_MS });
    if (report?.rewriteWanted) ask(HOOK_UPKEEP_EVERY_MS);
  } catch { /* upkeep is best effort; the next call tries again */ }
}

interface UpkeepState { at?: string; layout_current?: boolean; more?: boolean; compact_requested_at?: string }

function readUpkeep(dir: string): UpkeepState {
  try { return JSON.parse(readFileSync(join(dir, UPKEEP_FILE), "utf8")) as UpkeepState; } catch { return {}; }
}

function writeUpkeep(dir: string, state: UpkeepState): void {
  try { writeFileSync(join(dir, UPKEEP_FILE), `${JSON.stringify(state)}\n`); } catch { /* the next pass runs sooner, which is harmless */ }
}

/** `prune --compact --quiet` in a detached process, for this store's folder. */
function compactInBackground(dir: string): void {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  spawn(process.execPath, [cli, "prune", "--compact", "--quiet"], {
    cwd: tmpdir(), env: { ...process.env, SCOPEBOND_HOOK_DIR: dir }, detached: true, stdio: "ignore", windowsHide: true,
  }).unref();
}
