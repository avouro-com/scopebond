// The optional plugin slot. A computer may hold one signed module the hook asks about each action before it is decided:
// `<home>/intel/current/intel.mjs`, beside `manifest.json` (`{ version, sha256, signature, key_id? }`). The module is
// loaded only when the manifest's SHA-256 is the module's and its signature verifies against a pinned policy key
// (policy-keys.ts) over "scopebond:component/intel/v1\n" followed by that SHA-256. Anything else and there is no plugin.
//
// The module exports `inspect(action)`, which returns `{ pattern_id, slot }` or nothing: a pattern id (64 lowercase hex)
// and an opaque slot (base64 of at most 4 KiB). The hook signs them into the action's receipt as `pattern_id` and `intel`
// and never reads what the slot holds. `inspect` is called synchronously, with a copy of the action, and must answer
// within INTEL_BUDGET_MS: a throw, a promise, an answer of the wrong shape or one that took longer gives no slot. It never
// changes the decision.
//
// Without the module (any build of this repository, or a computer that has none), nothing is loaded, no member is added,
// and every receipt is exactly what it was before.

import { createHash, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileFunction, constants as vmConstants } from "node:vm";
import { isReceiptIntel, isReceiptPatternId } from "@scopebond/policy-schema";
import { policyKeys, publicKeyFrom, type PolicyKey } from "./policy-keys.js";
import { userHome } from "./install.js";

/** What the signature covers: this domain, then the module's SHA-256 (64 lowercase hex). */
export const INTEL_COMPONENT_DOMAIN = "scopebond:component/intel/v1\n";
/** How long `inspect` may take for one action, in milliseconds. */
export const INTEL_BUDGET_MS = 2;
/** The largest module the hook reads. */
export const INTEL_MAX_BYTES = 8 * 1024 * 1024;
export const INTEL_MODULE = "intel.mjs";
export const INTEL_MANIFEST = "manifest.json";

/** The manifest beside the module. `key_id`, when present, names the pinned key that signed it. */
export interface IntelManifest { version: string; sha256: string; signature: string; key_id?: string }
/** The action as the plugin sees it: a copy of the intent being decided. */
export interface IntelAction { action_type: string; params: Record<string, unknown> }
/** The receipt members a plugin's answer becomes: only those it gave, each of a valid shape. */
export interface IntelMembers { pattern_id?: string; intel?: string }
export interface IntelPlugin {
  version: string;
  /** The members for this action; empty when the plugin gave nothing usable in time. Never throws. */
  inspect(action: IntelAction): IntelMembers;
}

/** Where components of this kind are kept: `<home>/intel` (the version folders and `current`). */
export const intelDir = (home: string = userHome()): string => join(home, "intel");
/** The folder the hook loads from. */
export const intelCurrentDir = (home: string = userHome()): string => join(intelDir(home), "current");

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,5})$/;

/** The manifest when it has the closed shape, else null. */
export function readIntelManifest(value: unknown): IntelManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  for (const key of Object.keys(m)) if (!["version", "sha256", "signature", "key_id"].includes(key)) return null;
  if (typeof m.version !== "string" || !VERSION.test(m.version)) return null;
  if (typeof m.sha256 !== "string" || !HEX64.test(m.sha256)) return null;
  if (typeof m.signature !== "string" || m.signature.length === 0 || m.signature.length > 200) return null;
  if (m.key_id !== undefined && (typeof m.key_id !== "string" || m.key_id.length === 0 || m.key_id.length > 128)) return null;
  return { version: m.version, sha256: m.sha256, signature: m.signature, ...(typeof m.key_id === "string" ? { key_id: m.key_id } : {}) };
}

export type IntelCheck = { ok: true; manifest: IntelManifest; keyId: string } | { ok: false; reason: string };

/** Check a module's bytes against its manifest: the digest is the module's, and a pinned key valid now signed it. */
export function checkIntelComponent(manifest: IntelManifest, bytes: Buffer, options: { keys?: readonly PolicyKey[]; now?: Date } = {}): IntelCheck {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== manifest.sha256) return { ok: false, reason: "the module is not the one its manifest names" };
  const now = (options.now ?? new Date()).getTime();
  const keys = (options.keys ?? policyKeys()).filter((k) => (manifest.key_id === undefined || k.key_id === manifest.key_id)
    && now >= Date.parse(k.not_before) && now <= Date.parse(k.not_after));
  if (!keys.length) return { ok: false, reason: manifest.key_id ? `the manifest names a key this version does not trust now (${manifest.key_id})` : "no pinned key is valid now" };
  const message = Buffer.from(INTEL_COMPONENT_DOMAIN + manifest.sha256, "utf8");
  const signature = Buffer.from(manifest.signature, "base64");
  for (const key of keys) {
    const publicKey = publicKeyFrom(key.public_key);
    if (!publicKey) continue;
    try { if (verify(null, message, publicKey, signature)) return { ok: true, manifest, keyId: key.key_id }; } catch { /* the next key */ }
  }
  return { ok: false, reason: "the manifest's signature does not verify against a pinned key" };
}

/** Import an ES module from bytes already checked, never from the file again (it could change in between). Through a
 *  function compiled with Node's default loader for `import()`, so the same code works from npm and from the single
 *  executable (whose own code cannot `import()` a file). */
export async function importVerifiedModule(bytes: Buffer): Promise<Record<string, unknown>> {
  const load = compileFunction("return import(url)", ["url"], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER }) as (url: string) => Promise<Record<string, unknown>>;
  return load(`data:text/javascript;base64,${bytes.toString("base64")}`);
}

/** Why the plugin in `<home>/intel/current` is not used, or the check that let it load. Reads the files; loads nothing. */
export function intelComponentState(home: string = userHome(), options: { keys?: readonly PolicyKey[]; now?: Date } = {}): IntelCheck & { bytes?: Buffer } {
  const folder = intelCurrentDir(home);
  const moduleFile = join(folder, INTEL_MODULE);
  if (!existsSync(moduleFile)) return { ok: false, reason: "none" };
  let manifest: IntelManifest | null = null;
  try { manifest = readIntelManifest(JSON.parse(readFileSync(join(folder, INTEL_MANIFEST), "utf8"))); } catch { /* below */ }
  if (!manifest) return { ok: false, reason: "the manifest is missing or not readable" };
  let bytes: Buffer;
  try { bytes = readFileSync(moduleFile); } catch { return { ok: false, reason: "the module could not be read" }; }
  if (bytes.length > INTEL_MAX_BYTES) return { ok: false, reason: "the module is too large" };
  const checked = checkIntelComponent(manifest, bytes, options);
  return checked.ok ? { ...checked, bytes } : checked;
}

/** Load the plugin from `<home>/intel/current` when there is one and it verifies; null otherwise (and on any error). */
export async function loadIntelPlugin(home: string = userHome(), options: { keys?: readonly PolicyKey[]; now?: Date; budgetMs?: number; clock?: () => number } = {}): Promise<IntelPlugin | null> {
  try {
    const state = intelComponentState(home, options);
    if (!state.ok || !state.bytes) return null;
    const exported = await importVerifiedModule(state.bytes);
    const inspect = exported.inspect;
    if (typeof inspect !== "function") return null;
    return pluginFrom(state.manifest.version, inspect as (action: IntelAction) => unknown, options.budgetMs ?? INTEL_BUDGET_MS, options.clock);
  } catch { return null; }
}

/** Wrap a module's `inspect` so it never throws, never takes the action itself, and answers only within the budget. */
export function pluginFrom(version: string, inspect: (action: IntelAction) => unknown, budgetMs: number = INTEL_BUDGET_MS, clock: () => number = () => performance.now()): IntelPlugin {
  return {
    version,
    inspect(action: IntelAction): IntelMembers {
      let answer: unknown;
      const started = clock();
      try { answer = inspect(structuredClone({ action_type: action.action_type, params: action.params })); } catch { return {}; }
      if (clock() - started > budgetMs) return {};
      if (!answer || typeof answer !== "object" || typeof (answer as { then?: unknown }).then === "function") return {};
      const { pattern_id: patternId, slot } = answer as { pattern_id?: unknown; slot?: unknown };
      if ((patternId !== undefined && !isReceiptPatternId(patternId)) || (slot !== undefined && !isReceiptIntel(slot))) return {};
      return { ...(patternId !== undefined ? { pattern_id: patternId } : {}), ...(slot !== undefined ? { intel: slot } : {}) };
    },
  };
}
