export { runCycle, computerStatus, expectedHarnesses, missingHookEntries } from "./agent.js";
export type { CycleOptions, CycleResult } from "./agent.js";
export { startService, repairHookEntries, spawnReplacement, handoverPlan, takeOver, acquireAgentLock, releaseAgentLock, AGENT_LOCK, AGENT_VERSION, AFTER_PID_ENV, REFRESH_LAUNCHER_ENV, RESTART_EXIT_CODE } from "./service.js";
export type { Handover } from "./service.js";
export { writeOutputTo, FALLBACK_LOG } from "./log-file.js";
export type { Service, ServiceOptions, MaintenanceResult } from "./service.js";
export { appsEntryValues, uninstallScript, writeAppsEntry, removeAppsEntry, npmBeside, UNINSTALL_KEY, UNINSTALL_SCRIPT } from "./apps-entry.js";
export { awakeSinceAtStart, readAwake, writeAwake, AWAKE_FILE } from "./awake.js";
export type { AwakeState } from "./awake.js";
export { runUpkeepApart, upkeepCommand, UPKEEP_BUDGET_MS, UPKEEP_TIMEOUT_MS } from "./upkeep.js";
export type { UpkeepReport, UpkeepApartOptions } from "./upkeep.js";
export { startControl, callAgent, readEndpoint, localSocketPath, AGENT_FILE, TOKEN_HEADER } from "./ipc.js";
export type { AgentEndpoint } from "./ipc.js";
export {
  launcherPath, windowsLauncher, posixLauncher, windowsRunCommand, macLaunchAgent, linuxUserUnit,
  enableAutostart, disableAutostart, autostartHealth, autostartPaths, startCommands, startNow, LABEL,
  AGENT_LOG_ENV, LAUNCHER_MARK, launcherIsCurrent, refreshLauncher,
} from "./autostart.js";
export {
  agentVersion, fetchClientVersion, compareVersions, commandHookVersion, maintainedHookCommand, maintainHookEntries, installAgent, ownNpm,
} from "./update.js";
export type { ClientVersion } from "./update.js";
export { selfCheckProof, localChecks, runSelfCheck } from "./selfcheck.js";
export { parseQuestion, questionText, windowsScript, systemPrompter, serialized } from "./prompt.js";
export type { OverrideQuestion, OverrideAnswer, Prompter } from "./prompt.js";
export { queueReason, flushReasons, pendingReasons, REASONS_FILE } from "./override-reasons.js";
export type { SelfCheckItem } from "./selfcheck.js";
export { setupPlan, globalBinDir, onPath, addToPathCommand, nodeSupported, runSetup } from "./setup.js";
export type { SetupState, SetupStep, SetupOptions } from "./setup.js";
export { installKind, updaterPublicKey, verifyManifest, fetchVerifiedInstaller, installerName, MANIFEST_DOMAIN, PUBLISHER } from "./native-update.js";
export type { InstallKind, ReleaseManifest } from "./native-update.js";
