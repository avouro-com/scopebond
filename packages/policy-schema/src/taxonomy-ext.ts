// Signed taxonomy extensions (scopebond:taxonomy-ext/v1): action types added to the built-in registry as signed data, so a
// rule pack can emit a new kind of action without a new engine. An extension is
//
//   { format: "scopebond:taxonomy-ext/v1", issued_at, types: [{ action_type, params, mutating, target_opt_in }], signature }
//
// where `params` names each parameter's kind ("string", "number" or "boolean"), `mutating` says whether the action changes
// something, and `target_opt_in` whether a policy that names the type decides derived actions (as the types Action Taxonomy
// 1.1 introduced do). An extension never redefines a built-in type and never adds the call itself (`shell.exec`,
// `mcp.tool.call`). It is signed like a pack: Ed25519 with a policy-signing key over the domain below followed by the RFC 8785
// canonical document without its `signature` member.
//
// An engine reads an extension's types after the built-in registry (registry.ts `setActionTypeExtension`). An action of a
// type neither knows is recorded and never decided, so an engine without the extension degrades safely.

import { canonical } from "./canonical.js";
import { getBuiltinActionType, type ActionType } from "./registry.js";
import { PACK_RESERVED_ACTION_TYPES, PACK_RESERVED_PARAMS, type PackSignature } from "./pack.js";

export const TAXONOMY_EXT_FORMAT = "scopebond:taxonomy-ext/v1";
/** What an extension signature covers: these bytes, then the canonical document without `signature`. */
export const TAXONOMY_EXT_SIGNATURE_DOMAIN = "scopebond:taxonomy-ext/v1\n";
/** The id an extension is named by in a workspace's signed pack list (`{ id, version, sha256 }`). */
export const TAXONOMY_EXT_ID = "taxonomy-ext";
export const TAXONOMY_EXT_LIMITS = { maxBytes: 256 * 1024, maxTypes: 200, maxParams: 24 } as const;

export type TaxonomyExtParamKind = "string" | "number" | "boolean";
export interface TaxonomyExtType {
  action_type: string;
  params: Record<string, TaxonomyExtParamKind>;
  mutating: boolean;
  target_opt_in: boolean;
}
export interface TaxonomyExtension {
  format: typeof TAXONOMY_EXT_FORMAT;
  issued_at: string;
  types: TaxonomyExtType[];
  signature: PackSignature;
}

// eslint-disable-next-line security/detect-unsafe-regex -- linear: each repeat starts at a dot the one before it cannot contain
const ACTION_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const PARAM = /^[a-z][a-z0-9_]{0,63}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, fixed-width fields
const ISSUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SIG = /^[A-Za-z0-9+/]{86}(?:==)?$/;
const KINDS: readonly string[] = ["string", "number", "boolean"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).every((k) => keys.includes(k));

/** The exact string whose UTF-8 bytes an extension signature covers. */
export function taxonomyExtSigningInput(doc: Record<string, unknown>): string {
  const unsigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) if (key !== "signature") unsigned[key] = value;
  return TAXONOMY_EXT_SIGNATURE_DOMAIN + canonical(unsigned);
}

/** Check an extension document against the closed format (the shape only; the signature is the engine's to verify). */
export function validateTaxonomyExtension(doc: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const fail = (at: string, message: string): void => { if (errors.length < 50) errors.push(`${at}: ${message}`); };
  if (!isObject(doc)) return { valid: false, errors: ["extension: must be an object"] };
  if (!only(doc, ["format", "issued_at", "types", "signature"])) fail("extension", "has an unknown field");
  if (doc.format !== TAXONOMY_EXT_FORMAT) fail("extension.format", `must be "${TAXONOMY_EXT_FORMAT}"`);
  if (typeof doc.issued_at !== "string" || !ISSUED_AT.test(doc.issued_at) || !Number.isFinite(Date.parse(doc.issued_at))) fail("extension.issued_at", "must be a UTC time with Z");
  const sig = doc.signature;
  if (!isObject(sig) || !only(sig, ["alg", "key_id", "value"]) || sig.alg !== "Ed25519" || typeof sig.key_id !== "string" || !KEY_ID.test(sig.key_id)
    || typeof sig.value !== "string" || !SIG.test(sig.value)) fail("extension.signature", "must be { alg: Ed25519, key_id, value }");
  if (!Array.isArray(doc.types) || doc.types.length < 1 || doc.types.length > TAXONOMY_EXT_LIMITS.maxTypes) {
    fail("extension.types", `must have 1 to ${TAXONOMY_EXT_LIMITS.maxTypes} items`);
    return { valid: false, errors };
  }
  const seen = new Set<string>();
  doc.types.forEach((t: unknown, i: number) => {
    const at = `extension.types[${i}]`;
    if (!isObject(t) || !only(t, ["action_type", "params", "mutating", "target_opt_in"])) { fail(at, "must be { action_type, params, mutating, target_opt_in }"); return; }
    const id = t.action_type;
    if (typeof id !== "string" || id.length > 100 || !ACTION_TYPE.test(id)) fail(`${at}.action_type`, "is not an action type name");
    else if (PACK_RESERVED_ACTION_TYPES.includes(id)) fail(`${at}.action_type`, `"${id}" is the call itself`);
    else if (getBuiltinActionType(id)) fail(`${at}.action_type`, `"${id}" is a built-in type; an extension cannot redefine it`);
    else if (seen.has(id)) fail(`${at}.action_type`, `"${id}" is listed twice`);
    if (typeof id === "string") seen.add(id);
    if (!isObject(t.params) || Object.keys(t.params).length > TAXONOMY_EXT_LIMITS.maxParams) fail(`${at}.params`, `must be an object of at most ${TAXONOMY_EXT_LIMITS.maxParams} parameters`);
    else for (const [name, kind] of Object.entries(t.params)) {
      if (!PARAM.test(name) || PACK_RESERVED_PARAMS.includes(name)) fail(`${at}.params`, `"${name}" is not a parameter name an extension may define`);
      if (!KINDS.includes(kind as string)) fail(`${at}.params.${name}`, "must be string, number or boolean");
    }
    if (typeof t.mutating !== "boolean") fail(`${at}.mutating`, "must be a boolean");
    if (typeof t.target_opt_in !== "boolean") fail(`${at}.target_opt_in`, "must be a boolean");
  });
  return { valid: errors.length === 0, errors };
}

/** An extension's types as registry entries (registry.ts `setActionTypeExtension`): every parameter optional and boundable,
 *  a mutating type sensitive and any other routine. */
export function actionTypesOfExtension(ext: Pick<TaxonomyExtension, "types">): ActionType[] {
  return ext.types.map((t) => ({
    id: t.action_type, taxonomy_version: "ext", summary: `${t.action_type} (taxonomy extension)`,
    risk_class: t.mutating ? "sensitive" : "routine", spend: null, emitted_by: ["pack"],
    parameters: Object.entries(t.params).map(([name, kind]) => ({
      name, type: kind === "number" ? "integer" : kind, required: false, boundable: true, description: `${name} (${kind})`,
    })),
    examples: [],
  }));
}
