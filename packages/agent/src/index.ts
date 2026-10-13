export { runCycle, computerStatus, expectedHarnesses, missingHookEntries } from "./agent.js";
export type { CycleOptions, CycleResult } from "./agent.js";
export { startService, noteUpdateOutcome, repairHookEntries, spawnReplacement, handoverPlan, takeOver, acquireAgentLock, releaseAgentLock, lockHeldBy, waitForAgentVersion, HANDOVER_CONFIRM_MS, AGENT_LOCK, AGENT_VERSION, AFTER_PID_ENV, REFRESH_LAUNCHER_ENV, RESTART_EXIT_CODE, STOPPED_FILE } from "./service.js";
export type { Handover } from "./service.js";
export { writeOutputTo, FALLBACK_LOG } from "./log-file.js";
export type { Service, ServiceOptions, MaintenanceResult } from "./service.js";
export { appsEntryValues, uninstallScript, writeUninstallScript, writeAppsEntry, removeAppsEntry, npmBeside, psQuote, UNINSTALL_KEY, UNINSTALL_SCRIPT, UTF8_BOM } from "./apps-entry.js";
export { awakeSinceAtStart, readAwake, writeAwake, AWAKE_FILE } from "./awake.js";
export type { AwakeState } from "./awake.js";
export { runUpkeepApart, upkeepCommand, UPKEEP_BUDGET_MS, UPKEEP_TIMEOUT_MS } from "./upkeep.js";
export type { UpkeepReport, UpkeepApartOptions } from "./upkeep.js";
export { startControl, callAgent, readEndpoint, localSocketPath, AGENT_FILE, TOKEN_HEADER } from "./ipc.js";
export type { AgentEndpoint } from "./ipc.js";
export {
  launcherPath, windowsLauncher, posixLauncher, windowsRunCommand, macLaunchAgent, linuxUserUnit,
  enableAutostart, disableAutostart, autostartHealth, autostartPaths, startCommands, startNow, LABEL,
  AGENT_LOG_ENV, LAUNCHER_MARK, launcherIsCurrent, refreshLauncher, retireLauncherRunValue, TRAY_RUN_VALUE,
} from "./autostart.js";
export {
  agentVersion, fetchClientVersion, compareVersions, commandHookVersion, maintainedHookCommand, maintainHookEntries, installAgent, ownNpm,
  isVersion, npmInstallArgs, npmEnvironment, checkProvenance, startCheck, recordFailedUpdate, recentlyFailedUpdate, failedUpdate, updateTarget,
  NPM_REGISTRY, PROVENANCE_REPOSITORY, PROVENANCE_REF, CLIENT_VERSION_MAX_BYTES, FAILED_UPDATE_FILE, FAILED_UPDATE_RETRY_MS,
} from "./update.js";
export type { ClientVersion, ProvenanceResult } from "./update.js";
export { selfCheckProof, localChecks, runSelfCheck } from "./selfcheck.js";
export { parseQuestion, questionText, windowsScript, systemPrompter, serialized } from "./prompt.js";
export type { OverrideQuestion, OverrideAnswer, Prompter } from "./prompt.js";
export { queueReason, flushReasons, pendingReasons, REASONS_FILE } from "./override-reasons.js";
export type { SelfCheckItem, SelfCheckResult } from "./selfcheck.js";
export {
  discoverTools, toolLines, TOOL_IDS, TOOL_LABELS, NPM_PACKAGES, VERSION_PROGRAMS, MAX_TOOLS, MAX_MCP_SERVERS, MAX_MCP_NAME,
} from "./tools.js";
export type { ToolId, ToolReport, McpServerReport, ToolDiscovery, DiscoveryOptions } from "./tools.js";
export { setupPlan, agentOnThisComputer, globalBinDir, onPath, addToPathCommand, nodeSupported, runSetup } from "./setup.js";
export type { SetupState, SetupStep, SetupOptions } from "./setup.js";
export {
  installKind, updaterKeys, keyId, verifyManifest, fetchVerifiedInstaller, installerName, installerUnchanged, installerRecheckScript,
  windowsTool, installHelper, nativeTrayPath, takeInstallResult, INSTALLER_CHECK_SCRIPT, INSTALL_RESULT, MANIFEST_DOMAIN, PUBLISHER,
  updatesDir, msiLogPath, helperCopyPath, removeOldHelpers, UPDATE_HELPER_COMMAND, UPDATE_PENDING_FILE, UPDATE_PENDING_MS, writeUpdatePending, readUpdatePending, clearUpdatePending,
} from "./native-update.js";
export type { InstallKind, InstallResult, ReleaseManifest, UpdaterKey, VerifiedInstaller, HelperPlan } from "./native-update.js";
export { runUpdateHelper, helperInput, UPDATE_START_DEADLINE_MS } from "./update-helper.js";
export type { HelperInput, HelperDeps } from "./update-helper.js";
export { installedWorkspace, httpsOrigin, startFirstSignIn, DEFAULT_WORKSPACE, SETTINGS_KEYS, FIRST_SIGNIN_FILE } from "./signin.js";
export type { RegistryReader, FirstSignIn, FirstSignInOptions } from "./signin.js";
export { findNpmInstall, hasNpmInstall, migrateFromNpm, isNpmLauncher, readMigration, MIGRATED_FILE } from "./migrate.js";
export type { NpmInstall, MigrateDeps, Migration } from "./migrate.js";
export { useNativeHookEntries, hasForeignHookEntries, missingPrograms } from "./hook-entries.js";
export { agentCli, hookCli, setupCli } from "./commands.js";
export type { CommandContext } from "./commands.js";
