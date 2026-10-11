// scopebond-mcp → Scopebond Cloud: enroll the proxy's signing key with a workspace
// and export the PEP-authorized receipts it emits, so governed MCP tool calls show
// in the hosted portal. Reuses the gateway's enrollment and durable exporter.
// The proxy is long-running, so the exporter's own flush timer delivers; a durable
// outbox next to the key survives restarts.

import { existsSync, readFileSync } from "node:fs";
import {
  completeCloudEnrollment, createCloudExporter, LOSSLESS_CLOUD_OUTBOX,
  type CloudDeliveryGap, type CloudEnrollmentBundle, type CloudEnrollmentResult, type CloudExporter,
} from "@scopebond/gateway";
import { SqliteCloudOutbox, keepOwnerOnly, loadOrCreateAttester, placeOwnerOnly } from "@scopebond/gateway/node";

export interface McpConnection extends CloudEnrollmentResult {
  url: string;
}

export const connectionFileFor = (keyPath: string): string => keyPath + ".cloud.json";

export function loadMcpConnection(keyPath: string): McpConnection | null {
  const path = connectionFileFor(keyPath);
  if (!existsSync(path)) return null;
  // A credential file an older version wrote under its folder's ACL is restricted to its owner.
  keepOwnerOnly(path);
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
  // A new file, owner-only from its first byte, renamed into place: a file or link already there is replaced, not written through.
  placeOwnerOnly(connectionFileFor(keyPath), JSON.stringify(connection, null, 2) + "\n", false);
  return connection;
}

/** A durable exporter for a connection; enqueue each receipt and it flushes on the
 *  proxy's lifetime (timer) plus an explicit flush on shutdown. The outbox is lossless,
 *  like the hook's and the agent's: no cap and no expiry, so a long outage delays
 *  records instead of dropping them. Any gap it does record (a record with no id, one
 *  the workspace refused) is kept as a row in the outbox and passed to `onGap`. */
export function openExporter(
  keyPath: string, connection: McpConnection, fetchImpl?: typeof fetch,
  options: { onGap?: (gap: CloudDeliveryGap) => void } = {},
): CloudExporter {
  const outbox = new SqliteCloudOutbox(keyPath + ".cloud-outbox.db", LOSSLESS_CLOUD_OUTBOX);
  return createCloudExporter({
    url: connection.url, credential: connection.credential, outbox, fetch: fetchImpl,
    onGap: options.onGap ?? ((gap) => process.stderr.write(`scopebond-mcp: cloud delivery gap: ${gap.reason}${gap.id ? ` (${gap.id})` : ""}\n`)),
  });
}
