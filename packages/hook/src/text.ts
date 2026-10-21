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

/** The text without the given characters at either end. A loop, not an end-anchored pattern: a regular expression for this
 *  takes time that grows with the square of a long run of those characters. */
export function trimChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start++;
  while (end > start && chars.includes(text[end - 1])) end--;
  return text.slice(start, end);
}
