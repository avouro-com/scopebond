// Text from a parsed payload, without the "[object Object]" that `String()` gives a value of the wrong shape.

/** The text of a value read from a JSON payload or file. A string is returned as it is, a number or boolean as
 *  `String()` writes it, and a missing value (undefined or null) as "". Anything else (an object or array where text
 *  was expected) is its JSON, so a malformed field reads as what it holds rather than as "[object Object]". */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value) ?? "";
}
