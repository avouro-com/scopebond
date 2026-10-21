// Local rule packs: packs a person or a team writes and names in this computer's rules file, beside the packs Scopebond Cloud
// delivers (pack-store.ts).
//
// Where they are named: `rules.json` (the readable rules file beside policy.json) may say
//
//   "packs": { "local": ["team-packs/my-team.json", …], "trusted_keys": [{ key_id, public_key, not_before, not_after }] }
//
// Each path is read relative to the folder that holds the rules file (an absolute path is read as it is). The trust root is the
// rules file itself: whoever can edit it can add a pack, so a local pack needs no Cloud signature. With `trusted_keys`, every local
// pack must also carry a signature (the format's own, over `scopebond:pack/v1`) that verifies with one of those keys, so a pack
// file kept where others can write it cannot be changed unnoticed.
//
// A local pack is the same format and runs on the same engine as a delivered one, and is checked the same way: at most 4 MiB,
// the closed format at this engine's level (`signature` may be left out), an engine level this hook reads, action types it
// knows, and every one of its vectors passing on this version. A pack that fails is skipped and named (`packs list`, `status`,
// `doctor`); the other packs stay in force.
//
// A local pack only adds:
//   - a delivered pack with the same id wins, and the local one is skipped (`id_taken`);
//   - a delivered pack reads a command, owns an MCP server and defines a rule id before any local pack (packs.ts);
//   - each of its rules must have an id of its own, and may name a type of call (a command, a file read or write, a push…)
//     only when the policy already covers that type (pack-rules.ts `localRuleProblem`); otherwise the pack is skipped
//     (`rule_not_added`). The runtime checks the same again against the policy it enforces, so a rule that slips past this
//     report never joins.
// Local packs may not live in the delivered packs folder (`packs/`): a check-in rewrites that folder (`in_pack_cache`).

import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PACK_LIMITS, packEngineProblem, packRef, packRequiredEngine, packSigningInput, validatePack, type Pack } from "@scopebond/policy-schema/pack";
import { getActionType } from "@scopebond/policy-schema/registry";
import { baseKeyProblem, type PolicyKey } from "./policy-keys.js";
import { coveredTypes, localRuleProblem } from "./pack-rules.js";
import { runPackVectors } from "./packs.js";
import { loadRules } from "./rules.js";
import { packEngineLevel, packsDir, verifySignedData, type PackCheckOptions, type PackRefusal } from "./pack-store.js";
import { readBounded } from "./safe-fs.js";
import { writeAtomic } from "./managed.js";
import { hookVersion } from "./version.js";

/** The most local packs a rules file may name. */
export const MAX_LOCAL_PACKS = 20;

/** Why a local pack was not used: a pack-store.ts refusal, or one of the local checks. */
export type LocalPackRefusal = PackRefusal | "vectors_failed" | "unsigned" | "id_taken" | "rule_not_added" | "in_pack_cache" | "duplicate" | "too_many";

/** What the rules file says about local packs. */
export interface LocalPackConfig { local: string[]; trusted_keys: PolicyKey[]; problems: string[] }

export interface LocalPackProblem { file: string; ref: string | null; reason: LocalPackRefusal; message: string }

export interface LocalPacks {
  packs: Pack[];
  /** The file each local pack in force was read from, by `<id>@<version>`, as the rules file names it. */
  files: Record<string, string>;
  problems: LocalPackProblem[];
}

const NONE: LocalPacks = { packs: [], files: {}, problems: [] };

/** The local packs the rules file in `dir` names, and the keys their signatures must verify with. None when the file names
 *  none (or cannot be read: then the hook fails closed on its own). */
export function localPackConfig(dir: string): LocalPackConfig {
  const packs = (loadRules(dir) as { packs?: unknown } | null)?.packs as { local?: unknown; trusted_keys?: unknown } | undefined;
  const problems: string[] = [];
  const local = Array.isArray(packs?.local) ? packs.local.filter((p): p is string => typeof p === "string" && p.trim() !== "") : [];
  const keys: PolicyKey[] = [];
  if (packs?.trusted_keys !== undefined) {
    if (!Array.isArray(packs.trusted_keys)) problems.push("packs.trusted_keys is not a list; no local pack is used");
    else for (const entry of packs.trusted_keys) {
      const problem = baseKeyProblem(entry);
      if (problem) problems.push(`packs.trusted_keys: ${problem}`); else keys.push(entry as PolicyKey);
    }
  }
  return { local, trusted_keys: keys, problems };
}

/** What checking a local pack takes: the engine level, the keys its signature must verify with (none: not checked), and
 *  whether to run its vectors (default yes; `packs test` runs them itself to report each one). */
export interface LocalPackCheckOptions { engine?: number; keys?: readonly PolicyKey[]; requireSignature?: boolean; now?: Date; vectors?: boolean }

/** Check a local pack from text, as a delivered pack is checked: its size, the closed format at this engine's level (its
 *  `signature` may be left out), the engine level and action types it needs, its signature when keys are required, and every
 *  one of its vectors. Pure apart from reading the registry. */
export function checkLocalPackText(text: string, options: LocalPackCheckOptions = {}): { ok: true; pack: Pack } | { ok: false; reason: LocalPackRefusal; message: string } {
  if (Buffer.byteLength(text, "utf8") > PACK_LIMITS.maxBytes) return { ok: false, reason: "too_large", message: `the pack is larger than ${PACK_LIMITS.maxBytes} bytes` };
  let doc: unknown;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return { ok: false, reason: "invalid", message: "the pack is not JSON" }; }
  const level = options.engine ?? packEngineLevel();
  const needs = packRequiredEngine(doc);
  if (needs !== null && needs > level) return { ok: false, reason: "engine_too_old", message: `the pack needs pack engine level ${needs}; this version reads level ${level}; update Scopebond` };
  const shape = validatePack(doc, { engine: level, unsigned: true });
  if (!shape.valid) return { ok: false, reason: "invalid", message: `the pack is not a valid scopebond:pack/v1 document (${shape.errors.slice(0, 3).join("; ")})` };
  const pack = doc as Pack;
  const problem = packEngineProblem(pack, level, (type) => getActionType(type) !== undefined);
  if (problem?.reason === "unknown_action_type") return { ok: false, reason: "unknown_action_type", message: `the pack emits action type ${problem.needs}, which this computer does not know` };
  if (options.requireSignature) {
    if (!pack.signature) return { ok: false, reason: "unsigned", message: "the rules file lists trusted_keys, and this pack carries no signature" };
    const signed = verifySignedData(packSigningInput(pack as unknown as Record<string, unknown>), pack.issued_at, pack.signature, "pack", { keys: [...(options.keys ?? [])], now: options.now });
    if (!signed.ok) return { ok: false, reason: signed.reason, message: `${signed.message.replace(/; update Scopebond$/, "")} (the rules file's trusted_keys)` };
  }
  if (options.vectors === false) return { ok: true, pack };
  const run = runPackVectors(pack);
  if (run.failures.length) return { ok: false, reason: "vectors_failed", message: `${run.failures.length} of the pack's ${pack.vectors.length} vectors do not pass on this version (first: ${run.failures[0].id})` };
  return { ok: true, pack };
}

/** The rule ids a policy file's clauses use and the action types they cover; empty when it cannot be read. */
function policyFacts(dir: string): { ids: Set<string>; clauses: unknown[] } {
  try {
    const text = readBounded(join(dir, "policy.json"), 4 * 1024 * 1024);
    const clauses = (JSON.parse((text ?? "").replace(/^\uFEFF/, "")) as { clauses?: unknown })?.clauses;
    if (!Array.isArray(clauses)) return { ids: new Set(), clauses: [] };
    return { ids: new Set(clauses.map((c) => String((c as { id?: unknown })?.id))), clauses };
  } catch { return { ids: new Set(), clauses: [] }; }
}

/** Where the hook keeps the digests of the local pack files whose vectors passed on this version and engine level, so a tool
 *  call does not run them again for a file that has not changed. Losing it only means the vectors run once more. */
export const LOCAL_PACKS_CHECKED_FILE = "local-packs-checked.json";

/** The digests of the pack files whose vectors passed with this engine (`<hook version>/<engine level>`); empty otherwise. */
function readChecked(dir: string, engine: string): Set<string> {
  try {
    const doc = JSON.parse(readBounded(join(dir, LOCAL_PACKS_CHECKED_FILE), 64 * 1024) ?? "") as { v?: unknown; engine?: unknown; passed?: unknown };
    if (doc?.v !== 1 || doc.engine !== engine || !Array.isArray(doc.passed)) return new Set();
    return new Set(doc.passed.filter((d): d is string => typeof d === "string" && /^[0-9a-f]{64}$/.test(d)).slice(0, MAX_LOCAL_PACKS));
  } catch { return new Set(); }
}

/** The local packs the rules file in `dir` names that may be used beside the delivered packs in force (`delivered`), and why
 *  any other is not. A pack file's vectors run once per version of this hook (`LOCAL_PACKS_CHECKED_FILE`). Never throws. */
export function loadLocalPacks(dir: string, delivered: readonly Pack[] = [], options: PackCheckOptions = {}): LocalPacks {
  try {
    const config = localPackConfig(dir);
    if (config.local.length === 0) return NONE;
    const problems: LocalPackProblem[] = [];
    if (config.problems.length) {
      for (const file of config.local) problems.push({ file, ref: null, reason: "invalid", message: config.problems[0] });
      return { packs: [], files: {}, problems };
    }
    const policy = policyFacts(dir);
    const deliveredIds = new Set(delivered.map((p) => p.id));
    const deliveredRules = delivered.flatMap((p) => p.rules);
    const taken = new Set([...policy.ids, ...deliveredRules.map((r) => String(r.id))]);
    const covered = coveredTypes([...policy.clauses, ...deliveredRules]);
    const cache = resolve(packsDir(dir));
    const engine = `${hookVersion()}/${options.engine ?? packEngineLevel()}`;
    const checkedBefore = readChecked(dir, engine);
    const passed = new Set<string>();
    const packs: Pack[] = [];
    const files: Record<string, string> = {};
    for (const [n, file] of config.local.entries()) {
      if (n >= MAX_LOCAL_PACKS) { problems.push({ file, ref: null, reason: "too_many", message: `the rules file names more than ${MAX_LOCAL_PACKS} local packs; the rest are not used` }); continue; }
      const full = resolve(isAbsolute(file) ? file : join(dir, file));
      const inside = relative(cache, full);
      if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
        problems.push({ file, ref: null, reason: "in_pack_cache", message: "the file is in the delivered packs folder, which a check-in rewrites; keep local packs in another folder" });
        continue;
      }
      let text: string | null;
      try { text = readBounded(full, PACK_LIMITS.maxBytes); } catch { problems.push({ file, ref: null, reason: "missing", message: "the file cannot be read" }); continue; }
      if (text === null) { problems.push({ file, ref: null, reason: "too_large", message: `the pack is larger than ${PACK_LIMITS.maxBytes} bytes` }); continue; }
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      const checked = checkLocalPackText(text, { engine: options.engine, keys: config.trusted_keys, requireSignature: config.trusted_keys.length > 0, now: options.now, vectors: !checkedBefore.has(digest) });
      if (!checked.ok) { problems.push({ file, ref: null, reason: checked.reason, message: checked.message }); continue; }
      passed.add(digest);
      const pack = checked.pack;
      const ref = packRef(pack);
      if (deliveredIds.has(pack.id)) { problems.push({ file, ref, reason: "id_taken", message: `a pack delivered by your workspace has the id ${pack.id}; it is used instead` }); continue; }
      if (packs.some((p) => p.id === pack.id)) { problems.push({ file, ref, reason: "duplicate", message: `another local pack named earlier has the id ${pack.id}` }); continue; }
      const ruleProblem = pack.rules.map((r) => localRuleProblem(r, taken, covered)).find((p) => p !== null);
      if (ruleProblem) { problems.push({ file, ref, reason: "rule_not_added", message: ruleProblem }); continue; }
      for (const rule of pack.rules) taken.add(String(rule.id));
      packs.push(pack);
      files[ref] = file;
    }
    if (passed.size !== checkedBefore.size || [...passed].some((d) => !checkedBefore.has(d))) {
      try { writeAtomic(join(dir, LOCAL_PACKS_CHECKED_FILE), `${JSON.stringify({ v: 1, engine, passed: [...passed].sort() })}
`); } catch { /* the vectors run again next time */ }
    }
    return { packs, files, problems };
  } catch {
    return NONE;
  }
}

/** One line per local pack for `status` and `doctor`: those in force, and those not used and why. */
export function describeLocalPacks(local: LocalPacks): { inForce: string[]; notUsed: string[] } {
  return {
    inForce: local.packs.map((p) => `${packRef(p)} (${local.files[packRef(p)]})`),
    notUsed: local.problems.map((p) => `${p.file}${p.ref ? ` (${p.ref})` : ""}: ${p.message}`),
  };
}
