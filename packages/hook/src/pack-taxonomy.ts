// The signed taxonomy extension held on this computer: action types a workspace adds as data (@scopebond/policy-schema
// `scopebond:taxonomy-ext/v1`), so a rule pack can emit a new kind of action without a new hook.
//
// Where it lives: `taxonomy-ext.json` in the hook's state directory (the folder that holds policy.json), byte for byte as
// Scopebond Cloud serves it. The workspace's signed pack list names it as `{ id: "taxonomy-ext", version, sha256 }`
// (pack-sync.ts fetches it from the packs route, checks its digest and writes it here; a verified list that no longer names it
// removes it).
//
// It is used only when it is a valid extension and its signature verifies with a policy-signing key this release trusts, the
// key's window holding both its `issued_at` and now (pack-store.ts `verifySignedData`). Then its types join the action
// registry after the built-in ones (`getActionType`), and the types it marks `target_opt_in` opt a policy into deciding
// derived actions (target-rules.ts). Without it (missing, bad, or not named), those types are unknown: a pack that requires
// one is skipped, and an action of such a type is recorded, never decided.

import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setActionTypeExtension } from "@scopebond/policy-schema/registry";
import {
  actionTypesOfExtension, taxonomyExtSigningInput, validateTaxonomyExtension, TAXONOMY_EXT_LIMITS, type TaxonomyExtension,
} from "@scopebond/policy-schema/taxonomy-ext";
import { writeAtomic } from "./managed.js";
import { verifySignedData, type PackRefusal } from "./pack-store.js";
import type { PolicyKey } from "./policy-keys.js";
import { setExtensionOptInTypes } from "./target-rules.js";

export const TAXONOMY_EXT_FILE = "taxonomy-ext.json";

/** Check an extension document from text: the closed format, then its signature. */
export function checkTaxonomyExtText(text: string, options: { keys?: PolicyKey[]; now?: Date } = {}): { ok: true; ext: TaxonomyExtension } | { ok: false; reason: PackRefusal; message: string } {
  if (Buffer.byteLength(text, "utf8") > TAXONOMY_EXT_LIMITS.maxBytes) return { ok: false, reason: "too_large", message: "the taxonomy extension is too large" };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: "invalid", message: "the taxonomy extension is not JSON" }; }
  const shape = validateTaxonomyExtension(doc);
  if (!shape.valid) return { ok: false, reason: "invalid", message: `the taxonomy extension is not valid (${shape.errors.slice(0, 3).join("; ")})` };
  const ext = doc as TaxonomyExtension;
  const signature = verifySignedData(taxonomyExtSigningInput(ext as unknown as Record<string, unknown>), ext.issued_at, ext.signature, "taxonomy extension", options);
  return signature.ok ? { ok: true, ext } : signature;
}

/** The held extension's text, or null (none, or not a small regular file). */
function readHeld(dir: string): string | null {
  let fd: number;
  try { fd = openSync(join(dir, TAXONOMY_EXT_FILE), fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0)); } catch { return null; }
  try {
    const st = fstatSync(fd);
    return st.isFile() && st.size <= TAXONOMY_EXT_LIMITS.maxBytes ? readFileSync(fd, "utf8") : null;
  } catch { return null; } finally { closeSync(fd); }
}

/** The sha256 of the held extension's bytes, or null when none is held. */
export function heldTaxonomyDigest(dir: string): string | null {
  const text = readHeld(dir);
  return text === null ? null : createHash("sha256").update(text, "utf8").digest("hex");
}

/** Put an extension in force (its types in the registry, its opt-in types in target-rules.ts); null removes any. */
export function setTaxonomyExtension(ext: Pick<TaxonomyExtension, "types"> | null): void {
  setActionTypeExtension(ext ? actionTypesOfExtension(ext) : []);
  setExtensionOptInTypes(ext ? ext.types.filter((t) => t.target_opt_in).map((t) => t.action_type) : []);
}

/** Put the extension held here in force, after checking it; with none held, or one that does not check out, no extension is in
 *  force. Never throws. Returns what was found. */
export function activateTaxonomyExtension(dir: string, options: { keys?: PolicyKey[]; now?: Date } = {}): { state: "none" } | { state: "active"; types: string[] } | { state: "refused"; reason: PackRefusal; message: string } {
  try {
    const text = readHeld(dir);
    if (text === null) { setTaxonomyExtension(null); return { state: "none" }; }
    const checked = checkTaxonomyExtText(text, options);
    if (!checked.ok) { setTaxonomyExtension(null); return { state: "refused", reason: checked.reason, message: checked.message }; }
    setTaxonomyExtension(checked.ext);
    return { state: "active", types: checked.ext.types.map((t) => t.action_type) };
  } catch {
    setTaxonomyExtension(null);
    return { state: "refused", reason: "invalid", message: "the taxonomy extension could not be read" };
  }
}

/** Write a checked extension's text and put it in force. */
export function installTaxonomyExtension(dir: string, text: string, ext: TaxonomyExtension): void {
  writeAtomic(join(dir, TAXONOMY_EXT_FILE), text);
  setTaxonomyExtension(ext);
}

/** Remove the held extension and take its types out of force. True when one was held. */
export function removeTaxonomyExtension(dir: string): boolean {
  const held = readHeld(dir) !== null;
  try { rmSync(join(dir, TAXONOMY_EXT_FILE), { force: true }); } catch { /* never read again once its types are out of force */ }
  setTaxonomyExtension(null);
  return held;
}
