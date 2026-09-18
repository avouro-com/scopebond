// scopebond-mcp → Scopebond Cloud: enroll the proxy's signing key with a workspace
// and export the PEP-authorized receipts it emits, so governed MCP tool calls show
// in the hosted portal. Reuses the gateway's enrollment and durable exporter (D40).
// The proxy is long-running, so the exporter's own flush timer delivers; a durable
// outbox next to the key survives restarts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  completeCloudEnrollment, createCloudExporter,
  type CloudEnrollmentBundle, type CloudEnrollmentResult, type CloudExporter,
} from "@scopebond/gateway";
import { SqliteCloudOutbox, loadOrCreateAttester } from "@scopebond/gateway/node";

export interface McpConnection extends CloudEnrollmentResult {
  url: string;
}

export const connectionFileFor = (keyPath: string): string => keyPath + ".cloud.json";

export function loadMcpConnection(keyPath: string): McpConnection | null {
  const path = connectionFileFor(keyPath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<McpConnection>;
    if (typeof parsed.url === "string" && typeof parsed.credential === "string") return parsed as McpConnection;
  } catch { /* fall through */ }
  return null;
}

/** Enroll the proxy's signing key (its attester) with a workspace via the one-use
 *  handoff, then persist the scoped machine credential next to the key. */
export async function connectCloud(
  keyPath: string, url: string, bundle: CloudEnrollmentBundle, fetchImpl?: typeof fetch,
): Promise<McpConnection> {
  const { attester } = loadOrCreateAttester({ file: keyPath });
  const result = await completeCloudEnrollment({ url, bundle, attester, fetch: fetchImpl });
  const connection: McpConnection = { url, ...result };
  writeFileSync(connectionFileFor(keyPath), JSON.stringify(connection, null, 2) + "\n", { mode: 0o600 });
  return connection;
}

/** A durable exporter for a connection; enqueue each receipt and it flushes on the
 *  proxy's lifetime (timer) plus an explicit flush on shutdown. */
export function openExporter(keyPath: string, connection: McpConnection, fetchImpl?: typeof fetch): CloudExporter {
  const outbox = new SqliteCloudOutbox(keyPath + ".cloud-outbox.db");
  return createCloudExporter({ url: connection.url, credential: connection.credential, outbox, fetch: fetchImpl });
}
