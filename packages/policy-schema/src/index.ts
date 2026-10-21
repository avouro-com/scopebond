// @scopebond/policy-schema — ships the JSON Schemas, vocabulary constants, and
// vectors. Runtime validation is left to consumers (e.g. ajv); this package is
// the canonical source of the schema and the enumerations.

import policySchemaDocument from "../schema/policy.schema.json" with { type: "json" };
import actionSchemaDocument from "../schema/action.schema.json" with { type: "json" };
import receiptSchemaDocument from "../schema/receipt.schema.json" with { type: "json" };
import legacyReceiptSchemaDocument from "../schema/receipt-legacy.schema.json" with { type: "json" };
import observationSchemaDocument from "../schema/observation.schema.json" with { type: "json" };
import summarySchemaDocument from "../schema/summary.schema.json" with { type: "json" };
import sessionBudgetsSchemaDocument from "../schema/session-budgets.schema.json" with { type: "json" };
import packSchemaDocument from "../schema/pack.schema.json" with { type: "json" };
import { canonical } from "./canonical.js";
export { canonical } from "./canonical.js";
export {
  actionRegistry, TAXONOMY_VERSION, getActionType, getBuiltinActionType, setActionTypeExtension, extensionActionTypes, validateActionParams,
} from "./registry.js";
export {
  PACK_FORMAT, PACK_SIGNATURE_DOMAIN, PACK_LIMITS, PACK_RESERVED_ACTION_TYPES, PACK_RESERVED_PARAMS, EXPRESSION_OPERATORS, CONDITION_OPERATORS,
  PACK_ENGINE_LEVEL, PACK_LEVEL2_FIELDS, PACK_ALLOW_PATTERN_KINDS, PACK_RULE_LIMITS,
  packSigningInput, packRef, comparePackVersions, validatePack, packEngineProblem, packRequiredEngine,
} from "./pack.js";
export type {
  Pack, PackGrammar, PackCommand, PackEmit, PackProfile, PackProfileTool, PackVector, PackSignature, PackValidation, PathWord, Expr, Condition, ExpectedValue, Scalar,
  PackRequires, PackRule, PackAllowPattern, PackValidationOptions,
} from "./pack.js";
export {
  ALLOW_PATTERN_KINDS, ALLOW_PATTERN_LIMITS, DELETE_RECIPE, validAllowPatterns, allowPatternErrors, validAllowanceMatch, validBounds,
} from "./allow-patterns.js";
export type { AllowPattern, AllowPatternKind, AllowanceMatch, AllowanceBounds } from "./allow-patterns.js";
export {
  TAXONOMY_EXT_FORMAT, TAXONOMY_EXT_SIGNATURE_DOMAIN, TAXONOMY_EXT_ID, TAXONOMY_EXT_LIMITS,
  taxonomyExtSigningInput, validateTaxonomyExtension, actionTypesOfExtension,
} from "./taxonomy-ext.js";
export type { TaxonomyExtension, TaxonomyExtType, TaxonomyExtParamKind } from "./taxonomy-ext.js";
export type {
  ActionRegistry, ActionType, ActionParameter, ParameterType, RiskClass, ParamValidation,
} from "./registry.js";

export const policySchema = policySchemaDocument as Record<string, unknown>;
export const actionSchema = actionSchemaDocument as Record<string, unknown>;
export const receiptSchema = receiptSchemaDocument as Record<string, unknown>;
export const legacyReceiptSchema = legacyReceiptSchemaDocument as Record<string, unknown>;
export const observationSchema = observationSchemaDocument as Record<string, unknown>;
export const summarySchema = summarySchemaDocument as Record<string, unknown>;
export const sessionBudgetsSchema = sessionBudgetsSchemaDocument as Record<string, unknown>;
export const packSchema = packSchemaDocument as Record<string, unknown>;

// Summary record (scopebond:summary v1, evidence class "summary"): a signed stand-in for routine receipts when they are
// sent, with an RFC 9162 root over the receipts it covers. Receipts are unchanged and every action keeps its own. The
// signature covers the domain below followed by the RFC 8785 canonical payload, with the key that signs the receipts.
export const SUMMARY_TYPE = "scopebond:summary";
export const SUMMARY_VERSION = "1.0";
export const SUMMARY_DOMAIN = "scopebond:summary/v1\n";
/** The only results a summary may count: a denied, overridden, approved or timed-out action is always sent in full. */
export const SUMMARY_RESULTS = ["allow", "not_evaluated"] as const;
export const SUMMARY_LIMITS = { maxCounts: 500, maxDedupe: 500, maxReceipts: 1_000_000 } as const;

// Observation envelope (scopebond:observation v1): a separate, closed envelope for
// lifecycle, health, policy-acknowledgement and independently sourced outcome
// observations. Receipts are unchanged. The signature covers the domain below followed
// by the RFC 8785 canonical payload; observation_hash is the SHA-256 of the same bytes.
export const OBSERVATION_TYPE = "scopebond:observation";
export const OBSERVATION_VERSION = "1.0";
export const OBSERVATION_DOMAIN = "scopebond:observation/v1\n";
export const SOURCE_RECEIPT_DOMAIN = "scopebond:source-receipt/v1\n";
export const OBSERVATION_KINDS = [
  "session", "capability", "health", "policy_ack", "tool_intent",
  "tool_outcome", "platform_outcome", "verification", "integrity", "export",
] as const;
export const OBSERVATION_LIMITS = {
  maxBatchItems: 100,
  maxObservationBytes: 16 * 1024,
  maxBatchBodyBytes: 1024 * 1024,
} as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** The exact string whose UTF-8 bytes an observation signature (and observation_hash) covers. */
export const observationSigningInput = (payload: Record<string, unknown>): string =>
  OBSERVATION_DOMAIN + canonical(payload);

export const VOCABULARY_VERSION = "1.0";
export const EVIDENCE_VERSION = "1.0";
export const CANONICALIZATION = "RFC8785";
export const REDACTION_PROFILE = "scopebond:minimized-intent/v1";

export const CLAUSE_TYPES = [
  "spend_limit", "rate_limit",
  "address_allowlist", "address_denylist", "contract_allowlist",
  "endpoint_allowlist", "endpoint_denylist", "action_allowlist",
  "time_window", "require_approval", "sequence", "oracle_condition", "key_policy",
  "force_push_guard",
] as const;

export const CLAUSE_MODES = ["enforce", "monitor", "require_approval"] as const;

export const REALTIME_RESULTS = ["allow", "deny", "approved", "timeout", "not_evaluated"] as const;
export const EXECUTION_STATES = [
  "simulated", "observed_not_evaluated", "denied", "allowed_pending",
  "cooperative_allow",
  "executed", "failed", "outcome_unknown",
  // A violation recorded after the action already ran (`realtime_result: "deny"`, `executed: true`): not prevented.
  "observed_after",
] as const;

// Evidence classes: how strong a receipt's evidence is. Additive
// payload field; the verifier never upgrades an explicitly set class.
export const EVIDENCE_CLASSES = ["signed_intent", "pep_authorized", "boundary"] as const;
export const BOUNDARY_GATES = ["merge", "deploy", "egress", "platform_event"] as const;
export const ATTRIBUTION_KINDS = ["asserted", "inferred"] as const;

// Optional receipt context (payload.context): where a receipt was produced, so records can be grouped by session and
// filtered by tool, model and repository. A closed object; every member is optional and may be null. It carries no
// local paths, no credentials and no prompts. Covered by the signature like the rest of the payload.
export const RECEIPT_CONTEXT_KEYS = ["harness", "harness_version", "model", "session_id", "repository", "branch"] as const;
export type ReceiptContextKey = (typeof RECEIPT_CONTEXT_KEYS)[number];
export type ReceiptContext = Partial<Record<ReceiptContextKey, string | null>>;

// Optional receipt match (payload.clause_id, payload.failed_bound): the policy clause that matched a denied, monitored,
// held or overridden action, and the bound of it that failed, as `<param>:<bound>` (`program:pattern`, `path:pattern`,
// `amount:max_per_action`). It names the param and the bound, never the param's value. A receipt for an allowed action
// carries neither.
export const RECEIPT_FAILED_BOUND_PATTERN = "^[A-Za-z0-9_.-]{1,64}:[a-z_]{1,32}$";
/** The realtime results a receipt naming a matched clause may carry. */
export const RECEIPT_MATCH_RESULTS = ["deny", "approved", "timeout"] as const;

// Optional plugin slot (payload.pattern_id, payload.intel): what a signed plugin the hook loaded gave an action, a pattern id
// (64 lowercase hex) and an opaque slot (standard base64 of 1 to 4096 bytes). Both are optional and independent, covered by
// the signature like the rest of the payload, and never interpreted by the open code. A receipt made without a plugin
// carries neither.
export const RECEIPT_PATTERN_ID_PATTERN = "^[0-9a-f]{64}$";
export const RECEIPT_INTEL_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";
/** The most bytes the slot may carry, decoded. */
export const RECEIPT_INTEL_MAX_BYTES = 4096;
/** The longest the slot may be as text: base64 of RECEIPT_INTEL_MAX_BYTES (4096 bytes end in one byte, so `==`; a slot this
 *  long without it would be 4097 or 4098 bytes). */
export const RECEIPT_INTEL_MAX_LENGTH = 5464;
const INTEL_SLOT = new RegExp(RECEIPT_INTEL_PATTERN);

/** Whether `value` is a slot the receipt schema accepts: standard padded base64 of 1 to RECEIPT_INTEL_MAX_BYTES bytes. */
export function isReceiptIntel(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > RECEIPT_INTEL_MAX_LENGTH) return false;
  if (!INTEL_SLOT.test(value)) return false;
  return value.length < RECEIPT_INTEL_MAX_LENGTH || value.endsWith("==");
}

/** Whether `value` is a pattern id the receipt schema accepts: 64 lowercase hex. */
export function isReceiptPatternId(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

/** The plugin slot members a receipt may carry; both optional. */
export interface ReceiptIntel { pattern_id?: string; intel?: string }

// Session budgets (session-budgets.schema.json): limits on what one coding-agent session may do, sent by a workspace in its
// rules document as `session_budgets` (at most so many actions of the listed types, 0 = none, until the budget expires). The
// words follow the gateway's action budgets. A receipt an action budget counted or refused carries `payload.budget`.
export const SESSION_BUDGET_SCOPE = "session";
/** How long a session budget lasts when whoever sets it does not say: two hours. */
export const SESSION_BUDGET_DEFAULT_SECONDS = 7_200;
export const SESSION_BUDGET_MODES = ["enforce", "monitor"] as const;
export const SESSION_BUDGET_LIMITS = { maxBudgets: 50, maxLimits: 10, maxOperations: 20, maxCount: 1_000_000 } as const;
export const RECEIPT_BUDGET_STATES = ["within", "at_limit", "over", "unavailable"] as const;
export type SessionBudgetMode = (typeof SESSION_BUDGET_MODES)[number];
export type ReceiptBudgetState = (typeof RECEIPT_BUDGET_STATES)[number];
export interface SessionBudgetLimit { operations: string[]; max: number }
export interface SessionBudget {
  budget_id: string;
  scope: typeof SESSION_BUDGET_SCOPE;
  session_id: string;
  limits: SessionBudgetLimit[];
  mode: SessionBudgetMode;
  version: number;
  expires_at: string;
  source?: "request" | "admin";
  count_shell_as_write?: boolean;
}

// The coverage buckets a policy resolves into (POLICY_VOCABULARY.md §4).
export const COVERAGE_BUCKETS = ["prevented", "covered", "refused"] as const;

export type ClauseType = (typeof CLAUSE_TYPES)[number];
export type ClauseMode = (typeof CLAUSE_MODES)[number];
export type RealtimeResult = (typeof REALTIME_RESULTS)[number];
export type ExecutionState = (typeof EXECUTION_STATES)[number];
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export type BoundaryGate = (typeof BOUNDARY_GATES)[number];
export type AttributionKind = (typeof ATTRIBUTION_KINDS)[number];
