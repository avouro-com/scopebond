export {
  createGateway, noopExecutor, DuplicateActionError, AuthorityUnavailableError,
  ReconciliationUnavailableError, ExecutorInputError,
} from "./app.js";
export type {
  Gateway, GatewayConfig, Executor, ExecutionResult, ExecutionQueryResult,
  ActionRequest, ActionResult, ObservationResult,
} from "./app.js";
export { createHttpExecutor, createSupportRefundExecutor } from "./executors.js";
export type { HttpExecutorOptions, SupportRefundExecutorOptions } from "./executors.js";
export { evaluate } from "./engine.js";
export type { Decision } from "./engine.js";
export {
  MemoryReceiptStore, createAttester, attesterFromPrivateKeyPem, verifyReceipt,
  buildReceipt, canonical, sha256, intentHash, ed25519JwkToSpkiPem, deriveKid,
  minimizeIntentForEvidence, EVIDENCE_VERSION, REDACTION_PROFILE, EXECUTION_STATES,
  CANONICALIZATION, validateEvidencePayload,
  classifyEvidenceClass, EVIDENCE_CLASSES, BOUNDARY_GATES, buildBoundaryReceipt, buildPepReceipt,
} from "./receipts.js";
export type {
  ReceiptStore, SignedReceipt, ReceiptPayload, Attester, RealtimeResult, ReceiptVerification, Anchor,
  ExecutionState, ExecutionEvidence, PolicyReference, ActionReference, RedactionEvidence,
  AuthorityReservation, AuthorityFinalState, AuthorityReservationResult, ReceiptContext,
  AuthorityLifecycleState, ActionLifecycleRecord, StopState,
  EvidenceClass, BoundaryGate, AttributionKind, PepPrincipal, BoundaryEvidence, BoundaryReceiptInput, PepReceiptInput,
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
export { merkleRoot, merkleProof, verifyProof } from "./anchor.js";
export type { ProofStep } from "./anchor.js";

// Edge (Cloudflare Workers) support — WebCrypto attester + KV store. Edge-safe.
export { createWebCryptoAttester, generateAttesterJwk } from "./webcrypto.js";
export type { Ed25519Jwk } from "./webcrypto.js";
export { KvReceiptStore, loadOrCreateKvAttester, createWorkerGateway } from "./workers.js";
export type { KvLike } from "./workers.js";
export { createCloudExporter, createMemoryCloudOutbox, withCloudExporter } from "./cloud.js";
export { completeCloudEnrollment } from "./enrollment.js";
export type { CloudEnrollmentBundle, CloudEnrollmentResult } from "./enrollment.js";
export type {
  CloudDeliveryGap, CloudExporter, CloudExporterOptions, CloudExporterStatus,
  CloudOutbox, CloudOutboxEntry, CloudOutboxStatus, MemoryCloudOutboxOptions,
} from "./cloud.js";
