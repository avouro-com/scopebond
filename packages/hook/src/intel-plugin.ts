// The optional plugin slot. A computer may hold one signed module the hook asks about each action before it is decided:
// `<home>/intel/current/intel.mjs`, beside `manifest.json` (`{ version, sha256, signature, key_id? }`). The module is
// loaded only when the manifest's SHA-256 is the module's and its signature verifies against a pinned policy key
// (policy-keys.ts) over "scopebond:component/intel/v1\n" followed by that SHA-256. Anything else and there is no plugin.
//
// The module exports `inspect(action)`, which returns `{ pattern_id, slot }` or nothing: a pattern id (64 lowercase hex)
// and an opaque slot (base64 of at most 4 KiB). The hook signs them into the action's receipt as `pattern_id` and `intel`
// and never reads what the slot holds. `inspect` is called synchronously, with a copy of the action, and must answer
// within INTEL_BUDGET_MS, beyond which the calls of one process may run INTEL_COLD_ALLOWANCE_MS in all while its code runs for
// the first time: a throw, a promise, an answer of the wrong shape or one that took longer gives no slot. It never changes the
// decision.
//
// The hook runs once per tool call, so loading the module is paid on every call. The checked bytes are handed to Node's module
// loader from memory (`module.registerHooks`, where Node has it) rather than as a `data:` URL, which Node decodes slowly.
//
// The module may also export `artifactKinds` (the kinds of signed artifact it reads, at most MAX_ARTIFACT_KINDS) and
// `acceptArtifact(artifact)`: when it loads, it is handed each signed artifact this computer holds of one of those kinds
// (signed-artifacts.ts: checked against its signed list and its signature when it was fetched, and against that digest now) as
// `{ kind, id, version, shadow, bytes }`, the exact bytes served, which the hook never reads. A throw or a promise is ignored.
//
// Without the module (any build of this repository, or a computer that has none), nothing is loaded, no member is added,
// and every receipt is exactly what it was before.

import { createHash, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { join } from "node:path";
import { compileFunction, constants as vmConstants } from "node:vm";
import { isReceiptIntel, isReceiptPatternId } from "@scopebond/policy-schema";
import { policyKeys, publicKeyFrom, type PolicyKey } from "./policy-keys.js";
import { userHome } from "./install.js";
import type { HeldArtifact } from "./signed-artifacts.js";

/** What the signature covers: this domain, then the module's SHA-256 (64 lowercase hex). */
export const INTEL_COMPONENT_DOMAIN = "scopebond:component/intel/v1\n";
/** How long `inspect` may take for one action, in milliseconds. */
export const INTEL_BUDGET_MS = 2;
/** How much longer than INTEL_BUDGET_MS the calls of one process may take in all, in milliseconds: the module's code runs for
 *  the first time in each process, so its first calls are slower (a module that prepared itself while loading would only move
 *  that time into the load, which has no budget at all). */
export const INTEL_COLD_ALLOWANCE_MS = 25;
/** The largest module the hook reads. */
export const INTEL_MAX_BYTES = 8 * 1024 * 1024;
export const INTEL_MODULE = "intel.mjs";
export const INTEL_MANIFEST = "manifest.json";
/** The most artifact kinds a plugin may say it reads. */
export const MAX_ARTIFACT_KINDS = 20;

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

/** The URL scheme the checked bytes are served under from memory. */
const MEMORY_SCHEME = "scopebond-plugin:";
/** Checked module bytes by their memory URL, once the loader hooks are in place; null where Node cannot serve from memory. */
let fromMemory: Map<string, Buffer> | null | undefined;

/** Serve modules from memory: a resolve and a load hook for this scheme alone (every other specifier goes on unchanged). */
function memoryModules(): Map<string, Buffer> | null {
  if (fromMemory !== undefined) return fromMemory;
  const register = (nodeModule as { registerHooks?: typeof nodeModule.registerHooks }).registerHooks;
  if (typeof register !== "function") return (fromMemory = null);
  const modules = new Map<string, Buffer>();
  try {
    register({
      resolve: (specifier, context, nextResolve) => (modules.has(specifier) ? { url: specifier, format: "module", shortCircuit: true } : nextResolve(specifier, context)),
      load: (url, context, nextLoad) => {
        const source = modules.get(url);
        return source ? { format: "module", source, shortCircuit: true } : nextLoad(url, context);
      },
    });
  } catch { return (fromMemory = null); }
  return (fromMemory = modules);
}

/** Import an ES module from bytes already checked, never from the file again (it could change in between). Through a
 *  function compiled with Node's default loader for `import()`, so the same code works from npm and from the single
 *  executable (whose own code cannot `import()` a file). The bytes are served from memory under a URL named by their
 *  SHA-256 (`via: "data"`, or a Node without `module.registerHooks`: a `data:` URL, which costs several milliseconds more
 *  for a module of some size). */
export async function importVerifiedModule(bytes: Buffer, options: { via?: "memory" | "data" } = {}): Promise<Record<string, unknown>> {
  const load = withoutLoaderNotice(() => compileFunction("return import(url)", ["url"], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER })) as (url: string) => Promise<Record<string, unknown>>;
  const viaData = (): Promise<Record<string, unknown>> => load(`data:text/javascript;base64,${bytes.toString("base64")}`);
  const modules = options.via === "data" ? null : memoryModules();
  if (!modules) return viaData();
  const url = `${MEMORY_SCHEME}${createHash("sha256").update(bytes).digest("hex")}`;
  if (!modules.has(url)) modules.set(url, Buffer.from(bytes));
  // A loader that does not reach the hooks (a build of Node that resolves the scheme itself) refuses the URL: the data: URL
  // still works there. A module that fails to load fails both ways.
  try { return await load(url); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_UNSUPPORTED_ESM_URL_SCHEME") return viaData();
    throw error;
  }
}

/** Run `compile` without Node's one-time notice that the default-loader constant is experimental: printed on stderr, it
 *  would land in the agent's transcript on every call. Any other warning still prints. */
function withoutLoaderNotice<T>(compile: () => T): T {
  const handlers = process.listeners("warning");
  const drop = (warning: Error): void => {
    if (warning.name === "ExperimentalWarning" && /USE_MAIN_CONTEXT_DEFAULT_LOADER/.test(warning.message)) return;
    for (const handler of handlers) handler.call(process, warning);
  };
  process.removeAllListeners("warning");
  process.on("warning", drop);
  try { return compile(); } finally {
    // Node emits the warning on the next tick: keep the filter until then, then put the handlers back as they were.
    process.nextTick(() => {
      process.removeListener("warning", drop);
      for (const handler of handlers) process.on("warning", handler);
    });
  }
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

/** Load the plugin from `<home>/intel/current` when there is one and it verifies; null otherwise (and on any error).
 *  `artifacts` gives the signed artifacts held of the kinds the plugin reads (signed-artifacts.ts `heldArtifacts`). */
export async function loadIntelPlugin(home: string = userHome(), options: { keys?: readonly PolicyKey[]; now?: Date; budgetMs?: number; clock?: () => number; artifacts?: (kinds: readonly string[]) => HeldArtifact[] } = {}): Promise<IntelPlugin | null> {
  try {
    const state = intelComponentState(home, options);
    if (!state.ok || !state.bytes) return null;
    const exported = await importVerifiedModule(state.bytes);
    const inspect = exported.inspect;
    if (typeof inspect !== "function") return null;
    if (options.artifacts) handArtifacts(exported, options.artifacts);
    return pluginFrom(state.manifest.version, inspect as (action: IntelAction) => unknown, options.budgetMs ?? INTEL_BUDGET_MS, options.clock);
  } catch { return null; }
}

/** The artifact kinds a module says it reads: its `artifactKinds` when that is a short list of kind names, else none. */
export function artifactKindsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_KINDS) return [];
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, a bounded run of one class with an optional repeat of separators
  return [...new Set(value.filter((k): k is string => typeof k === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(k)))];
}

/** Hand a module the held artifacts of the kinds it reads, through its `acceptArtifact`; each call on its own, never awaited,
 *  and a throw or a rejected promise is ignored. Returns how many were handed over. Never throws. */
export function handArtifacts(exported: Record<string, unknown>, held: (kinds: readonly string[]) => HeldArtifact[]): number {
  try {
    const accept = exported.acceptArtifact;
    const kinds = artifactKindsOf(exported.artifactKinds);
    if (typeof accept !== "function" || !kinds.length) return 0;
    let handed = 0;
    for (const artifact of held(kinds)) {
      if (!kinds.includes(artifact.kind)) continue;
      try {
        const answer: unknown = accept({ kind: artifact.kind, id: artifact.id, version: artifact.version, shadow: artifact.shadow, bytes: new Uint8Array(artifact.bytes) });
        if (answer && typeof (answer as { then?: unknown }).then === "function") (answer as Promise<unknown>).then(undefined, () => undefined);
        handed++;
      } catch { /* the plugin's own problem: the next artifact */ }
    }
    return handed;
  } catch { return 0; }
}

/** Wrap a module's `inspect` so it never throws, never takes the action itself, and answers only within the budget: each call
 *  `budgetMs`, and over all calls together at most `coldAllowanceMs` beyond it. A call that takes longer than what is left gives
 *  no slot and ends the allowance. */
export function pluginFrom(version: string, inspect: (action: IntelAction) => unknown, budgetMs: number = INTEL_BUDGET_MS, clock: () => number = () => performance.now(), coldAllowanceMs: number = INTEL_COLD_ALLOWANCE_MS): IntelPlugin {
  let cold = coldAllowanceMs;
  /** Whether a call that took `took` ms is within its budget; charges the time over the budget to the allowance. */
  const within = (took: number): boolean => {
    const over = took - budgetMs;
    if (over <= 0) return true;
    if (over > cold) { cold = 0; return false; }
    cold -= over;
    return true;
  };
  return {
    version,
    inspect(action: IntelAction): IntelMembers {
      let answer: unknown;
      const started = clock();
      try { answer = inspect(structuredClone({ action_type: action.action_type, params: action.params })); } catch { within(clock() - started); return {}; }
      if (!within(clock() - started)) return {};
      if (!answer || typeof answer !== "object" || typeof (answer as { then?: unknown }).then === "function") return {};
      const { pattern_id: patternId, slot } = answer as { pattern_id?: unknown; slot?: unknown };
      if ((patternId !== undefined && !isReceiptPatternId(patternId)) || (slot !== undefined && !isReceiptIntel(slot))) return {};
      return { ...(patternId !== undefined ? { pattern_id: patternId } : {}), ...(slot !== undefined ? { intel: slot } : {}) };
    },
  };
}
