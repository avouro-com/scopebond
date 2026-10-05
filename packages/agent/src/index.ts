export { runCycle, computerStatus, expectedHarnesses, missingHookEntries } from "./agent.js";
export type { CycleOptions, CycleResult } from "./agent.js";
export { startService, repairHookEntries, spawnReplacement, AGENT_VERSION, AFTER_PID_ENV } from "./service.js";
export type { Service, ServiceOptions, MaintenanceResult } from "./service.js";
export { startControl, callAgent, readEndpoint, AGENT_FILE, TOKEN_HEADER } from "./ipc.js";
export type { AgentEndpoint } from "./ipc.js";
export {
  launcherPath, windowsLauncher, posixLauncher, windowsRunCommand, macLaunchAgent, linuxUserUnit,
  enableAutostart, disableAutostart, autostartHealth, autostartPaths, LABEL,
} from "./autostart.js";
export {
  agentVersion, fetchClientVersion, compareVersions, commandHookVersion, maintainedHookCommand, maintainHookEntries, installAgent,
} from "./update.js";
export type { ClientVersion } from "./update.js";
export { selfCheckProof, localChecks, runSelfCheck } from "./selfcheck.js";
export type { SelfCheckItem } from "./selfcheck.js";
