/** RFC 8785 JSON Canonicalization Scheme for the JSON value domain used by Scopebond.
 * Reject values that JSON would silently omit or coerce before they enter a signature. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("canonical JSON rejects sparse arrays");
    }
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON accepts only plain JSON objects");
    }
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map((key) => {
      if (object[key] === undefined) throw new TypeError("canonical JSON rejects undefined");
      return JSON.stringify(key) + ":" + canonical(object[key]);
    }).join(",") + "}";
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}
