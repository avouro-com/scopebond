import { createHash } from "node:crypto";
import type { Intent } from "@scopebond/verify";

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
    return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const intentHash = (intent: Intent): string => sha256(canonical(intent));

/** Stable key id over the Ed25519 public-key material only. */
export function deriveKid(publicJwk: Record<string, unknown>): string {
  return "key:" + sha256(canonical({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x })).slice(0, 16);
}
