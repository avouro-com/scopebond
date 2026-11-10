// The daily end-to-end self-check. The agent checks this computer's side (the hook entry
// is present and starts, autostart works, nothing is stuck, the connection is not about to lapse),
// then signs the day with the key it enrolled with and sends everything to the workspace, which
// verifies the signature. This checks configuration and transport, not native invocation or coverage.

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
import { hookCli } from "./commands.js";
import { missingPrograms } from "./hook-entries.js";
import { discoverTools, type ToolDiscovery } from "./tools.js";
import { integrationHealth } from "./integration-health.js";
import { hookPins, type HookPin, type IntentState, type TamperFinding } from "./hook-pin.js";

export interface SelfCheckItem { id: string; ok: boolean; detail?: string }

export function selfCheckProof(credentialId: string, gatewayId: string, day: string): string {
  return canonical({ type: "scopebond:self-check", version: 1, credential_id: credentialId, gateway_id: gatewayId, day });
}

export function localChecks(dir: string, connection: HookConnection, harnesses: Harness[], now = Date.now()): SelfCheckItem[] {
  const checks: SelfCheckItem[] = [];
  const integrations = integrationHealth(harnesses, now);
  const missing = integrations.filter((h) => !h.entry).map((h) => h.harness);
  const entries = harnesses.flatMap((h) => configuredHookCommands(userHarnessFile(h)).filter((c) => isScopebondHookCommand(c)));
  checks.push({ id: "hook_entry", ok: integrations.length > 0 && missing.length === 0, ...(missing.length ? { detail: `missing or disabled Scopebond entry: ${missing.join(", ")}` } : integrations.length ? {} : { detail: "no supported coding tool detected" }) });
  const broken = entries.filter((c) => !hookCommandResolves(c));
  // A hook entry whose program is gone (Scopebond removed for every user of this computer, or an npm copy uninstalled)
  // names the missing file, so the person knows what to remove or install again.
  const gone = missingPrograms(broken);
  checks.push({ id: "hook_starts", ok: integrations.length > 0 && integrations.every((h) => h.executable), ...(broken.length ? { detail: `${broken.length} hook command(s) cannot start${gone.length ? ` (${gone.join(", ")} no longer there)` : ""}` } : {}) });
  // The hook twice in the user settings, or an enabled plugin beside them, signs and sends every action twice.
  const dupes = harnesses.filter((h) => integrations.some((i) => i.harness === h && i.duplicates) || duplicateHooks(h, homedir()));
  checks.push({ id: "hook_duplicates", ok: dupes.length === 0, ...(dupes.length ? { detail: `the Scopebond hook runs more than once per action for ${dupes.join(", ")} (fix: ${hookCli("dedupe")})` } : {}) });
  const autostart = autostartHealth(dir);
  checks.push({ id: "autostart", ok: autostart.ok, ...(autostart.ok ? {} : { detail: autostart.detail }) });
  const { pending, oldest } = queueStatus(dir);
  const state = readDeliveryState(dir);
  const stuck = pending > 0 && oldest !== null && now - oldest > 60 * 60 * 1000;
  checks.push({ id: "queue", ok: !stuck, ...(stuck ? { detail: `${pending} record(s) waiting since ${new Date(oldest).toISOString()}${state.last_error ? ` (${state.last_error.slice(0, 120)})` : ""}` } : {}) });
  const expires = Date.parse(connection.expires_at ?? "");
  const lapsing = Number.isFinite(expires) && expires - now < 7 * 24 * 60 * 60 * 1000;
  checks.push({ id: "credential", ok: !lapsing, ...(lapsing ? { detail: `the connection expires ${new Date(expires).toISOString()} and was not renewed` } : {}) });
  return checks;
}

/** Sent with every self-check (a workspace that does not read it ignores it): each coding tool's hook entry compared with
 *  the exact one this agent writes, as it is now, and the tamper found since the last report with whether it was repaired.
 *  Names what differs and digests only, never a file's contents. */
export interface HookIntegrity { version: 1; intent: IntentState; tools: HookPin[]; found: TamperFinding[] }

export interface SelfCheckResult extends ToolDiscovery {
  ok: boolean; signature_verified: boolean; failed: string[]; checks: SelfCheckItem[];
  hook_integrity?: HookIntegrity;
  /** Whether the workspace took the report (and with it the tamper found); kept for the next one otherwise. */
  integrity_reported?: boolean;
}

/** The hook integrity report: the tools on this computer as they are now, and what was found earlier. */
export function hookIntegrity(harnesses: readonly Harness[], dir: string | undefined, found: readonly TamperFinding[] = [], expected?: (harness: Harness) => string): HookIntegrity {
  const pins = hookPins(harnesses, { dir, expected });
  return { version: 1, intent: pins.intent, tools: pins.tools.filter((t) => t.state !== "not_checked"), found: [...found] };
}

/** Which coding tools this computer has, for the self-check; an empty report when finding out fails. */
async function toolReport(discover: () => Promise<ToolDiscovery>): Promise<ToolDiscovery> {
  try { return await discover(); } catch { return { tools: [], mcp_servers: [] }; }
}

export async function runSelfCheck(
  dir: string, connection: HookConnection, harnesses: Harness[], agentVersion: string,
  options: { fetchImpl?: typeof fetch; now?: number; timeoutMs?: number; discover?: () => Promise<ToolDiscovery>; tamper?: readonly TamperFinding[]; expected?: (harness: Harness) => string } = {},
): Promise<SelfCheckResult | null> {
  const now = options.now ?? Date.now();
  const checks = localChecks(dir, connection, harnesses, now);
  let hook_integrity: HookIntegrity | undefined;
  try { hook_integrity = hookIntegrity(harnesses, dir, options.tamper, options.expected); } catch { /* the report goes without it */ }
  // The AI coding tools on this computer and whether the hook checks them, with the names of their MCP servers: sent with
  // every self-check, so the workspace shows what the computer last reported (see tools.ts for exactly what is read).
  const { tools, mcp_servers } = await toolReport(options.discover ?? (() => discoverTools()));
  const local = { checks, tools, mcp_servers, ...(hook_integrity ? { hook_integrity } : {}) };
  const keyFile = join(dir, "attester.key");
  if (!existsSync(keyFile)) return { ok: false, signature_verified: false, failed: ["signing_key"], ...local, integrity_reported: false };
  const day = new Date(now).toISOString().slice(0, 10);
  const { attester } = loadOrCreateAttester({ file: keyFile });
  const signature = await attester.sign(selfCheckProof(connection.credential_id, connection.gateway_id, day));
  try {
    const res = await (options.fetchImpl ?? fetch)(new URL("/v1/self-check", connection.url).toString(), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { authorization: `Bearer ${connection.credential}`, "content-type": "application/json" },
      // install_kind: how this agent was installed (npm, per-user or per-machine signed installer), so the workspace can say
      // how the computer updates and is removed; hook_integrity: whether each hook entry is exactly the one this agent writes.
      // A workspace that does not read them ignores them.
      body: JSON.stringify({ signature, day, checks, hook_version: hookVersion(), agent_version: agentVersion, install_kind: installKind(), tools, mcp_servers, ...(hook_integrity ? { hook_integrity } : {}) }),
    });
    // A workspace that does not offer the self-check yet answers 404: the computer's own checks still count; the signed
    // workspace part is simply not available there.
    if (res.status === 404) { const failed = checks.filter((c) => !c.ok).map((c) => c.id); return { ok: failed.length === 0, signature_verified: false, failed, ...local, integrity_reported: false }; }
    if (!res.ok) return { ok: false, signature_verified: false, failed: [`workspace_http_${res.status}`], ...local, integrity_reported: false };
    const body = await res.json() as { ok?: boolean; signature_verified?: boolean; failed?: string[] };
    return { ok: !!body.ok, signature_verified: !!body.signature_verified, failed: Array.isArray(body.failed) ? body.failed : [], ...local, integrity_reported: true };
  } catch (error) {
    return { ok: false, signature_verified: false, failed: [`workspace_unreachable: ${(error as Error).message.slice(0, 80)}`], ...local, integrity_reported: false };
  }
}
