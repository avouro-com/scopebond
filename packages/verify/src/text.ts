// Internal helper shared by the evaluator and the summary checks; not a package export.

/** A JSON value as text: what `String(v)` (or a template literal) gives for a string, number,
 *  boolean, null, array or plain object, with `null` and `undefined` inside an array as "".
 *  Unlike `String(v)` it never calls the value's own `toString`/`valueOf`, so parsed JSON that
 *  carries those keys (`{"toString": 1}`) reads as "[object Object]" instead of throwing. */
export function jsonText(v: unknown): string {
  if (v === null || typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map((el: unknown) => (el == null ? "" : jsonText(el))).join(",");
  return "[object Object]";
}
