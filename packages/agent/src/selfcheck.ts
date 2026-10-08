// The daily end-to-end self-check (SB347). The agent checks this computer's side (the hook entry
// is present and starts, autostart works, nothing is stuck, the connection is not about to lapse),
// then signs the day with the key it enrolled with and sends everything to the workspace, which
// verifies the signature. A pass means the whole path works, end to end; a failure names what broke.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonical } from "@scopebond/gateway";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import {
  configuredHookCommands, duplicateHooks, hookCommandResolves, hookVersion, isScopebondHookCommand, queueStatus, readDeliveryState, userHarnessFile,
  type Harness, type HookConnection,
} from "@scopebond/hook";
import { autostartHealth } from "./autostart.js";
import { installKind } from "./native-update.js";

export interface SelfCheckItem { id: string; ok: boolean; detail?: string }

export function selfCheckProof(credentialId: string, gatewayId: string, day: string): string {
  return canonical({ type: "scopebond:self-check", version: 1, credential_id: credentialId, gateway_id: gatewayId, day });
}

export function localChecks(dir: string, connection: HookConnection, harnesses: Harness[], now = Date.now()): SelfCheckItem[] {
  const checks: SelfCheckItem[] = [];
  const entries = harnesses.flatMap((h) => configuredHookCommands(userHarnessFile(h)).filter((c) => isScopebondHookCommand(c)));
  checks.push({ id: "hook_entry", ok: entries.length > 0, ...(entries.length ? {} : { detail: "no agent setting holds the Scopebond hook" }) });
  const broken = entries.filter((c) => !hookCommandResolves(c));
  checks.push({ id: "hook_starts", ok: entries.length > 0 && broken.length === 0, ...(broken.length ? { detail: `${broken.length} hook command(s) cannot start` } : {}) });
  // SB302: the hook twice in the user settings, or an enabled plugin beside them, signs and sends every action twice.
  const dupes = harnesses.flatMap((h) => duplicateHooks(h, homedir()) ? [h] : []);
  checks.push({ id: "hook_duplicates", ok: dupes.length === 0, ...(dupes.length ? { detail: `the Scopebond hook runs more than once per action for ${dupes.join(", ")} (fix: ${process.platform === "win32" ? "npx.cmd" : "npx"} -y @scopebond/hook@${hookVersion()} dedupe)` } : {}) });
  const autostart = autostartHealth(dir);
  checks.push({ id: "autostart", ok: autostart.ok, ...(autostart.ok ? {} : { detail: autostart.detail }) });
  const { pending, oldest } = queueStatus(dir);
  const state = readDeliveryState(dir);
  const stuck = pending > 0 && oldest !== null && now - oldest > 60 * 60 * 1000;
  checks.push({ id: "queue", ok: !stuck, ...(stuck ? { detail: `${pending} record(s) waiting since ${new Date(oldest!).toISOString()}${state.last_error ? ` (${state.last_error.slice(0, 120)})` : ""}` } : {}) });
  const expires = Date.parse(connection.expires_at ?? "");
  const lapsing = Number.isFinite(expires) && expires - now < 7 * 24 * 60 * 60 * 1000;
  checks.push({ id: "credential", ok: !lapsing, ...(lapsing ? { detail: `the connection expires ${new Date(expires).toISOString()} and was not renewed` } : {}) });
  return checks;
}

export async function runSelfCheck(
  dir: string, connection: HookConnection, harnesses: Harness[], agentVersion: string,
  options: { fetchImpl?: typeof fetch; now?: number; timeoutMs?: number } = {},
): Promise<{ ok: boolean; signature_verified: boolean; failed: string[]; checks: SelfCheckItem[] } | null> {
  const now = options.now ?? Date.now();
  const checks = localChecks(dir, connection, harnesses, now);
  const keyFile = join(dir, "attester.key");
  if (!existsSync(keyFile)) return { ok: false, signature_verified: false, failed: ["signing_key"], checks };
  const day = new Date(now).toISOString().slice(0, 10);
  const { attester } = loadOrCreateAttester({ file: keyFile });
  const signature = await attester.sign(selfCheckProof(connection.credential_id, connection.gateway_id, day));
  try {
    const res = await (options.fetchImpl ?? fetch)(new URL("/v1/self-check", connection.url).toString(), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { authorization: `Bearer ${connection.credential}`, "content-type": "application/json" },
      // install_kind: how this agent was installed (npm, per-user or per-machine signed installer), so the workspace can say
      // how the computer updates and is removed. A workspace that does not read it ignores it.
      body: JSON.stringify({ signature, day, checks, hook_version: hookVersion(), agent_version: agentVersion, install_kind: installKind() }),
    });
    // A workspace that does not offer the self-check yet answers 404: the computer's own checks still count; the signed
    // workspace part is simply not available there.
    if (res.status === 404) { const failed = checks.filter((c) => !c.ok).map((c) => c.id); return { ok: failed.length === 0, signature_verified: false, failed, checks }; }
    if (!res.ok) return { ok: false, signature_verified: false, failed: [`workspace_http_${res.status}`], checks };
    const body = await res.json() as { ok?: boolean; signature_verified?: boolean; failed?: string[] };
    return { ok: !!body.ok, signature_verified: !!body.signature_verified, failed: Array.isArray(body.failed) ? body.failed : [], checks };
  } catch (error) {
    return { ok: false, signature_verified: false, failed: [`workspace_unreachable: ${(error as Error).message.slice(0, 80)}`], checks };
  }
}
