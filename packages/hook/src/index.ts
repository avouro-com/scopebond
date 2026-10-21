// @scopebond/hook — the Claude Code, Cursor, Codex + GitHub Copilot connector. The library surface is
// the deterministic mapper and the check-only runtime; the `scopebond-hook`
// binary is the thin harness adapter over them.

export { mapClaudeToolUse, mapCodexToolUse, mapCopilotToolUse, mapCopilotCall, copilotAsClaude, normalizeCopilotInput, mapCursorEvent, fillPushBranch, DERIVED_CAP } from "./map.js";
export { upstreamBranch } from "./git-upstream.js";
export {
  copilotAnswer, copilotCloudAgent, copilotSurface, surfaceSignals, readCopilotProbe, openCopilotProbe, recordCopilotProbe, renderCopilotProbe,
  COPILOT_CLOUD_ASK_IS_DENY, DOCUMENTED_COPILOT_TOOL_NAMES, COPILOT_PROBE_FILE, COPILOT_PROBE_WINDOW_MS,
  type CopilotSurface, type CopilotAnswer, type CopilotProbe, type ProbeEntry,
} from "./copilot-surface.js";
export type { Mapped, NormalizedIntent, ShownCommand } from "./map.js";
export { createHookRuntime, starterPolicy, upgradeStarterPolicy, namedActionTypes, policyOptsIntoTargets, TARGET_RULES, TARGET_OPT_IN_TYPES } from "./runtime.js";
export type { TargetRule } from "./runtime.js";
// The shell reader every derivation starts from: a command line as the simple commands it runs.
export { decomposeShell } from "./shell.js";
// The tool a command runs, directly or through a package runner (launchers.ts).
export { launched, toolNames } from "./launchers.js";
export type { SimpleCommand } from "./shell.js";
// What a delete reaches: the safe-shell rule lets a delete through when every target is inside the working folder.
export { DELETE_PROGRAMS, BUILD_OUTPUT, CONTAINED_SUFFIX, RESTORABLE_SUFFIX, isContainedDelete, isRestorableDelete, withRestorableScope } from "./delete-scope.js";
export { gitRestorable, repositoryTop, realEnginePath, GIT_RESTORE_TIMEOUT_MS, GIT_RESTORE_MAX_TARGETS, type GitRun } from "./git-restore.js";
export type { DeleteScope, DeleteVerdict } from "./delete-scope.js";
// Rule packs: the interpreter (packs.ts), their rules in the policy in force (pack-rules.ts) and the cache of signed packs on
// this computer (pack-store.ts). Every vendor command-line tool and MCP server is read through them.
export { setActivePacks, shadowPackIds, activePackRefs, activePacks, derivePackTargets, derivePackMcp, deriveFromGrammar, deriveFromProfile, runPackVectors, packDigest } from "./packs.js";
export type { PackAction, PackProbe, VectorFailure } from "./packs.js";
export { packRuleClauses, switchablePackRules, withPackRules, packRuleOf, packRuleSaferWay } from "./pack-rules.js";
export type { PackRuleSettings, PackRuleMode } from "./pack-rules.js";
export {
  activatePacks, loadPacks, installPack, removePack, verifyPackSignature, verifySignedData, checkPackText, readPackIndex, writePackIndex, packCheckedAt, packsDir, PACKS_DIR, PACK_INDEX_FILE, PACK_TTL_MS,
  packEngineLevel, readPackFlags, writePackFlags, packSidecarDir, packFallbackFile, PACK_ENGINE_ENV, PACK_SIDECAR_DIR, PACK_FLAGS_FILE,
} from "./pack-store.js";
export type { PackIndex, PackIndexEntry, LoadedPacks, PackRefusal, PackCheckOptions, PackFlags } from "./pack-store.js";
export {
  checkTaxonomyExtText, activateTaxonomyExtension, installTaxonomyExtension, removeTaxonomyExtension, heldTaxonomyDigest, setTaxonomyExtension, TAXONOMY_EXT_FILE,
} from "./pack-taxonomy.js";
export { targetOptInTypes, setExtensionOptInTypes } from "./target-rules.js";
// Pack delivery: the signed list a workspace answer names, and the cache brought in step with it on each rules check.
export { syncPacks, restampPacks, describePackSync, packRefsOf, taxonomyRefOf, killedOf, packsHeaderValue, MAX_PACK_REFS, PACK_ENGINE_HEADER, PACKS_HEADER } from "./pack-sync.js";
// Safe Install: verdicts on detected installs from the workspace, and the signed block list used offline.
export {
  checkInstalls, checkable, checkBlocklistText, loadBlocklist, safeInstallOn, syncInstallBlocklist, removeBlocklist, comparableName,
  INSTALL_BLOCKLIST_FILE, INSTALL_STATE_FILE, INSTALL_VERDICTS_FILE, BLOCKLIST_FORMAT, SAFE_INSTALL_HEADER, BLOCKLIST_TTL_MS, BLOCKLIST_CHECK_MS, VERDICT_TIMEOUT_MS, AGE_GATE_MS,
} from "./install-verdicts.js";
export type { InstallVerdict, VerdictReason, VerdictSource, InstallCheck, CheckOptions, BlocklistSyncOptions, BlocklistSyncResult } from "./install-verdicts.js";
export type { PackSyncOptions, PackSyncResult, PackSyncFailure, PackRef } from "./pack-sync.js";
export type { RuntimeConfig, Decision } from "./runtime.js";
export {
  compile, defaultRules, describeRules, loadRules, saveRules, rulesPath, pathRuleFor, RULES_FILE, ENFORCEABLE_RULES, SWITCHABLE_RULES,
} from "./rules.js";
export type { RuleSet, PathRule } from "./rules.js";
export { pathRuleMatches, isDestructiveProgram, isProtectedBranch } from "./rules.js";
export { DESTRUCTIVE_FORMS, destructiveForm } from "./destructive-forms.js";
export { EXCEPTION_FIELDS, EXCEPTIONS_CAPABILITY, MAX_EXCEPTIONS, validRuleExceptions, localDatabaseUrl, type RuleException, type ExceptionField } from "./rule-exceptions.js";
export { classifyIntent, classificationBlocks, BLOCKING, MONITORED_HIGH } from "./classify.js";
export type { CatalogId, Classification } from "./classify.js";
export { classifyRoot, applyRootScope } from "./paths.js";
export type { RootScope, RootOptions } from "./paths.js";
export { actionGroupId, withActionGroup, distinctTargets, ACTION_GROUP_PARAM, ACTION_GROUP_SIZE_PARAM, ACTION_GROUP_SEQ_PARAM } from "./group.js";
export { computeManifest, renderManifest, cellState, cellKey, vectorsForCell, vectorDigest, HOST_ENFORCEMENT } from "./capabilities.js";
export type { Manifest, CapabilityCell, CapabilityState, ProofRecord, HostVariant, EventPhase, ManifestInput } from "./capabilities.js";
export { runProofFixtures, deliverProofReceipts, loadProofs, saveProofs, PROOF_FILE } from "./proof.js";
export { inspectBudgetExport, loadBudgetExport, localBudgetOf, BUDGET_EXPORT_TYPE } from "./budget-load.js";
export { inspectExport, loadPolicyExport, policyScopeDigest, policyBuilds, POLICY_SCOPE_DOMAIN, LOADED_POLICY_FILE } from "./policy-load.js";
export {
  inspectManaged, compileManaged, managedEnforce, enforcedRuleIds, installManaged, restoreLocal, isManaged, readMeta, digestRules, digestManaged, ruleReport,
  MANAGED_RULE_IDS, OPTIONAL_RULE_IDS, NEVER_OFF_RULE_IDS, MANAGED_DOC_FILE, MANAGED_META_FILE, RULE_OF_CLAUSE, floorDocument, writeAtomic,
  offRuleIds, packRuleAdjustments, packRuleAdjustmentsAt, packRulesOf, managedSetting,
  inspectToolSettings, digestToolSettings, toolSettingsMark, TOOL_SETTINGS_TYPE, TOOL_SETTINGS_HARNESSES, TOOL_SETTINGS_LISTS, MCP_SERVER_NAME,
  MAX_TOOL_SETTINGS_ENTRIES, MAX_TOOL_SETTINGS_ENTRY, ANSWER_LENGTHS,
} from "./managed.js";
export { ruleSummary } from "./rule-summary.js";
export type { RuleSummary } from "./rule-summary.js";
export type {
  ManagedDocument, ManagedRule, ManagedMeta, RefusalReason, OverrideTerms, AnswerLength, AnyManagedRuleId, OptionalRuleId,
  ToolSettingsSection, ToolSettingsHarness, ToolSettingsList, HarnessToolSettings, ToolSettingsInspection,
} from "./managed.js";
export { createOverrideHandler, overrideHint, overrideRemedy, askAgent, actionSummary, digestOf, PROMPTING_MODES, OVERRIDE_STATE_FILE, blockedQuestion, actOnBlocked, plainAction, offersFor, allowsAny, offeredLength } from "./override.js";
export { ruleTitle, ruleName, blockTitle, packRuleTitle, checkOfCode, GENERIC_RULE_TITLE } from "./rule-titles.js";
export { installVerdictWords, noteBlock, projectOf, readBlockNotes, BLOCK_NOTES_FILE } from "./block-notes.js";
export type { BlockNote } from "./block-notes.js";
export type { OverrideContext, OverrideNote, AgentAnswer, BlockedQuestion, Offers, UnblockLength } from "./override.js";
export { syncPolicy, syncIfDue, SYNC_INTERVAL_MS, INLINE_BUDGET_MS, MAX_TOOL_SETTINGS_REPORT, HOOK_CAPABILITIES, hookCapabilities } from "./policy-sync.js";
export {
  validBlockedService, validBlockedServices, blockedServiceClauses, servicePattern, serviceMatches, blockedServiceKindOf, blockedServiceOf,
  BLOCKED_SERVICE_KINDS, BLOCKED_SERVICE_CLAUSES, BLOCKED_SERVICE_LABEL, BLOCKED_SERVICE_REASON, SERVICE_RULES_CAPABILITY, MAX_BLOCKED_SERVICES, MAX_BLOCKED_SERVICE_KEY,
} from "./service-rules.js";
export type { BlockedService, BlockedServiceKind } from "./service-rules.js";
export { checkPolicySignature, checkToolSettingsSignature, checkPacksSignature, digestPacks, checkGrantsSignature, checkAnswerSignature, digestGrants, carriesGrants, GRANT_FIELDS, workspaceIdOf, signedPolicyBytes, signatureMode, publicKeyFrom, readSignatureState, SIGNATURE_MODE_ENV, type SignatureMode, type SignatureReason, type SignatureState, type SignedPolicyPayload, type ToolSettingsSignatureContext } from "./policy-signature.js";
export { policyKeys, basePolicyKeys, setPinnedNextKeys, policyKeyProblems, PINNED_POLICY_KEYS, POLICY_KEYS_ENV, type PolicyKey } from "./policy-keys.js";
export { recordFatigue, readFatigue, fatigueHeaderValue, localDay, FATIGUE_FILE, FATIGUE_HEADER, type FatigueKind, type FatigueCounts } from "./fatigue.js";
export { checkNextKey, pinNextKey, readNextKey, useNextKey, signatureModeAt, nextKeySigningInput, NEXT_KEY_FORMAT, NEXT_KEY_SIGNATURE_DOMAIN, NEXT_KEY_FILE, type NextKeyDocument } from "./policy-next-key.js";
export {
  loadIntelPlugin, intelComponentState, checkIntelComponent, readIntelManifest, pluginFrom, importVerifiedModule, intelDir, intelCurrentDir,
  INTEL_COMPONENT_DOMAIN, INTEL_BUDGET_MS, INTEL_MODULE, INTEL_MANIFEST, INTEL_MAX_BYTES,
  type IntelPlugin, type IntelManifest, type IntelAction, type IntelMembers, type IntelCheck,
} from "./intel-plugin.js";
export {
  engineToRun, readCurrentEngine, writeCurrentEngine, engineStartFailures, recordEngineStartFailure, checkStagedEngine, verifyEngineManifest, compileEngine,
  engineHome, engineDir, engineVersionDir, engineKeysFrom, engineStaged, isEngineVersion, compareEngineVersions,
  ENGINE_MANIFEST_DOMAIN, ENGINE_FILE, ENGINE_MANIFEST, ENGINE_SIGNATURE, ENGINE_CURRENT, ENGINE_START_FAILURES, ENGINE_CANDIDATE_ENV, MAX_ENGINE_START_FAILURES, ENGINE_MAX_BYTES,
  type EngineKey, type EngineManifest, type CurrentEngine, type StagedEngine, type LoadedEngine,
} from "./engine-shim.js";
export { versionedFetch, withHookVersion, HOOK_VERSION_HEADER } from "./workspace-fetch.js";
export {
  receiptContextFor, receiptContextAllowed, receiptContextFrom, noteReceiptContext, canonicalRepository, repositoryFacts,
  clearRepositoryFacts, harnessModel, harnessVersion, RECEIPT_CONTEXT_HEADER,
} from "./receipt-context.js";
export type { ContextInput } from "./receipt-context.js";
export type { SyncOutcome, SyncOptions } from "./policy-sync.js";
export { VECTORS, mapVector } from "./vectors.js";
export type { Vector, VectorAgent, Dialect } from "./vectors.js";
export { scaffold, harnessSnippet, installHarness, placeHook, coverWithoutNpx, installRepositoryHooks, REPO_HARNESSES, REPO_HOOK_MARKER, repositoryHookCommand } from "./init.js";
export type { HookPlacement, RepoHookFile } from "./init.js";
export {
  enrollRepository, repositoryConnectionDir, repositoryToken, tokenFingerprint, repositoryWorkspaceUrl, repositoryEnrollmentProof, isRepositoryConnection,
  RepositoryEnrollmentError, REPO_TOKEN_ENV, WORKSPACE_URL_ENV, DEFAULT_WORKSPACE_URL,
} from "./repo-enrol.js";
export {
  userHome, userHarnessFile, projectHarnessFile, resolveConfigDir, writeHarnessConfig, removeHarnessConfig,
  cursorDetected, codexDetected, copilotDetected, copilotHome, harnessDetected, absoluteHookCommand, nativeHookCommand, isHarnessConfigured, purgeHome,
  HARNESSES, COPILOT_EVENTS, COPILOT_HOOK_FILE, COPILOT_TIMEOUT_SEC, COPILOT_DECISION_DEADLINE_MS, copilotHookEntry, powershellHookCommand, harnessEntryCommand,
  readHarnessConfig, backupHarnessConfig, trustProjectPolicy, isTrustedProject, untrustedProjectPolicy, decisionStateDir, trustedProjectsFile, canonicalPath, samePath,
  harnessScopes, harnessScopeLabel, configuredHookCommands, hookCommandResolves,
  isScopebondHookCommand, harnessEntryMatches, harnessHookIsOurs, isQuotedWindowsHookCommand, quotedEntryNote, refuseUnsafeQuotedPaths, nativeHookProgram, missingHookPrograms, npxAvailable, isNpxHookCommand,
  codexHookEntry, codexWindowsCommand, shellPlainWindowsPath, windowsHookCommandLine, windowsShortPath, type ShortPathFinder,
  localHarnessFile, isMachineSpecificCommand, gitShareState, excludeFromGit, pruneHarnessEntries,
} from "./install.js";
export type { Harness, HarnessScopes, GitShare } from "./install.js";
export { explainDeny, describeAction, findClause, FINAL_INSTRUCTION } from "./explain.js";
export type { ExplainDenyInput, ExplainIntent, ExplainPolicy, ExplainClause } from "./explain.js";
export {
  ensureDurableRuntime, isEphemeralPath, nodeModulesRootOf, runtimeRoot, runtimeDirFor, pinnedCliPath,
} from "./runtime-install.js";
export type { PinResult } from "./runtime-install.js";
export { connectCloud, ingestUrl, loadConnection, attachExporter, sequenceProofFor, flushBounded, connectionPath, reportUninstall, uninstallReportLine, UNINSTALL_NOT_TOLD_EXIT, UNINSTALL_CALLER_ENV } from "./cloud.js";
export { checkChains } from "./chain-verify.js";
export { machineIdFor, machineIdField, approvedWorkspaceId, MACHINE_ID_FILE } from "./machine-id.js";
export type { ChainCheckOptions, ChainCheckReport } from "./chain-verify.js";
export type { HookConnection, UninstallReport } from "./cloud.js";
export { scrubSecrets, scrubParam, scrubUrlPath, redactCommand, digest, sha256, keyedDigest, useDigestKey, loadOrCreateDigestKey } from "./minimize.js";
export {
  AGENT_KINDS, assertAgentKind, observationSigner, signObservation, observationHash, sourceReceiptHash, signingBytes,
  buildPayload, buildOperation, operationsForCall, bindingKeyFromHex, loadOrCreateBindingKey, digestPolicy,
  REQUEST_BINDING_DOMAIN, MAX_OBSERVATION_BYTES, MAX_BATCH_ITEMS, MAX_BATCH_BODY_BYTES,
} from "./observation.js";
export type { ObservationPayload, SignedObservation, ObservationSigner, BindingKey, AgentKind } from "./observation.js";
export { ObservationStore, OBSERVATION_DB } from "./obs-store.js";
export { uploadPending, parseRetryAfter, OBSERVATIONS_PATH } from "./obs-upload.js";
export { openObservations, observationStatus, describeObservations, ObservationEmitter, OBSERVATIONS_SCOPE } from "./obs-emitter.js";
export { wireLifecycleHooks, unwireLifecycleHooks } from "./install.js";
export {
  deriveTypedOperations, keyedIdFor, callRequestOf, TYPED_ACTION_TYPES, fixtureProbe, gitPushOperation, githubOperation, packageOperation, parseGh, parseGithubMcp, normalizeRemote, systemGit, UNBOUND,
} from "./typed-ops.js";
export type { CallRequest, GitProbe, TypedContext, GithubRepo, GithubRequest, DeriveInput } from "./typed-ops.js";
export { deriveInfraOperation, databaseFacts, databaseGuardActions, parseDestination, fetchOperation, systemFiles, fixtureFiles } from "./typed-infra.js";
export type { FileProbe, InfraContext, ReadContext, DatabaseFacts, DatabaseGuardAction } from "./typed-infra.js";
export { classifySql } from "./sql-classify.js";
export type { SqlClass, SqlVerb } from "./sql-classify.js";
// Delivery, status and identity pieces the Scopebond Agent reuses (one implementation, one contract).
export { readDeliveryState, writeDeliveryState, recordDeliveryAttempt, recordRulesCredential, deliveryBackoff, waitingUntil, DELIVERY_STATE_FILE } from "./delivery-state.js";
export type { DeliveryState } from "./delivery-state.js";
export { clockTime, describeDelivery, flushOutcome, queueStatus, LOSSLESS_OUTBOX, OUTBOX_FILE } from "./delivery-report.js";
export type { FlushOutcome } from "./delivery-report.js";
export {
  repairDelivery, repairDeliveryAt, backfillQueue, settleInterruptedActions, noteQueueMiss, BACKFILL_FILE, INTERRUPTED_AFTER_MS, INTERRUPTED_REFERENCE,
} from "./delivery-repair.js";
export { buildStatusJson, STATUS_SCHEMA } from "./status-json.js";
export type { StatusJson } from "./status-json.js";
export { refreshIfDue, refreshProof, REFRESH_WINDOW_MS } from "./credential-refresh.js";
export { hookVersion, hookCommand, cliCommand } from "./version.js";
export { decisionEntries, enabledPluginHookFiles, hookEntries, duplicateHooks, dedupeHooks, describeEntry } from "./duplicates.js";
export type { HookEntry, HookScope } from "./duplicates.js";
export { agentCommand, npmGlobalInstall, nodeTooOldLines, loginAgainCommand, executionPolicyAdvice, explainPowerShellError, unreachableHint, retryCommand } from "./windows-hints.js";
export { readAllowances, writeAllowances, makeAllowance, matchAllowance, matchQuietBlock, makeQuietBlock, QUIET_BLOCK_DAYS, mergeWorkspaceAllowances, readBlocked, recordBlocked, markBlocked, ALLOWANCES_FILE, BLOCKED_FILE, ALLOWANCE_DEFAULT_DAYS, readActionText, rememberActionText, ACTION_TEXT_FILE, endAllowance, matchPatternAllowance, patternCovers, patternKey } from "./allowances.js";
export type { Allowance, BlockedItem, PatternQuery } from "./allowances.js";
export { similarFor, patternSetting, packRecipesFor, rulePatternable } from "./pattern-recipes.js";
export type { SimilarOffer, SimilarProposal, PatternSetting, RecipeContext } from "./pattern-recipes.js";
export { sessionBudgetGuard, sessionBudgetGuardFor, keyedSessionId, readSessionBudgets, validSessionBudget, validSessionBudgets, isPackageInstall, isAgentLaunch, SESSION_BUDGETS_FILE } from "./session-budgets.js";
export type { SessionBudget, SessionBudgetLimit, SessionBudgetGuard, BudgetReservation, BudgetIntent } from "./session-budgets.js";
export { readRequests, writeRequests, queueRequest, REQUESTS_FILE } from "./requests.js";
export type { AdminRequest } from "./requests.js";
export { foldRetries, localActivity, RECENT_BLOCKS_LIMIT, RETRY_WINDOW_MS } from "./local-activity.js";
export { noteUnresolvableHooks, HOOK_OUTAGE_FILE } from "./hook-outage.js";
export type { LocalActivity, RecentBlockRecord } from "./local-activity.js";
export { runStoreUpkeep, upkeepIfDue, localRetentionDays, retentionDaysFrom, DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS } from "./store-upkeep.js";
export type { UpkeepOptions } from "./store-upkeep.js";
export { evidenceDetail, evidenceDetailFrom, summaryOptions } from "./evidence-detail.js";
export type { EvidenceDetail } from "./evidence-detail.js";
export { isSingleExecutable, hookCliPath, hookSelfCommand, nodeSqlite } from "./self.js";
export { requestOverSocket } from "./local-socket.js";
export { onboardingSteps } from "./onboarding.js";
export { homeFolders, maskHomeFolder, maskHomeInValue, maskHomeInPattern, maskHomeInPolicy } from "./home-mask.js";
export { computerName, clientNameField, hashedHostname, hostnameMode, HOSTNAME_MODE_ENV } from "./computer-name.js";
export type { HostnameMode } from "./computer-name.js";
