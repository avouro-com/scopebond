import { createHash } from "node:crypto";
import type { Intent } from "@scopebond/verify";
import { canonical } from "@scopebond/policy-schema/canonical";
export { canonical } from "@scopebond/policy-schema/canonical";

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const intentHash = (intent: Intent): string => sha256(canonical(intent));

/** Stable key id over the Ed25519 public-key material only. */
export function deriveKid(publicJwk: Record<string, unknown>): string {
  return "key:" + sha256(canonical({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x })).slice(0, 16);
}
