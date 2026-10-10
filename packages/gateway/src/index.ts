export {
  createGateway, noopExecutor, DuplicateActionError, AuthorityUnavailableError,
  ReconciliationUnavailableError, ExecutorInputError,
} from "./app.js";
export type {
  Gateway, GatewayConfig, Executor, ExecutionResult, ExecutionQueryResult,
  ActionRequest, ActionResult, ObservationResult, OverrideHandler, ActionOptions,
} from "./app.js";
export { createHttpExecutor, createSupportRefundExecutor } from "./executors.js";
export type { HostLookup, HttpExecutorOptions, SupportRefundExecutorOptions } from "./executors.js";
export { evaluate } from "./engine.js";
export type { Decision } from "./engine.js";
export {
  MemoryReceiptStore, createAttester, attesterFromPrivateKeyPem, verifyReceipt,
  buildReceipt, canonical, sha256, intentHash, ed25519JwkToSpkiPem, deriveKid,
  minimizeIntentForEvidence, EVIDENCE_VERSION, REDACTION_PROFILE, EXECUTION_STATES,
  CANONICALIZATION, validateEvidencePayload, validateOverrideRecord,
  classifyEvidenceClass, EVIDENCE_CLASSES, BOUNDARY_GATES, buildBoundaryReceipt, buildPepReceipt,
} from "./receipts.js";
export type {
  ReceiptStore, SignedReceipt, ReceiptPayload, Attester, RealtimeResult, ReceiptVerification, Anchor,
  ExecutionState, ExecutionEvidence, PolicyReference, ActionReference, RedactionEvidence,
  AuthorityReservation, AuthorityFinalState, AuthorityReservationResult, ReceiptContext,
  AuthorityLifecycleState, ActionLifecycleRecord, StopState, PriorScope,
  EvidenceClass, BoundaryGate, AttributionKind, PepPrincipal, BoundaryEvidence, BoundaryReceiptInput, PepReceiptInput,
  OverrideRecord,
} from "./receipts.js";
export {
  AUTHORIZATION_VERSION, AuthorizationError, StaticPrincipalKeyRegistry,
  authenticateRequest, approvalClaims, intentAuthorizationClaims,
  validateAuthorizationEvidence, validateIntentAuthorization, validateSignedApproval,
  verifyAuthorizationEvidenceSignatures,
} from "./auth.js";
export type {
  AuthenticationConfig, AuthorizationEvidence, AuthorizationVerification, GatewayAuthentication, PrincipalKeyRecord,
  PrincipalKeyRegistry, PrincipalPurpose, SignatureIdentity, SignedApproval, SignedIntentAuthorization,
} from "./auth.js";
export { handleMcp } from "./mcp.js";
export {
  merkleRoot, merkleProof, verifyProof,
  ANCHOR_ALGO_V1, ANCHOR_ALGO_V2, ANCHOR_TYPE,
  leafHash, nodeHash, receiptLeafHash, receiptLeafHashV1, merkleTreeHash, merkleRootV1,
  inclusionProof, verifyInclusionProof, consistencyProof, verifyConsistencyProof,
  anchorBody, anchorHash, anchorRoot, verifyAnchorRoot, verifyAnchorSignature, verifyAnchorChain,
  isAnchorV2,
} from "./anchor.js";
export type {
  ProofStep, AnchorV1, AnchorV2, AnchorV2Body, AnyAnchor, InclusionProof, ConsistencyProof, AnchorChainResult, Ed25519PublicJwk,
} from "./anchor.js";

// Edge (Cloudflare Workers) support — WebCrypto attester + KV store. Edge-safe.
export { createWebCryptoAttester, generateAttesterJwk } from "./webcrypto.js";
export type { Ed25519Jwk } from "./webcrypto.js";
export { KvReceiptStore, loadOrCreateKvAttester, createWorkerGateway } from "./workers.js";
export type { KvLike } from "./workers.js";
export { createCloudExporter, createMemoryCloudOutbox, withCloudExporter, seqRanges, LOSSLESS_CLOUD_OUTBOX, DELIVERY_SEQUENCE_CONTEXT, deliverySequenceMaterial } from "./cloud.js";
export { scrubSecretText } from "./scrub.js";
export { completeCloudEnrollment, CloudEnrollmentError } from "./enrollment.js";
export type { CloudEnrollmentBundle, CloudEnrollmentResult } from "./enrollment.js";
export type {
  CloudBackoff, CloudDeliveryGap, CloudExporter, CloudExporterOptions, CloudExporterStatus,
  CloudOutbox, CloudOutboxEntry, CloudOutboxStatus, MemoryCloudOutboxOptions, CloudSummaryOptions, CloudSequenceProofOptions, ChainHeadDelivery,
} from "./cloud.js";
export {
  requestHash, requestParams, checkApproval, validateDispatchApproval, approvalClaims as dispatchApprovalClaims,
  scopeDigest, isSubScope, actionInScope, targetInScope, validateDelegation, budgetDigest, budgetAcknowledged,
  delegationScopeDigest, scopeEntryDigest, privilegeScopeEntry, actionScopeEntry, actionScopeEntries, SCOPE_ENTRY_KINDS, dispatchApprovalBinding, DELEGATION_SCOPE_DOMAIN, SCOPE_ENTRY_DOMAIN,
  validateBudgetPolicy, defaultBudgetTemplate, intentTarget, dispatchIntentOf, signDispatchApproval,
  REQUEST_HASH_DOMAIN, DISPATCH_APPROVAL_VERSION, APPROVAL_MAX_LIFETIME_MS, APPROVAL_MAX_SKEW_MS, MAX_DELEGATION_DEPTH,
} from "./dispatch.js";
export type {
  ScopeEntryKind, DispatchApproval, ApprovalRejection, ApprovalSubject, DelegatedScope, Delegation, DelegationProblem, ActionBudgetPolicy,
  BudgetMode, BudgetAuthority, DispatchIntent, DispatchRequest, DispatchReason, DispatchDecision, DispatchGuard, BudgetObservation,
} from "./dispatch.js";
export {
  createCloudDispatchSource, parseDelegationAnswer, CLOUD_CONSUME_PATH, CLOUD_DELEGATIONS_PATH, CLOUD_ACTIVE_APPROVAL_PATH, CLOUD_DISPATCH_SCOPE, CONSUME_REFUSALS, DELEGATION_STATES,
} from "./dispatch-cloud.js";
export type { CloudDispatchSource, CloudDelegation, CloudSourceOptions, ConsumeAnswer, ConsumeRefusal, ConsumeRequest, DelegationAnswer, ActiveApprovalQuery, ActiveApprovalAnswer } from "./dispatch-cloud.js";
export { historyNeed } from "@scopebond/verify";
export { buildSummary, isNotable, repeatKey } from "./summary.js";
// The shell secret scanner the gateway's scrubber uses; the hook's command scrubber and mapper use the same one.
export { isCredentialName, maskWords, pipedSecrets, scrubShellSecrets, type PipedSecret } from "./shell-secrets.js";
// Evidence-chain heads from a workspace's delivery answers and the published day lists (pure; @scopebond/verify/chain).
export { checkChainHeads, isSignedChainHead, verifyAnchorList, verifyChainHeadSignature, verifySegmentChain } from "@scopebond/verify/chain";
export type { AnchorList, AnchorListCheck, ChainHead, HeadTiming, HeadsCheck, KeptChainHead, SegmentChainCheck, SignedChainHead } from "@scopebond/verify/chain";
export type { SummaryOptions, SummaryPayload, SummaryRecord } from "./summary.js";
