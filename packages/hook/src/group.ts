// Canonical action groups.
//
// One tool call can map to several intents: a shell command, the files it reads and
// writes, every destination of a multi-ref push, each spelling of an ambiguous Windows
// short path. Each intent is its own signed receipt; without a shared parent id a
// consumer can only count them as unrelated actions or guess that they belong together.
//
// The group id rides inside the intent's `params` (`action_group`, `action_group_size`,
// `action_group_seq`). `params` is the extensible, signed part of an intent — the
// receipt schema allows undeclared adapter parameters there — so this adds no
// top-level receipt key and changes no receipt that already exists. Because the group
// is part of the signed intent, the machine key that authenticates the action
// authenticates its linkage too; nothing links receipts heuristically.
//
// The id is derived from the harness's own tool-call id when it supplies one (so a
// retried call keeps its group) and is random otherwise. Distinct calls never share an
// id: the derivation is a one-way hash of the key, never a shared prefix.

import { createHash, randomBytes } from "node:crypto";
import type { Mapped } from "./map.js";

export const ACTION_GROUP_PARAM = "action_group";
export const ACTION_GROUP_SIZE_PARAM = "action_group_size";
export const ACTION_GROUP_SEQ_PARAM = "action_group_seq";

/** A new group id. With a harness call id the result is stable for that id. */
export function actionGroupId(key?: string): string {
  if (key !== undefined && key !== "") {
    return `sbg_${createHash("sha256").update(`scopebond:action-group:v1\0${key}`).digest("hex").slice(0, 32)}`;
  }
  return `sbg_${randomBytes(16).toString("hex")}`;
}

/** Stamp every intent of one call with the shared group id, its position and the count. */
export function withActionGroup(mapped: Mapped[], groupId: string): Mapped[] {
  return mapped.map((m, index) => ({
    ...m,
    intent: {
      ...m.intent,
      params: {
        ...m.intent.params,
        [ACTION_GROUP_PARAM]: groupId,
        [ACTION_GROUP_SIZE_PARAM]: mapped.length,
        [ACTION_GROUP_SEQ_PARAM]: index,
      },
    },
  }));
}

/** The physical targets of a group, each counted once, for consumers that total actions
 *  by physical target (a target reached by two spellings or two intents counts once). */
export function distinctTargets(mapped: Mapped[]): string[] {
  const seen = new Set<string>();
  for (const m of mapped) {
    const path = m.intent.params.path;
    if (typeof path === "string" && path !== "") seen.add(`${m.intent.action_type.startsWith("file.") ? "file" : m.intent.action_type}:${path.toLowerCase()}`);
  }
  return [...seen];
}
