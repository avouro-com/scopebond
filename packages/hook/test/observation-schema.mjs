// A small JSON Schema (2020-12 subset) checker: exactly the keywords the observation
// schema uses. Enough to prove the closed shape without adding a validator dependency.
import { observationSchema } from "@scopebond/policy-schema";

function validate(schema, value, root = observationSchema) {
  if (schema.$ref !== undefined) {
    const target = schema.$ref === "#" ? root : schema.$ref.slice(2).split("/").reduce((node, key) => node[key], root);
    return validate(target, value, root);
  }
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string" && (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (schema.type === "integer" && (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.items && !value.every((item) => validate(schema.items, item, root))) return false;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    for (const key of schema.required ?? []) if (!(key in value)) return false;
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) { if (!validate(schema.properties[key], item, root)) return false; }
      else if (schema.additionalProperties === false) return false;
    }
  }
  if (schema.properties && schema.type === undefined && value && typeof value === "object") {
    for (const [key, sub] of Object.entries(schema.properties)) if (key in value && !validate(sub, value[key], root)) return false;
  }
  if (schema.oneOf && schema.oneOf.filter((alternative) => validate(alternative, value, root)).length !== 1) return false;
  return true;
}

export const validObservation = (payload) => validate(observationSchema, payload);
export const validSigned = (wrapper) => validate(observationSchema.$defs.signed_observation, wrapper);
