// @scopebond/policy-schema/registry — the Action Taxonomy v1 registry and a
// structural parameter validator. The registry JSON (registry/actions-1.0.json)
// is the machine source; the package README describes it. Bound-able
// parameters may be constrained by an action_allowlist clause's param_bounds;
// this module validates the *shape* of a normalized action, not policy verdicts
// (verdicts are @scopebond/verify's `violates`).

import registryDocument from "../registry/actions-1.0.json" with { type: "json" };

export type ParameterType = "string" | "integer" | "boolean" | "array" | "enum";
export type RiskClass = "routine" | "sensitive" | "destructive" | "money" | "identity";

export interface ActionParameter {
  name: string;
  type: ParameterType;
  required: boolean;
  boundable: boolean;
  description: string;
  enum?: string[];
}

export interface ActionType {
  id: string;
  taxonomy_version: string;
  summary: string;
  risk_class: RiskClass;
  spend: { asset: string; amount: string } | null;
  emitted_by: string[];
  parameters: ActionParameter[];
  examples: Array<Record<string, unknown>>;
}

export interface ActionRegistry {
  taxonomy_version: string;
  description: string;
  actions: ActionType[];
}

export const actionRegistry = registryDocument as unknown as ActionRegistry;
export const TAXONOMY_VERSION = actionRegistry.taxonomy_version;

const byId = new Map<string, ActionType>(actionRegistry.actions.map((a) => [a.id, a]));
/** Types a signed taxonomy extension adds (taxonomy-ext.ts), consulted after the built-in registry. Empty until an engine
 *  puts a verified extension in force. */
let extension = new Map<string, ActionType>();

/** The registered type for an id: the built-in registry first, then the taxonomy extension in force; undefined if neither
 *  has it. */
export function getActionType(id: string): ActionType | undefined {
  return byId.get(id) ?? extension.get(id);
}

/** The built-in type for an id, ignoring any extension. */
export function getBuiltinActionType(id: string): ActionType | undefined {
  return byId.get(id);
}

/** Put the types of a verified taxonomy extension in force (an empty list removes them). A type the built-in registry
 *  already defines is never replaced. */
export function setActionTypeExtension(types: readonly ActionType[]): void {
  extension = new Map(types.filter((t) => !byId.has(t.id)).map((t) => [t.id, t]));
}

/** The extension types in force. */
export function extensionActionTypes(): ActionType[] {
  return [...extension.values()];
}

export interface ParamValidation {
  /** Whether the action type is registered at all. Unknown types fall back to
   * tool.<name> / not_evaluated at the connector, never a silent allow. */
  known: boolean;
  valid: boolean;
  errors: string[];
}

function matchesType(type: ParameterType, value: unknown): boolean {
  switch (type) {
    case "string":
    case "enum": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
  }
}

/** Validate a normalized action's parameters against the registry: required
 * parameters must be present and every declared parameter that is present must
 * match its type (and enum membership). Undeclared extra parameters are allowed
 * (adapters may carry context); a parameter omitted under a policy bound is
 * denied at verdict time, not here. */
export function validateActionParams(
  actionType: string,
  params: Record<string, unknown> = {},
): ParamValidation {
  const def = getActionType(actionType);
  if (!def) return { known: false, valid: false, errors: [`unknown action type "${actionType}"`] };
  const errors: string[] = [];
  for (const parameter of def.parameters) {
    const present = params[parameter.name] !== undefined && params[parameter.name] !== null;
    if (!present) {
      if (parameter.required) errors.push(`missing required parameter "${parameter.name}"`);
      continue;
    }
    const value = params[parameter.name];
    if (!matchesType(parameter.type, value)) {
      errors.push(`parameter "${parameter.name}" must be ${parameter.type}`);
      continue;
    }
    if (parameter.type === "enum" && parameter.enum && !parameter.enum.includes(value as string)) {
      errors.push(`parameter "${parameter.name}"="${String(value)}" is not one of ${parameter.enum.join(", ")}`);
    }
  }
  return { known: true, valid: errors.length === 0, errors };
}
