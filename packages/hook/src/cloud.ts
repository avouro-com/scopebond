// scopebond-hook → Scopebond Cloud: enroll the machine's countersigning key with a
// workspace and auto-export signed receipts to the hosted portal, so a connected
// hook starts monitoring automatically. Reuses the gateway's enrollment and bounded
// durable exporter (D40 — no new transport). The machine credential and the complete
// receipt log stay local-first; export is best-effort and never blocks a tool call.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  completeCloudEnrollment, createCloudExporter, withCloudExporter,
  type CloudEnrollmentBundle, type CloudEnrollmentResult, type CloudExporter, type ReceiptStore,
} from "@scopebond/gateway";
import { SqliteCloudOutbox, loadOrCreateAttester } from "@scopebond/gateway/node";

/** The persisted connection between this machine and a Cloud workspace. Holds the
 *  scoped machine credential; treat cloud.json as a secret (written 0600). */
export interface HookConnection extends CloudEnrollmentResult {
  url: string;
}

export const connectionPath = (dir: string): string => join(dir, "cloud.json");

/** Read the persisted connection, or null when the hook is not connected to Cloud. */
export function loadConnection(dir: string): HookConnection | null {
  const path = connectionPath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HookConnection>;
    if (typeof parsed.url === "string" && typeof parsed.credential === "string") return parsed as HookConnection;
  } catch { /* fall through */ }
  return null;
}

/** Enroll the machine's attester with a workspace using the portal's one-use handoff,
 *  then persist the scoped machine credential. The attester whose possession is proved
 *  here is the same key the hook countersigns receipts with, so ingest accepts them. */
export async function connectCloud(
  dir: string, url: string, bundle: CloudEnrollmentBundle, fetchImpl?: typeof fetch,
): Promise<HookConnection> {
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  const { attester: agent } = loadOrCreateAttester({ file: join(dir, "agent.key") });
  const result = await completeCloudEnrollment({ url, bundle, attester, agent, fetch: fetchImpl });
  const connection: HookConnection = { url, ...result };
  writeFileSync(connectionPath(dir), JSON.stringify(connection, null, 2) + "\n", { mode: 0o600 });
  return connection;
}

/** Wrap a receipt store so every stored receipt is enqueued to a durable outbox and
 *  exported to Cloud. Returns the wrapped store and the exporter (flush + stop). */
export function attachExporter(
  outboxDbPath: string, connection: HookConnection, store: ReceiptStore, fetchImpl?: typeof fetch,
): { store: ReceiptStore; exporter: CloudExporter } {
  const outbox = new SqliteCloudOutbox(outboxDbPath);
  const exporter = createCloudExporter({ url: connection.url, credential: connection.credential, outbox, fetch: fetchImpl });
  return { store: withCloudExporter(store, exporter), exporter };
}

/** Attempt delivery with a bounded timeout so a per-invocation hook never hangs the
 *  agent; undelivered receipts stay in the durable outbox and flush next time. */
export async function flushBounded(exporter: CloudExporter, timeoutMs = 3000): Promise<void> {
  await Promise.race([
    exporter.flush().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)).unref?.()),
  ]);
}
