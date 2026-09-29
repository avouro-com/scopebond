#!/usr/bin/env node
// scopebond-verify-pr — the required "Scopebond policy" status check. Runs in the
// customer's Actions runner: reads the pull_request event, the changed paths and
// the policy, evaluates, and exits non-zero to block the merge on a deny. A
// configuration error fails closed (deny).
//
// The policy is read from the pull request's BASE commit (`git show <base.sha>:<path>`),
// never from the checked-out head: otherwise an agent's pull request could rewrite the
// policy it is checked against and pass its own check. A PR that introduces or changes
// the policy is therefore checked against the policy already on the base branch.
//
//   scopebond-verify-pr [--policy scopebond.policy.json] [--event <event.json>] [--paths-file <list>]
//                       [--policy-source base|workspace]   (workspace: local testing only)
//
// Env: GITHUB_EVENT_PATH, GITHUB_EVENT_NAME, SCOPEBOND_POLICY, SCOPEBOND_POLICY_SOURCE, GITHUB_OUTPUT.

import { execFileSync } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { validatePolicy } from "@scopebond/verify";
import { evaluatePullRequest } from "./pr.js";
import { buildPullRequestReceipt } from "./receipt.js";
import type { PullRequestContext } from "./pr.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function die(message: string): never { console.error(`Scopebond: ${message}`); process.exit(1); }

const eventPath = arg("--event", process.env.GITHUB_EVENT_PATH);
const policyPath = arg("--policy", process.env.SCOPEBOND_POLICY ?? "scopebond.policy.json");
const pathsFile = arg("--paths-file", process.env.SCOPEBOND_PR_PATHS);

if (!eventPath) die("no GitHub event available (set GITHUB_EVENT_PATH or --event)");

let event: Record<string, any>;
let policy: unknown;
try { event = JSON.parse(readFileSync(eventPath as string, "utf8")); }
catch (e) { die(`could not read the event payload: ${(e as Error).message}`); }
const policySource = arg("--policy-source", process.env.SCOPEBOND_POLICY_SOURCE || "base");
if (policySource !== "base" && policySource !== "workspace") die(`--policy-source must be "base" or "workspace", not "${policySource}"`);

const git = (args: string[]): string => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The policy as committed on the pull request's base, fetching that commit if the
 *  checkout is shallow. Any failure is fatal: evaluating without the base policy — or
 *  against the head's copy — would let the pull request choose its own rules. */
function readBasePolicy(baseSha: string, path: string): string {
  let repoPath = path.replace(/\\/g, "/");
  if (isAbsolute(path)) repoPath = relative(git(["rev-parse", "--show-toplevel"]).trim(), path).replace(/\\/g, "/");
  repoPath = repoPath.replace(/^\.\//, "");
  const spec = `${baseSha}:${repoPath}`;
  try { return git(["show", spec]); } catch { /* not present locally yet */ }
  try { git(["fetch", "--no-tags", "--depth=1", "origin", baseSha]); } catch { /* reported below */ }
  try { return git(["show", spec]); }
  catch { die(`the policy ${repoPath} is not on the base commit ${baseSha.slice(0, 12)} — the check reads the policy from the base branch so a pull request cannot change its own rules; merge the policy to the base branch first`); }
}

try {
  if (policySource === "workspace") policy = JSON.parse(readFileSync(policyPath as string, "utf8"));
  else {
    const baseSha = event!.pull_request?.base?.sha;
    if (typeof baseSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(baseSha)) die("the event has no pull_request.base.sha, so the base-branch policy cannot be read (fail closed)");
    policy = JSON.parse(readBasePolicy(baseSha, policyPath as string));
  }
}
catch (e) { die(`could not read the policy ${policyPath}: ${(e as Error).message}`); }

if (!validatePolicy(policy).valid) die(`policy ${policyPath} is invalid (fail closed)`);

const pr = event!.pull_request ?? {};
let paths: string[] = [];
if (pathsFile) {
  try { paths = readFileSync(pathsFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
  catch (e) { die(`could not read the changed-paths file: ${(e as Error).message}`); }
}
paths = [...new Set(paths)];

const ctx: PullRequestContext = {
  event: process.env.GITHUB_EVENT_NAME ?? "pull_request",
  repo: event!.repository?.full_name ?? "",
  base: pr.base?.ref ?? "",
  head: pr.head?.ref ?? "",
  headSha: pr.head?.sha ?? "",
  paths,
  filesChanged: typeof pr.changed_files === "number" ? pr.changed_files : paths.length,
  additions: typeof pr.additions === "number" ? pr.additions : 0,
  deletions: typeof pr.deletions === "number" ? pr.deletions : 0,
  actor: pr.user?.login ?? event!.sender?.login ?? "",
};

// Fail closed if the diff step could not produce paths for a PR that changed
// files — an empty path set must not be mistaken for "touches nothing".
if (ctx.paths.length === 0 && ctx.filesChanged > 0) {
  die("the pull request changed files but no paths were resolved (diff step failed); failing closed");
}
// Fail closed on a partial list too: the pull-request files API stops at 3000 files,
// so a larger PR would otherwise be judged on the files it happened to list while an
// out-of-policy path hides past the cut-off.
if (ctx.paths.length < ctx.filesChanged) {
  die(`the pull request changed ${ctx.filesChanged} files but only ${ctx.paths.length} paths were resolved (the file list was truncated); failing closed`);
}

const decision = evaluatePullRequest(ctx, policy);

const line = `${decision.decision.toUpperCase()} — ${decision.reason}`;
console.log(`Scopebond policy: ${line}`);
if (decision.attribution) console.log(`  agent: ${decision.attribution.actor} (${decision.attribution.kind})`);
if (decision.ruleIds.length) console.log(`  rules: ${decision.ruleIds.join(", ")}`);

// Optionally emit a signed boundary receipt (customer's own key). Only for a
// governed-agent decision; a not_evaluated PR gets none.
const keyPem = arg("--key") ?? process.env.SCOPEBOND_ATTESTER_KEY;
const receiptOut = arg("--receipt-out") ?? process.env.SCOPEBOND_RECEIPT_OUT;
if (keyPem && decision.attribution && decision.decision !== "not_evaluated") {
  let receipt: Awaited<ReturnType<typeof buildPullRequestReceipt>>;
  try {
    receipt = await buildPullRequestReceipt(ctx, policy, decision, keyPem);
    if (receiptOut) writeFileSync(receiptOut, JSON.stringify(receipt) + "\n");
    console.log(`  receipt: boundary/${decision.decision} @ ${ctx.headSha}${receiptOut ? ` → ${receiptOut}` : ""}`);
  } catch (e) {
    die(`could not emit the boundary receipt: ${(e as Error).message}`);
  }
  // Optionally mirror the boundary receipt to a Scopebond workspace. Best-effort:
  // export is evidence, not enforcement — the required check already gated the merge,
  // so a Cloud outage must never fail the check. Credentials come from repo secrets.
  const cloudUrl = process.env.SCOPEBOND_CLOUD_URL;
  const cloudCred = process.env.SCOPEBOND_CLOUD_CREDENTIAL;
  if (cloudUrl && cloudCred) {
    try {
      const res = await fetch(cloudUrl.replace(/\/+$/, "") + "/v1/ingest", {
        method: "POST",
        headers: { authorization: "Bearer " + cloudCred, "content-type": "application/json" },
        body: JSON.stringify({ receipts: [receipt] }),
      });
      console.log(res.ok ? `  exported to ${cloudUrl}` : `  cloud export failed: HTTP ${res.status} (the check still gated the merge)`);
    } catch (e) {
      console.log(`  cloud export failed: ${(e as Error).message} (the check still gated the merge)`);
    }
  }
}

if (process.env.GITHUB_OUTPUT) {
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `decision=${decision.decision}\nreason=${decision.reason}\naction_type=${decision.actionType}\n`);
  } catch { /* outputs are best-effort */ }
}

// A deny fails the required check and blocks the merge; allow and not_evaluated pass.
process.exit(decision.decision === "deny" ? 1 : 0);
