import { createHash } from "node:crypto";
import {
  ADAPTERS, ADAPTER_REGISTRY_VERSION, adapterPresent, adapterWithinProfile, configuredHookCommands, harnessEntryCommand,
  hookCommandResolves, hookVersion, integrationProfile, isScopebondHookCommand, readHarnessConfig, readIntegrationIntent, userHarnessFile, userHome, type Harness, type IntegrationProfile,
} from "@scopebond/hook";
import { executionEnvironment, type ExecutionEnvironment } from "./execution-environment.js";

export interface IntegrationHealth {
  harness: Harness;
  registry_version: number;
  presence: "detected" | "absent" | "unknown";
  integration: "not_configured" | "awaiting_trust" | "awaiting_restart" | "disabled" | "repair_failed";
  reason: "missing_entry" | "native_approval" | "runtime_not_observed" | "excluded" | "native_disabled" | "invalid_configuration" | "executable_missing" | "duplicate_entries" | "profile_boundary";
  entry: boolean;
  executable: boolean;
  duplicates: boolean;
  definition_revision: string | null;
  runtime: { state: "never_verified"; surfaces: readonly string[] };
  capabilities: { supported: readonly string[]; verified: readonly string[] };
  license: { state: "unknown"; scope: "legacy_computer" };
  delivery: "unknown";
  checked_at: number;
  scope: { profile: IntegrationProfile; execution: ExecutionEnvironment; coverage: "current_environment_only"; other_environments: "not_verified"; action: "install_on_execution_host" };
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function entries(value: unknown): number {
  if (!record(value) || value.enabled === false || value.disabled === true) return 0;
  if (Array.isArray(value.hooks)) return value.hooks.reduce((n: number, child: unknown) => n + entries(child), 0);
  return isScopebondHookCommand(harnessEntryCommand(value)) ? 1 : 0;
}

/** Configuration inspection only. No fixture, process, or successful write can create runtime proof. */
export function integrationHealth(harnesses: readonly Harness[], now = Date.now(), dir?: string): IntegrationHealth[] {
  const stateDir = dir ?? userHome();
  const intent = readIntegrationIntent(stateDir);
  const profile = integrationProfile(stateDir, {}, { create: dir !== undefined });
  const execution = executionEnvironment();
  return harnesses.map((harness) => {
    const adapter = ADAPTERS[harness];
    let presence: IntegrationHealth["presence"] = "unknown";
    let local = false;
    try { local = adapterWithinProfile(harness); if (local) presence = adapterPresent(harness) ? "detected" : "absent"; } catch { /* unreadable presence stays unknown */ }
    const health: IntegrationHealth = {
      harness, registry_version: ADAPTER_REGISTRY_VERSION, presence, integration: "not_configured", reason: "missing_entry",
      entry: false, executable: false, duplicates: false, definition_revision: null,
      runtime: { state: "never_verified", surfaces: adapter.surfaces },
      capabilities: { supported: adapter.capabilities, verified: [] },
      license: { state: "unknown", scope: "legacy_computer" }, delivery: "unknown", checked_at: now,
      scope: { profile, execution, coverage: "current_environment_only", other_environments: "not_verified", action: "install_on_execution_host" },
    };
    if (intent.excluded.includes(harness)) return { ...health, integration: "disabled", reason: "excluded" };
    if (!local || profile.state === "mismatch" || profile.state === "unknown") return { ...health, integration: "repair_failed", reason: "profile_boundary" };
    try {
      const file = userHarnessFile(harness);
      const config = readHarnessConfig(file);
      if (config.disableAllHooks === true || config.hooksEnabled === false) return { ...health, integration: "disabled", reason: "native_disabled" };
      const hooks = record(config.hooks) ? config.hooks : {};
      const counts = adapter.decisionEvents.map((event) => Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).reduce((n: number, value) => n + entries(value), 0) : 0);
      health.entry = counts.every((n) => n > 0);
      health.duplicates = counts.some((n) => n > 1);
      const commands = configuredHookCommands(file);
      health.executable = health.entry && commands.length > 0 && commands.every(hookCommandResolves);
      health.definition_revision = createHash("sha256").update(JSON.stringify({ hooks, version: hookVersion() })).digest("hex");
      if (!health.entry) return health;
      if (!health.executable) return { ...health, integration: "repair_failed", reason: "executable_missing" };
      if (health.duplicates) return { ...health, integration: "repair_failed", reason: "duplicate_entries" };
      return adapter.approval === "trust" ? { ...health, integration: "awaiting_trust", reason: "native_approval" } : { ...health, integration: "awaiting_restart", reason: "runtime_not_observed" };
    } catch { return { ...health, integration: "repair_failed", reason: "invalid_configuration" }; }
  });
}
