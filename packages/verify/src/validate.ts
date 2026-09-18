// Clean-room, dependency-free validation of the vocabulary-v1 policy and action
// documents (ADR-008/D40: core packages carry no vendor SDKs — no ajv). This
// mirrors packages/policy-schema/schema/{policy,action}.schema.json exactly; the
// conformance vectors and unit tests are the behavioural oracle.

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const MAX_SAFE = 9007199254740991;
const DURATION_RE = /^P(?=.+)(?:[0-9]+D)?(?:T(?=.+)(?:[0-9]+H)?(?:[0-9]+M)?(?:[0-9]+S)?)?$/;
const HHMM_RE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const CLAUSE_MODES = new Set(["enforce", "monitor", "require_approval"]);
const SCOPES = new Set(["principal", "global"]);

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1;
}
function isIntInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
}
function isInteger(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v);
}
function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}
function isNonEmptyStringArray(v: unknown): boolean {
  if (!Array.isArray(v) || v.length < 1) return false;
  const seen = new Set<string>();
  for (const item of v) {
    if (!isNonEmptyString(item) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}
function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function isIntegerArray(v: unknown): boolean {
  return Array.isArray(v) && v.every(isInteger);
}
function isDuration(v: unknown): boolean {
  return typeof v === "string" && DURATION_RE.test(v);
}
function onlyKeys(o: Obj, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(o).every((k) => set.has(k));
}
function hasKeys(o: Obj, required: readonly string[]): boolean {
  return required.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

/** A finite JSON value (RFC 8259 shape): null, boolean, string, finite number,
 *  array of JSON values, or a plain object of JSON values. Rejects NaN/Infinity,
 *  functions, undefined, symbols and non-plain objects. */
function isFiniteJsonValue(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === "boolean" || t === "string") return true;
  if (t === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isFiniteJsonValue);
  if (isPlainObject(v)) return Object.values(v).every(isFiniteJsonValue);
  return false;
}

// --- Action intent (action.schema.json) -----------------------------------

const ACTION_KEYS = ["action_type", "asset", "amount", "signer", "params"] as const;

export function validateAction(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["/ action must be an object"] };
  if (!onlyKeys(value, ACTION_KEYS)) errors.push("/ action has unknown properties");
  if (!isNonEmptyString(value.action_type)) errors.push("/action_type must be a nonempty string");
  if ("asset" in value && !isNonEmptyString(value.asset)) errors.push("/asset must be a nonempty string");
  if ("amount" in value && !isIntInRange(value.amount, 0, MAX_SAFE)) errors.push("/amount must be a nonnegative safe integer");
  if ("signer" in value && !isNonEmptyString(value.signer)) errors.push("/signer must be a nonempty string");
  if ("params" in value) {
    if (!isPlainObject(value.params)) errors.push("/params must be an object");
    else if (!isFiniteJsonValue(value.params)) errors.push("/params must be finite JSON");
  }
  return { valid: errors.length === 0, errors };
}

// --- Policy document (policy.schema.json) ----------------------------------

const POLICY_KEYS = ["vocabulary_version", "assets", "policy_id", "version", "agent_id", "clauses"] as const;
const CLAUSE_BASE_KEYS = ["id", "type", "mode", "description"] as const;

// A scalar bound: min / max / enum / pattern. Used both at the top level and as
// the `items` of an array bound.
function isScalarBound(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  if (!onlyKeys(v, ["min", "max", "enum", "pattern"])) return false;
  if (Object.keys(v).length < 1) return false; // minProperties 1
  if ("min" in v && !isFiniteNumber(v.min)) return false;
  if ("max" in v && !isFiniteNumber(v.max)) return false;
  if ("pattern" in v && typeof v.pattern !== "string") return false;
  if ("enum" in v) {
    const e = v.enum;
    if (!Array.isArray(e) || e.length < 1) return false;
    const seen = new Set<unknown>();
    for (const item of e) {
      const t = typeof item;
      const ok = item === null || t === "string" || t === "boolean" || (t === "number" && Number.isFinite(item));
      if (!ok || seen.has(item)) return false;
      seen.add(item);
    }
  }
  return true;
}

function isParamBound(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  // An array bound carries `items` (a scalar bound applied per element) and an
  // optional `match` ("all" default | "any"); it is mutually exclusive with a
  // top-level scalar bound. `match` is only meaningful with `items`.
  if ("items" in v || "match" in v) {
    if (!onlyKeys(v, ["items", "match"])) return false;
    if (!("items" in v) || !isScalarBound(v.items)) return false;
    if ("match" in v && v.match !== "all" && v.match !== "any") return false;
    return true;
  }
  return isScalarBound(v);
}

function validateAssets(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every((entry) =>
    isPlainObject(entry) && onlyKeys(entry, ["decimals"]) &&
    hasKeys(entry, ["decimals"]) && isIntInRange(entry.decimals, 0, 18));
}

/** Per-clause-type validators. Each enforces its branch's additionalProperties:false
 *  (allowed keys = clause-base keys + the listed extras), required keys, and property
 *  types, plus the schema's anyOf/dependentRequired constraints. */
const CLAUSE_VALIDATORS: Record<string, (c: Obj) => boolean> = {
  spend_limit: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "asset", "max_per_action", "max_per_window", "window", "scope"]) &&
    typeof c.asset === "string" &&
    (("max_per_action" in c) || (("max_per_window" in c) && ("window" in c))) &&
    (!("max_per_window" in c) || "window" in c) &&
    (!("max_per_action" in c) || isIntInRange(c.max_per_action, 0, MAX_SAFE)) &&
    (!("max_per_window" in c) || isIntInRange(c.max_per_window, 0, MAX_SAFE)) &&
    (!("window" in c) || isDuration(c.window)) &&
    (!("scope" in c) || SCOPES.has(c.scope as string)),
  rate_limit: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "action_types", "max_count", "window", "scope"]) &&
    isNonEmptyStringArray(c.action_types) && isIntInRange(c.max_count, 0, MAX_SAFE) && isDuration(c.window) &&
    (!("scope" in c) || SCOPES.has(c.scope as string)),
  address_allowlist: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "addresses", "chain_ids"]) &&
    isNonEmptyStringArray(c.addresses) && (!("chain_ids" in c) || isIntegerArray(c.chain_ids)),
  address_denylist: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "addresses", "chain_ids", "best_effort"]) &&
    isNonEmptyStringArray(c.addresses) && (!("chain_ids" in c) || isIntegerArray(c.chain_ids)) &&
    (!("best_effort" in c) || typeof c.best_effort === "boolean"),
  contract_allowlist: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "contracts", "selectors", "chain_ids"]) &&
    isNonEmptyStringArray(c.contracts) && (!("selectors" in c) || isStringArray(c.selectors)) &&
    (!("chain_ids" in c) || isIntegerArray(c.chain_ids)),
  endpoint_allowlist: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "hosts", "paths", "methods"]) &&
    isNonEmptyStringArray(c.hosts) && (!("paths" in c) || isStringArray(c.paths)) &&
    (!("methods" in c) || isStringArray(c.methods)),
  endpoint_denylist: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "hosts", "paths", "methods"]) &&
    isNonEmptyStringArray(c.hosts) && (!("paths" in c) || isStringArray(c.paths)) &&
    (!("methods" in c) || isStringArray(c.methods)),
  action_allowlist: (c) => {
    if (!onlyKeys(c, [...CLAUSE_BASE_KEYS, "action_types", "param_bounds"])) return false;
    if (!isNonEmptyStringArray(c.action_types)) return false;
    if ("param_bounds" in c) {
      const pb = c.param_bounds;
      if (!isPlainObject(pb) || Object.keys(pb).length < 1) return false;
      if (!Object.values(pb).every(isParamBound)) return false;
    }
    return true;
  },
  time_window: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "days", "start", "end", "timezone"]) &&
    (!("days" in c) || isStringArray(c.days)) &&
    typeof c.start === "string" && HHMM_RE.test(c.start) &&
    typeof c.end === "string" && HHMM_RE.test(c.end) &&
    (!("timezone" in c) || c.timezone === "UTC"),
  require_approval: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "action_types", "approvers", "min_approvals", "timeout"]) &&
    isNonEmptyStringArray(c.action_types) && isNonEmptyStringArray(c.approvers) &&
    (!("min_approvals" in c) || isIntInRange(c.min_approvals, 1, MAX_SAFE)) &&
    (!("timeout" in c) || isDuration(c.timeout)),
  sequence: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "first_action_types", "then_action_types", "min_gap", "forbidden_within"]) &&
    isNonEmptyStringArray(c.first_action_types) && isNonEmptyStringArray(c.then_action_types) &&
    (("min_gap" in c) || ("forbidden_within" in c)) &&
    (!("min_gap" in c) || isDuration(c.min_gap)) &&
    (!("forbidden_within" in c) || isDuration(c.forbidden_within)),
  oracle_condition: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "oracle_id", "predicate", "best_effort"]) &&
    typeof c.oracle_id === "string" && typeof c.predicate === "string" && c.best_effort === true,
  key_policy: (c) =>
    onlyKeys(c, [...CLAUSE_BASE_KEYS, "active_keys", "rotation_delay", "max_key_age"]) &&
    isNonEmptyStringArray(c.active_keys) &&
    (!("rotation_delay" in c) || isDuration(c.rotation_delay)) &&
    (!("max_key_age" in c) || isDuration(c.max_key_age)),
};

function validateClause(c: unknown, index: number, errors: string[]): void {
  if (!isPlainObject(c)) { errors.push(`/clauses/${index} must be an object`); return; }
  if (!isNonEmptyString(c.id)) errors.push(`/clauses/${index}/id must be a nonempty string`);
  if (typeof c.type !== "string") { errors.push(`/clauses/${index}/type must be a string`); return; }
  if ("mode" in c && !CLAUSE_MODES.has(c.mode as string)) errors.push(`/clauses/${index}/mode is invalid`);
  if ("description" in c && typeof c.description !== "string") errors.push(`/clauses/${index}/description must be a string`);
  const validator = CLAUSE_VALIDATORS[c.type];
  if (!validator) { errors.push(`/clauses/${index}/type "${c.type}" is not a supported clause type`); return; }
  if (!validator(c)) errors.push(`/clauses/${index} does not match the ${c.type} clause schema`);
}

/** Schema-level validation of a vocabulary-v1 policy document (mirrors
 *  policy.schema.json). Semantic checks (duplicate ids, min_approvals, coherent
 *  bounds) are layered on top by the caller. */
export function validatePolicyShape(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(value)) return { valid: false, errors: ["/ policy must be an object"] };
  if (!onlyKeys(value, POLICY_KEYS)) errors.push("/ policy has unknown properties");
  if (!hasKeys(value, ["vocabulary_version", "policy_id", "version", "clauses"])) errors.push("/ policy is missing required fields");
  if (value.vocabulary_version !== "1.0") errors.push('/vocabulary_version must be "1.0"');
  if (!isNonEmptyString(value.policy_id)) errors.push("/policy_id must be a nonempty string");
  if (!isIntInRange(value.version, 1, MAX_SAFE)) errors.push("/version must be an integer >= 1");
  if ("agent_id" in value && typeof value.agent_id !== "string") errors.push("/agent_id must be a string");
  if ("assets" in value && !validateAssets(value.assets)) errors.push("/assets is invalid");
  if (!Array.isArray(value.clauses) || value.clauses.length < 1) {
    errors.push("/clauses must be a nonempty array");
  } else {
    value.clauses.forEach((c, i) => validateClause(c, i, errors));
  }
  return { valid: errors.length === 0, errors };
}
