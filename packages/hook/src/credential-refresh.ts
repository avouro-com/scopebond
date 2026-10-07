// A machine credential lasts 90 days. In its last 30 the hook renews it during the rules check,
// proving it still holds the signing key it enrolled with, so a computer never stops delivering
// because nobody signed it in again. The workspace keeps the old credential valid for a day, so
// an answer lost on the way back is harmless: the next check tries again.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { connectionPath, type HookConnection } from "./cloud.js";
import { forgetCached } from "./config-cache.js";

export const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function refreshProof(credentialId: string, gatewayId: string): string {
  return canonical({ type: "scopebond:credential-refresh", version: 1, credential_id: credentialId, gateway_id: gatewayId });
}

export type RefreshOutcome = "not_due" | "renewed" | "unchanged" | "refused" | "unavailable";

/** Renew the credential when it expires within 30 days. Never throws. */
export async function refreshIfDue(
  dir: string, connection: HookConnection,
  options: { fetchImpl?: typeof fetch; now?: number; timeoutMs?: number } = {},
): Promise<RefreshOutcome> {
  try {
    const now = options.now ?? Date.now();
    const expires = Date.parse(connection.expires_at ?? "");
    if (!Number.isFinite(expires) || expires - now > REFRESH_WINDOW_MS) return "not_due";
    const keyFile = join(dir, "attester.key");
    if (!existsSync(keyFile)) return "refused";
    const { attester } = loadOrCreateAttester({ file: keyFile });
    const signature = await attester.sign(refreshProof(connection.credential_id, connection.gateway_id));
    const response = await (options.fetchImpl ?? fetch)(new URL("/v1/credential/refresh", connection.url).toString(), {
      method: "POST",
      headers: { authorization: `Bearer ${connection.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ signature }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!response.ok) return response.status === 401 || response.status === 409 ? "refused" : "unavailable";
    const body = await response.json() as { refreshed?: boolean; id?: string; credential?: string; expires_at?: string };
    if (!body.refreshed) return "unchanged";
    if (typeof body.credential !== "string" || !body.credential.startsWith("sbm_") || typeof body.id !== "string" || typeof body.expires_at !== "string") return "unavailable";
    // Re-read before writing: another hook process may have renewed it in the meantime.
    const path = connectionPath(dir);
    const current = JSON.parse(readFileSync(path, "utf8")) as HookConnection;
    if (current.credential !== connection.credential) return "unchanged";
    const next: HookConnection = { ...current, credential: body.credential, credential_id: body.id, expires_at: body.expires_at };
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    forgetCached(path);
    renameSync(temp, path);
    return "renewed";
  } catch {
    return "unavailable";
  }
}
