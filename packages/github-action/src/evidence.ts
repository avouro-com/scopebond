// Verification evidence a workspace collector can read: the exact commit this run checked, the
// digests of what it checked against and produced, and the check result.
//
// This is a report from a runner, not a verification. The action runs in the repository owner's
// own workflow, under their control, so nothing here can establish that the result is
// independent. A collector decides whether to trust it by checking that the run came from a
// runner class it has registered; the document says so about itself (`independent: false`) and
// carries no field that could be read as a trust grant. It holds no credential, no key, no
// source text, no path list, and no pull request title or body.

import { createHash } from "node:crypto";
import { canonical } from "@scopebond/policy-schema/canonical";
import { SOURCE_RECEIPT_DOMAIN } from "@scopebond/policy-schema";
import type { PrDecision, PullRequestContext } from "./pr.js";

export const EVIDENCE_SCHEMA = "scopebond:action-evidence/v1";
export const CHECK_NAME = "Scopebond policy";

const GIT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export type CheckResult = "success" | "failure" | "neutral";

export interface ActionEvidence {
  schema: typeof EVIDENCE_SCHEMA;
  producer: { name: "@scopebond/github-action"; version: string; independent: false };
  repository: string;
  event: string;
  /** The pull request head this run checked, exactly as the event named it. */
  commit: string;
  /** Whether `commit` is a full git object id; anything else cannot identify a commit. */
  commit_exact: boolean;
  base_ref: string;
  pull_request?: { number: number };
  /** Digests of what was evaluated and what was produced. */
  artifacts: { policy_digest: string; receipt_hash?: string };
  check: { name: typeof CHECK_NAME; result: CheckResult; decision: PrDecision["decision"]; rule_ids: string[] };
  run: { id?: string; attempt?: string; workflow?: string; workflow_sha?: string; runner_environment?: string };
}

export interface EvidenceInput {
  ctx: PullRequestContext;
  policy: unknown;
  decision: PrDecision;
  /** The signed boundary receipt, when one was emitted. */
  receipt?: unknown;
  prNumber?: unknown;
  version: string;
  env?: Record<string, string | undefined>;
}

const bounded = (value: string | undefined, max = 200): string | undefined => (value !== undefined && value !== "" && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : undefined);

/** `success` for allow, `failure` for deny, `neutral` when the pull request was not evaluated. */
export const checkResult = (decision: PrDecision["decision"]): CheckResult => (decision === "allow" ? "success" : decision === "deny" ? "failure" : "neutral");

export function buildActionEvidence(input: EvidenceInput): ActionEvidence {
  const { ctx, decision } = input;
  const env = input.env ?? {};
  const run = Object.fromEntries(Object.entries({
    id: bounded(env.GITHUB_RUN_ID), attempt: bounded(env.GITHUB_RUN_ATTEMPT), workflow: bounded(env.GITHUB_WORKFLOW),
    workflow_sha: bounded(env.GITHUB_SHA), runner_environment: bounded(env.RUNNER_ENVIRONMENT),
  }).filter(([, v]) => v !== undefined));
  return {
    schema: EVIDENCE_SCHEMA,
    producer: { name: "@scopebond/github-action", version: input.version, independent: false },
    repository: ctx.repo, event: ctx.event, commit: ctx.headSha, commit_exact: GIT_ID.test(ctx.headSha), base_ref: ctx.base,
    ...(typeof input.prNumber === "number" && Number.isInteger(input.prNumber) && input.prNumber > 0 ? { pull_request: { number: input.prNumber } } : {}),
    artifacts: {
      policy_digest: sha256(canonical(input.policy as never)),
      ...(input.receipt === undefined ? {} : { receipt_hash: sha256(SOURCE_RECEIPT_DOMAIN + canonical(input.receipt as never)) }),
    },
    check: { name: CHECK_NAME, result: checkResult(decision.decision), decision: decision.decision, rule_ids: [...decision.ruleIds] },
    run,
  };
}
