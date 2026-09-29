/** True if `s` contains a lone UTF-16 surrogate (a high surrogate not followed by a
 * low one, or a low surrogate with no preceding high). RFC 8785 canonicalizes valid
 * Unicode; a lone surrogate is malformed and `JSON.stringify` would silently escape it
 * to `\udXXX` rather than refuse it. Linear scan, no allocation. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1; // a valid surrogate pair; skip its low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Serialize a string as RFC 8785 requires, refusing malformed (lone-surrogate) input
 * rather than letting `JSON.stringify` coerce it into a signable escape. */
function canonicalString(s: string): string {
  if (hasLoneSurrogate(s)) throw new TypeError("canonical JSON rejects lone surrogates (malformed Unicode)");
  return JSON.stringify(s);
}

/** RFC 8785 JSON Canonicalization Scheme for the JSON value domain used by Scopebond.
 * Reject values that JSON would silently omit or coerce before they enter a signature. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return canonicalString(value);
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
      return canonicalString(key) + ":" + canonical(object[key]);
    }).join(",") + "}";
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}
