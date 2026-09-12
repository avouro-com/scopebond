// @scopebond/policy-schema — ships the JSON Schemas, vocabulary constants, and
// vectors. Runtime validation is left to consumers (e.g. ajv); this package is
// the canonical source of the schema and the enumerations.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(here, rel), "utf8")) as Record<string, unknown>;

export const policySchema = load("../schema/policy.schema.json");
export const receiptSchema = load("../schema/receipt.schema.json");

export const VOCABULARY_VERSION = "1.0";

export const CLAUSE_TYPES = [
  "spend_limit", "rate_limit",
  "address_allowlist", "address_denylist", "contract_allowlist",
  "endpoint_allowlist", "endpoint_denylist", "action_allowlist",
  "time_window", "require_approval", "sequence", "oracle_condition", "key_policy",
] as const;

export const CLAUSE_MODES = ["enforce", "monitor", "require_approval"] as const;

export const REALTIME_RESULTS = ["allow", "deny", "approved", "timeout"] as const;

// The coverage buckets a policy resolves into (POLICY_VOCABULARY.md §4).
export const COVERAGE_BUCKETS = ["prevented", "covered", "refused"] as const;

export type ClauseType = (typeof CLAUSE_TYPES)[number];
export type ClauseMode = (typeof CLAUSE_MODES)[number];
export type RealtimeResult = (typeof REALTIME_RESULTS)[number];
