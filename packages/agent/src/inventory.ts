import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonical, sha256 } from "@scopebond/gateway";
import { loadOrCreateAttester, placeOwnerOnly } from "@scopebond/gateway/node";
import { ADAPTER_REGISTRY_VERSION, HARNESSES, type HookConnection } from "@scopebond/hook";
import { integrationHealth, type IntegrationHealth } from "./integration-health.js";

export const INVENTORY_CAPABILITY = "tool_inventory_1";
export const INVENTORY_FILE = "integration-inventory.json";
export type ExecutionEnvironment = "windows" | "macos" | "linux" | "wsl" | "container" | "remote" | "unknown";

/** Only an environment category leaves the process. Host hooks never imply remote protection. */
export function executionEnvironment(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ExecutionEnvironment {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.REMOTE_CONTAINERS || env.CODESPACES) return "remote";
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl";
  if (env.container || env.CONTAINER || env.REMOTE_CONTAINERS_IPC) return "container";
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : "unknown";
}
export function inventoryProof(connection: Pick<HookConnection, "credential_id" | "organization_id" | "environment_id" | "gateway_id">, digest: string): string {
  return canonical({ type: "scopebond:tool-inventory", version: 1, organization_id: connection.organization_id,
    environment_id: connection.environment_id, gateway_id: connection.gateway_id, credential_id: connection.credential_id, report_digest: digest });
}
interface ToolFact {
  id: string;
  presence: IntegrationHealth["presence"];
  integration: IntegrationHealth["integration"];
  reason: IntegrationHealth["reason"];
  definition_revision: string | null;
  checked_at: number;
}
interface Snapshot {
  registry_version: number;
  execution: ExecutionEnvironment;
  collection: "complete" | "partial" | "failed";
  tools: ToolFact[];
}
export type InventoryDelivery = "not_connected" | "not_supported" | "signing_key_missing" | "reported" | "retrying";

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("empty inventory response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 128 * 1024) { await reader.cancel(); throw new Error("inventory response too large"); }
    chunks.push(value);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid inventory response");
  return value as Record<string, unknown>;
}

/** Independent control-plane reports, bounded to one operation at a time and one attempt per five seconds.
 *  A server sequence read recovers after restart/lost acknowledgement without trusting a local counter.
 *  No action receipt, billing state, native trust database or raw configuration is read here. */
export function createInventoryReporter(options: {
  dir: string;
  connection: () => HookConnection | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  collect?: (now: number) => IntegrationHealth[];
  execution?: () => ExecutionEnvironment;
  timeoutMs?: number;
}) {
  let running = false;
  let nextAttempt = 0;
  let lastReported = 0;
  let lastDigest = "";
  let lastScope = "";
  let lastTools: ToolFact[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const stopped = new AbortController();
  let delivery: InventoryDelivery = "not_connected";
  const fetchImpl = options.fetchImpl ?? fetch;
  const state = () => ({ delivery, reported_at: lastReported || null });
  const reconcile = async (): Promise<void> => {
    if (running || stopped.signal.aborted) return;
    running = true;
    try {
      const now = (options.now ?? Date.now)();
      const connection = options.connection();
      const scope = connection ? sha256(canonical({ url: connection.url, organization: connection.organization_id, gateway: connection.gateway_id, credential: connection.credential_id })) : "";
      if (scope !== lastScope) { lastScope = scope; lastReported = 0; lastDigest = ""; lastTools = []; nextAttempt = 0; }
      const execution = (options.execution ?? executionEnvironment)();
      let snapshot: Snapshot;
      try {
        const health = (options.collect ?? ((at) => integrationHealth(HARNESSES, at)))(now);
        snapshot = { registry_version: ADAPTER_REGISTRY_VERSION, execution,
          collection: health.some((t) => t.presence === "unknown" || t.reason === "invalid_configuration") ? "partial" : "complete",
          // Explicit field selection: new local diagnostic fields must not silently become uploaded data.
          tools: health.slice(0, 20).map((t) => ({ id: t.harness, presence: t.presence, integration: t.integration,
            reason: t.reason, definition_revision: t.definition_revision, checked_at: now })) };
      } catch { snapshot = { registry_version: ADAPTER_REGISTRY_VERSION, execution, collection: "failed", tools: [] }; }
      const digest = sha256(canonical({ ...snapshot, tools: snapshot.tools.map((t) => ({ ...t, checked_at: 0 })) }));
      if (snapshot.collection !== "failed") lastTools = snapshot.tools;
      const save = () => {
        const tools = snapshot.collection === "failed" ? lastTools.map((t) => ({ ...t, presence: "unknown" })) : snapshot.tools;
        if (!stopped.signal.aborted) placeOwnerOnly(join(options.dir, INVENTORY_FILE), JSON.stringify({ ...snapshot, tools, observed_at: now, ...state() }) + "\n", false);
      };
      if (!connection) { delivery = "not_connected"; save(); return; }
      if (now < nextAttempt) {
        // A change during the small healthy-request throttle still reports promptly, even with no later filesystem event.
        if (digest !== lastDigest && retryTimer === null) {
          retryTimer = setTimeout(() => { retryTimer = null; void reconcile().catch(() => { delivery = "retrying"; }); }, nextAttempt - now);
          retryTimer.unref?.();
        }
        save(); return;
      }
      if (digest === lastDigest && now - lastReported < 60_000) { save(); return; }
      nextAttempt = now + 5_000;
      const key = join(options.dir, "attester.key");
      if (!existsSync(key)) { delivery = "signing_key_missing"; save(); return; }
      const endpoint = new URL("/v1/tool-inventory", connection.url);
      if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(endpoint.hostname)) throw new Error("unsafe inventory origin");
      if (endpoint.username || endpoint.password) throw new Error("unsafe inventory origin");
      const headers = { authorization: `Bearer ${connection.credential}`, "content-type": "application/json" };
      const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(options.timeoutMs ?? 8_000)]);
      try {
        const response = await fetchImpl(endpoint, { redirect: "error", signal, headers });
        if (response.status === 404) { delivery = "not_supported"; nextAttempt = now + 60_000; save(); return; }
        if (!response.ok) throw new Error("inventory handshake refused");
        const hello = await boundedJson(response);
        if (hello.capability !== INVENTORY_CAPABILITY) { delivery = "not_supported"; nextAttempt = now + 60_000; save(); return; }
        if (!Number.isSafeInteger(hello.sequence) || Number(hello.sequence) < 0 || Number(hello.sequence) >= Number.MAX_SAFE_INTEGER) throw new Error("invalid inventory sequence");
        const report = { ...snapshot, version: 1, report_id: randomUUID(), sequence: Number(hello.sequence) + 1, observed_at: now };
        const { attester } = loadOrCreateAttester({ file: key });
        const signature = await attester.sign(inventoryProof(connection, sha256(canonical(report))));
        const result = await fetchImpl(endpoint, { method: "POST", redirect: "error", signal, headers, body: JSON.stringify({ report, signature }) });
        if (!result.ok) throw new Error("inventory report refused");
        const ack = await boundedJson(result);
        if (ack.ok !== true || ack.sequence !== report.sequence) throw new Error("invalid inventory acknowledgement");
        delivery = "reported"; lastReported = now; lastDigest = digest;
      } catch { delivery = "retrying"; nextAttempt = now + 60_000; }
      save();
    } finally { running = false; }
  };
  return { reconcile, state, stop: () => { stopped.abort(); if (retryTimer !== null) clearTimeout(retryTimer); } };
}
