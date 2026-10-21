// The sentence a person — and the coding agent they are supervising — sees when
// Scopebond blocks an action.
//
// The engine's own reason is precise and unreadable ("param ref fails pattern"):
// it names the mechanism, not the rule. The policy clause that decided already
// carries a written `description`, and the verdict names that clause, so both are
// available here. The composed message says what was blocked, which rule blocked
// it, why that rule exists, and where to change it — and it keeps the engine's
// detail so a surprising decision stays debuggable.
//
// This string is also fed back to the agent (Claude Code's
// `permissionDecisionReason`, Cursor's `agentMessage`), so a clear one lets the
// agent pick a different approach instead of retrying the same blocked call.

import { blockTitle, ruleOfClause } from "./rule-titles.js";
import { packRuleSaferWay } from "./pack-rules.js";
import { plainAction } from "./action-words.js";
import { BLOCKED_SERVICE_CLAUSES, BLOCKED_SERVICE_LABEL, blockedServiceKindOf, blockedServiceOf, isUnreadablePackageKey, type BlockedService } from "./service-rules.js";

/** A policy clause, as much of it as the message needs. */
export interface ExplainClause {
  id?: unknown;
  mode?: unknown;
  description?: unknown;
}

export interface ExplainPolicy {
  clauses?: unknown;
}

/** An intent, as much of it as the message needs. */
export interface ExplainIntent {
  action_type?: unknown;
  params?: unknown;
}

/** How long a clause description may run before it is cut. Long enough for the
 *  starter policy's first clause, short enough not to bury a terminal. */
const MAX_WHY = 300;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One line naming the action: `git.push origin main`, `shell.exec rm`,
 *  `file.read .env`. Shared with `log` so a decision reads the same in both. */
export function describeAction(intent: ExplainIntent | undefined): string {
  const type = str(intent?.action_type);
  const p = (intent?.params ?? {}) as Record<string, unknown>;
  const bits = type === "shell.exec" ? str(p.program)
    : type === "git.push" ? `${str(p.remote)} ${str(p.ref)}`.trim()
    : type === "file.write" || type === "file.read" ? str(p.path)
    : type === "mcp.tool.call" ? `${str(p.server)}/${str(p.tool)}`
    : type === "net.fetch" ? str(p.host)
    : type === "db.exec" ? `${str(p.scope)} ${str(p.provider)} ${str(p.verb)}`.trim()
    // The target actions (derived by the rule packs in force, packs.ts): the tool, then what it reaches.
    : type.startsWith("cloud.resource.") || type === "iam.change" ? `${str(p.via)} ${str(p.provider)} ${str(p.service)} ${str(p.kind)} ${str(p.env)}`.replace(/\s+/g, " ").trim()
    : type.startsWith("k8s.") ? `${str(p.via)} ${str(p.context)} ${str(p.namespace)} ${str(p.kind)}`.replace(/\s+/g, " ").trim()
    : type === "db.migrate" ? `${str(p.provider)} ${str(p.direction)} ${str(p.env)}`.trim()
    : type === "deploy.release" ? `${str(p.provider) || str(p.repo)} ${str(p.environment)}`.trim()
    : type === "secret.write" ? `${str(p.store)} ${str(p.env)}`.trim()
    : type === "communication.send" || type.startsWith("work.item.") ? str(p.provider)
    : type === "package.install" ? str(p.package_key) || `${str(p.manager)} ${str(p.name)}`.trim()
    // An install (typed-install.ts): how, then what and from where.
    : type === "software.install" ? `${str(p.route)} ${str(p.name)}${str(p.version) ? `@${str(p.version)}` : ""} ${str(p.source_domain)}`.replace(/\s+/g, " ").trim() : "";
  return `${type || "?"}${bits ? ` ${bits}` : ""}`;
}

/** Trim a description to one readable fragment, cut on a word boundary. */
function shorten(text: string, max = MAX_WHY): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:—-]$/, "")}…`;
}

/** Find the clause that decided, by the id the verdict reported. */
export function findClause(policy: ExplainPolicy | undefined, clauseId: string | null | undefined): ExplainClause | null {
  if (!clauseId || !Array.isArray(policy?.clauses)) return null;
  for (const clause of policy.clauses) {
    if (clause && typeof clause === "object" && str((clause as ExplainClause).id) === clauseId) {
      return clause as ExplainClause;
    }
  }
  return null;
}

export interface ExplainDenyInput {
  /** The loaded policy, for the deciding clause's own words. */
  policy?: ExplainPolicy;
  /** The clause id the verdict reported, when it reported one. */
  clauseId?: string | null;
  /** The engine's reason — kept verbatim as the technical detail. */
  detail: string;
  /** The action that was blocked. */
  intent?: ExplainIntent;
  /** Where the rule lives, so the next step is a real path. */
  policyPath?: string;
  /** How to change it, when there is something better to say than "edit this file" — the
   *  compiled policy is generated, so pointing a reader at it invites them to hand-edit
   *  something that will be overwritten. */
  remedy?: string;
  /** The harness reported this action only after it happened, so the decision records
   *  and flags it but did not prevent it. The wording must not claim otherwise. */
  postHoc?: boolean;
  /** The workspace's blocked services (service-rules.ts), to name the one a blocked-service clause denied. */
  services?: readonly BlockedService[];
  /** The record of this action (its action id), so the person can hand it to an admin who finds it in the workspace. */
  actionId?: string | null;
  /** The final instruction to the coding agent, by what the person can do about the block (`FINAL_INSTRUCTION`); absent: it
   *  stays blocked. */
  instruction?: string | null;
}

/** The final instruction the coding agent reads, by outcome, so it stops retrying and says the right thing. `unblock`: the
 *  person may let it through; `ask`: an admin decides; `stays`: a rule with no unblocking, Scopebond's own protection, a
 *  service the workspace blocks, or Safe Install; `quiet`: the person chose to keep it blocked. A remedy addressed to "you"
 *  read as an instruction to the agent to edit its own rules, which is itself blocked. */
export const FINAL_INSTRUCTION = {
  unblock: "The person can unblock it from the Scopebond icon; ask them, then try once more.",
  ask: "The person can ask an admin from the Scopebond icon; tell them, and wait for the answer before trying again.",
  stays: "It stays blocked. Don't retry or work around it; tell the person what you were trying to do.",
  quiet: "The person chose to keep this blocked; do not ask again or retry.",
} as const;

/** Scopebond's own protection: always on, never unblocked, whatever the workspace sets. */
const ALWAYS_ON = new Set(["protect-scopebond-read", "protect-scopebond-write"]);
const ALWAYS_ON_PERSON = "this is Scopebond's own protection, always on: no one can unblock it. The Scopebond icon lists it under Blocked.";

/** Compose the block message. With a clause it has five lines:
 *
 *    Scopebond blocked: <the action in plain words> ("<the rule's name>").
 *    Why: <the rule's one-line why>
 *    What to do: <the final instruction, by outcome>[ A safer way: <a rule pack rule's hint>]
 *    For the person: <where to act>
 *    Ref: <clause id> · <mode> · <record id> (<the engine's own reason>)
 *
 *  Without a description there is no Why line, and after the fact (post-hoc) no What to do line. With no clause at all (an
 *  undetermined verdict, a kill switch) it reports the engine's reason unchanged rather than inventing a rule that did not
 *  decide. */
export function explainDeny(input: ExplainDenyInput): string {
  const detail = input.detail.trim() || "denied";
  const clause = findClause(input.policy, input.clauseId);
  const clauseId = str(clause?.id) || str(input.clauseId);
  // "blocked" is a claim about prevention, so it is only used where the action really
  // was stopped in flight.
  const verb = input.postHoc ? "recorded an out-of-policy" : "blocked";
  if (!clauseId) {
    const action = describeAction(input.intent);
    return action ? `Scopebond ${verb} ${action}: ${detail}` : `Scopebond ${verb} action: ${detail}`;
  }
  const intent = input.intent as { action_type?: string; params?: Record<string, unknown> } | undefined;
  const words = (intent?.action_type ? plainAction(intent) : "") || describeAction(input.intent);
  const mode = str(clause?.mode) || "enforce";
  // A blocked service is the workspace's own choice, said plainly: which service, and that the workspace blocks it.
  const kind = blockedServiceKindOf(clauseId);
  let why: string;
  let person: string;
  if (kind) {
    const params = (input.intent?.params ?? {}) as Record<string, unknown>;
    const key = blockedServiceOf(kind, params, input.services ?? [])?.key ?? str(params[BLOCKED_SERVICE_CLAUSES[kind].param]);
    why = kind === "package" && isUnreadablePackageKey(params.package_key)
      ? `Your workspace blocks some ${str(params.manager)} packages, and the packages this install names could not be read.`
      : `Your workspace blocks the ${BLOCKED_SERVICE_LABEL[kind]} ${key}.`;
    person = "ask an admin of your Scopebond workspace to change the block.";
  } else {
    why = shorten(str(clause?.description));
    person = ALWAYS_ON.has(clauseId) ? ALWAYS_ON_PERSON : input.remedy ?? `edit clause "${clauseId}" in ${input.policyPath || "your Scopebond policy"}`;
  }
  // The rule by the name a person reads (the tray's).
  const title = blockTitle(ruleOfClause(clauseId), clauseId);
  // Scopebond's own protection and a blocked service stay blocked, whatever an override handler said.
  const instruction = ALWAYS_ON.has(clauseId) || kind ? FINAL_INSTRUCTION.stays : input.instruction || FINAL_INSTRUCTION.stays;
  // A rule pack's rule may name a safer way to get the same thing done (its `safer_way`): said after the instruction.
  const safer = ALWAYS_ON.has(clauseId) || kind ? null : packRuleSaferWay(clauseId);
  // The ids, the mode and the engine's own reason, last, so an admin can find the rule and the record, and support can match it.
  const ref = [clauseId, mode, str(input.actionId)].filter(Boolean).join(" · ") + (detail !== "denied" ? ` (${detail})` : "");
  const verbLine = input.postHoc ? "Scopebond recorded an out-of-policy action" : "Scopebond blocked";
  return [
    `${verbLine}: ${words || "an action"} ("${title}").`,
    ...(why ? [`Why: ${why}`] : []),
    ...(input.postHoc ? [] : [`What to do: ${instruction}${safer ? ` A safer way: ${safer}` : ""}`]),
    `For the person: ${person}`,
    `Ref: ${ref}`,
  ].join("\n");
}
