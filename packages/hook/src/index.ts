// @scopebond/hook — the Claude Code, Cursor, Codex + GitHub Copilot connector. The library surface is
// the deterministic mapper and the check-only runtime; the `scopebond-hook`
// binary is the thin harness adapter over them.

export { mapClaudeToolUse, mapCodexToolUse, mapCopilotToolUse, mapCopilotCall, copilotAsClaude, normalizeCopilotInput, mapCursorEvent, fillPushBranch, DERIVED_CAP } from "./map.js";
export type { Mapped, NormalizedIntent } from "./map.js";
export { createHookRuntime, starterPolicy, upgradeStarterPolicy, namedActionTypes, targetRuleClauses, policyOptsIntoTargets, TARGET_RULES, OBSERVED_TARGET_TYPES, TARGET_OPT_IN_TYPES } from "./runtime.js";
export type { TargetRule } from "./runtime.js";
export { deriveTargetOperations, toolOf, envOfName, targetDigest, TARGET_TOOLS } from "./typed-targets.js";
export type { TargetOperation, TargetProbe } from "./typed-targets.js";
export { deriveMcpOperations, mcpProfileOf } from "./mcp-profiles.js";
export type { RuntimeConfig, Decision } from "./runtime.js";
export {
  compile, defaultRules, describeRules, loadRules, saveRules, rulesPath, pathRuleFor, RULES_FILE, ENFORCEABLE_RULES, SWITCHABLE_RULES,
} from "./rules.js";
export type { RuleSet, PathRule } from "./rules.js";
export { pathRuleMatches, isDestructiveProgram, isProtectedBranch } from "./rules.js";
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
  inspectManaged, compileManaged, installManaged, restoreLocal, isManaged, readMeta, digestRules, ruleReport,
  MANAGED_RULE_IDS, OPTIONAL_RULE_IDS, MANAGED_DOC_FILE, MANAGED_META_FILE, RULE_OF_CLAUSE, floorDocument,
} from "./managed.js";
export type { ManagedDocument, ManagedRule, ManagedMeta, RefusalReason, OverrideTerms, AnyManagedRuleId, OptionalRuleId } from "./managed.js";
export { createOverrideHandler, overrideHint, askAgent, actionSummary, digestOf, PROMPTING_MODES, OVERRIDE_STATE_FILE, blockedQuestion, actOnBlocked } from "./override.js";
export type { OverrideContext, OverrideNote, AgentAnswer, BlockedQuestion } from "./override.js";
export { syncPolicy, syncIfDue, SYNC_INTERVAL_MS, INLINE_BUDGET_MS } from "./policy-sync.js";
export { checkPolicySignature, signedPolicyBytes, signatureMode, publicKeyFrom, readSignatureState, SIGNATURE_MODE_ENV, type SignatureMode, type SignatureReason, type SignatureState, type SignedPolicyPayload } from "./policy-signature.js";
export { policyKeys, policyKeyProblems, PINNED_POLICY_KEYS, POLICY_KEYS_ENV, type PolicyKey } from "./policy-keys.js";
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
  readHarnessConfig, trustProjectPolicy, isTrustedProject, untrustedProjectPolicy, trustedProjectsFile, canonicalPath, samePath,
  harnessScopes, harnessScopeLabel, configuredHookCommands, hookCommandResolves,
  isScopebondHookCommand, harnessEntryMatches, nativeHookProgram, missingHookPrograms, npxAvailable, isNpxHookCommand,
  localHarnessFile, isMachineSpecificCommand, gitShareState, excludeFromGit, pruneHarnessEntries,
} from "./install.js";
export type { Harness, HarnessScopes, GitShare } from "./install.js";
export { explainDeny, describeAction, findClause } from "./explain.js";
export type { ExplainDenyInput, ExplainIntent, ExplainPolicy, ExplainClause } from "./explain.js";
export {
  ensureDurableRuntime, isEphemeralPath, nodeModulesRootOf, runtimeRoot, runtimeDirFor, pinnedCliPath,
} from "./runtime-install.js";
export type { PinResult } from "./runtime-install.js";
export { connectCloud, ingestUrl, loadConnection, attachExporter, sequenceProofFor, flushBounded, connectionPath, reportUninstall } from "./cloud.js";
export { checkChains } from "./chain-verify.js";
export type { ChainCheckOptions, ChainCheckReport } from "./chain-verify.js";
export type { HookConnection } from "./cloud.js";
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
export { describeDelivery, queueStatus, LOSSLESS_OUTBOX, OUTBOX_FILE } from "./delivery-report.js";
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
export { readAllowances, writeAllowances, makeAllowance, matchAllowance, mergeWorkspaceAllowances, readBlocked, recordBlocked, markBlocked, ALLOWANCES_FILE, BLOCKED_FILE, ALLOWANCE_DEFAULT_DAYS } from "./allowances.js";
export type { Allowance, BlockedItem } from "./allowances.js";
export { sessionBudgetGuard, sessionBudgetGuardFor, keyedSessionId, readSessionBudgets, validSessionBudget, validSessionBudgets, SESSION_BUDGETS_FILE } from "./session-budgets.js";
export type { SessionBudget, SessionBudgetLimit, SessionBudgetGuard, BudgetReservation } from "./session-budgets.js";
export { readRequests, writeRequests, queueRequest, REQUESTS_FILE } from "./requests.js";
export type { AdminRequest } from "./requests.js";
export { localActivity } from "./local-activity.js";
export { noteUnresolvableHooks, HOOK_OUTAGE_FILE } from "./hook-outage.js";
export type { LocalActivity } from "./local-activity.js";
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
