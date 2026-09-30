// @scopebond/hook — the Claude Code, Cursor + Codex connector. The library surface is
// the deterministic mapper and the check-only runtime; the `scopebond-hook`
// binary is the thin harness adapter over them.

export { mapClaudeToolUse, mapCodexToolUse, mapCursorEvent, fillPushBranch } from "./map.js";
export type { Mapped, NormalizedIntent } from "./map.js";
export { createHookRuntime, starterPolicy, upgradeStarterPolicy } from "./runtime.js";
export type { RuntimeConfig, Decision } from "./runtime.js";
export {
  compile, defaultRules, describeRules, loadRules, saveRules, rulesPath, pathRuleFor, RULES_FILE,
} from "./rules.js";
export type { RuleSet, PathRule } from "./rules.js";
export { pathRuleMatches, isDestructiveProgram, isProtectedBranch } from "./rules.js";
export { classifyIntent, classificationBlocks, BLOCKING } from "./classify.js";
export type { CatalogId, Classification } from "./classify.js";
export { classifyRoot, applyRootScope } from "./paths.js";
export type { RootScope, RootOptions } from "./paths.js";
export { actionGroupId, withActionGroup, distinctTargets, ACTION_GROUP_PARAM, ACTION_GROUP_SIZE_PARAM, ACTION_GROUP_SEQ_PARAM } from "./group.js";
export { computeManifest, renderManifest, cellState, cellKey, vectorsForCell, vectorDigest } from "./capabilities.js";
export type { Manifest, CapabilityCell, CapabilityState, ProofRecord, HostVariant, EventPhase, ManifestInput } from "./capabilities.js";
export { runProofFixtures, deliverProofReceipts, loadProofs, saveProofs, PROOF_FILE } from "./proof.js";
export { inspectBudgetExport, loadBudgetExport, localBudgetOf, BUDGET_EXPORT_TYPE } from "./budget-load.js";
export { inspectExport, loadPolicyExport, policyScopeDigest, policyBuilds, POLICY_SCOPE_DOMAIN, LOADED_POLICY_FILE } from "./policy-load.js";
export { VECTORS, mapVector } from "./vectors.js";
export type { Vector, VectorAgent, Dialect } from "./vectors.js";
export { scaffold, harnessSnippet, installHarness, placeHook } from "./init.js";
export type { HookPlacement } from "./init.js";
export {
  userHome, userHarnessFile, projectHarnessFile, resolveConfigDir, writeHarnessConfig, removeHarnessConfig,
  cursorDetected, codexDetected, absoluteHookCommand, isHarnessConfigured, purgeHome,
  readHarnessConfig, trustProjectPolicy, isTrustedProject, untrustedProjectPolicy, trustedProjectsFile,
  harnessScopes, harnessScopeLabel, configuredHookCommands, hookCommandResolves,
  isScopebondHookCommand, harnessEntryMatches,
  localHarnessFile, isMachineSpecificCommand, gitShareState, excludeFromGit, pruneHarnessEntries,
} from "./install.js";
export type { Harness, HarnessScopes, GitShare } from "./install.js";
export { explainDeny, describeAction, findClause } from "./explain.js";
export type { ExplainDenyInput, ExplainIntent, ExplainPolicy, ExplainClause } from "./explain.js";
export {
  ensureDurableRuntime, isEphemeralPath, nodeModulesRootOf, runtimeRoot, runtimeDirFor, pinnedCliPath,
} from "./runtime-install.js";
export type { PinResult } from "./runtime-install.js";
export { connectCloud, loadConnection, attachExporter, flushBounded, connectionPath } from "./cloud.js";
export type { HookConnection } from "./cloud.js";
export { scrubSecrets, scrubParam, redactCommand, digest, sha256, keyedDigest, useDigestKey, loadOrCreateDigestKey } from "./minimize.js";
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
