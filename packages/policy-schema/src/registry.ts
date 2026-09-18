// @scopebond/policy-schema/registry — the Action Taxonomy v1 registry and a
// structural parameter validator. The registry is the machine source that the
// human index (docs/integrations/ACTION_TAXONOMY.md) mirrors. Bound-able
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

/** The registered type for an id, or undefined if the id is not in the taxonomy. */
export function getActionType(id: string): ActionType | undefined {
  return byId.get(id);
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
  const def = byId.get(actionType);
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
