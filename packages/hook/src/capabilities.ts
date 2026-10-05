// Capability manifest: what this installed hook can honestly claim, cell by cell.
//
// A cell is keyed by connector + adapter version + host variant + action type + event
// phase. There is no global "supported" boolean: a connection can have verified shell
// coverage and unsupported browser coverage at the same time, and Codex, Claude Code and
// Cursor are separate cells because they hook different events at different times.
//
// The state is computed, never asserted:
//
//   unsupported            the adapter has no hook for this action, or it is known to
//                          escape interception (nested tool orchestration)
//   inactive               the adapter could cover it, but the harness is not configured
//   configured_unverified  configured, and either never proven or proven only by fixture
//   verified_reporting     a recorded proof that is current, passed, came from a real
//                          harness run, and was acknowledged by Cloud
//   degraded               a recorded proof for the current adapter and vectors failed
//   retired                a cell kept for history whose adapter no longer ships
//
// Only `verified_reporting` claims coverage. A local fixture run proves the adapter, the
// policy and the signatures on this machine; it does not prove that a particular host
// (Codex desktop, Claude desktop, Cursor) delivers the event, and it does not prove Cloud
// received the receipt, so a fixture proof alone never produces `verified_reporting`.
// For an observation-only action (Cursor's after-edit event) the proof is a known
// successful after-action fixture, labelled observation-only; no deny fixture is required
// or claimed, because nothing is prevented there.

import { createHash } from "node:crypto";
import { VECTORS, type Vector, type VectorAgent } from "./vectors.js";

export type CapabilityState =
  | "unsupported" | "configured_unverified" | "verified_reporting" | "degraded" | "inactive" | "retired";

export type HostVariant = "claude_terminal" | "claude_desktop" | "codex_cli" | "codex_desktop" | "cursor";
export type EventPhase = "pre_action" | "after_action";
export type Adapter = VectorAgent;

/** The outcome of running a cell's fixtures. */
export interface ProofRecord {
  cell: string;
  ran_at: string;
  adapter_version: string;
  test_vector_digest: string;
  /** `fixture`: local run against temp state. `live_harness`: recorded from a real host. */
  origin: "fixture" | "live_harness";
  /** A benign action was allowed and produced a countersigned receipt. */
  safe_allow: boolean;
  /** A violating action was denied at the claimed boundary, or `not_applicable`. */
  safe_deny: boolean | "not_applicable";
  /** Every receipt from the fixtures verified against the countersigning key. */
  signature: boolean;
  /** Every receipt of one tool call carried the same action group. */
  grouping: boolean;
  /** Cloud acknowledgement. Never `acknowledged` from a local fixture run. */
  cloud_ack: "not_checked" | "acknowledged" | "failed";
  observation_only: boolean;
  /** `source_receipt_hash` of the fixture receipts whose action type is this cell's (allow
   *  fixtures, and deny fixtures for a before-action cell). Empty when none matched. */
  proof_digests?: string[];
  /** Typed-operation cells only: every fixture derived the closed operation it expects. */
  typed_operation?: boolean;
}

export interface CapabilityCell {
  key: string;
  connector: "scopebond-hook";
  adapter_version: string;
  host_variant: HostVariant;
  action_type: string;
  event_phase: EventPhase;
  state: CapabilityState;
  /** Why the cell is in this state, in plain words. */
  reason: string;
  pre_action: boolean;
  after_action: boolean;
  /** Where enforcement happens: the harness's own hook, or nowhere. */
  boundary: "harness_hook" | "none";
  observation_only: boolean;
  emitted_required_fields: string[];
  supported_operations: string[];
  /** Limits the vectors document; repeated here rather than hidden. */
  known_gaps: string[];
  min_runtime: { node: string };
  test_vector_digest: string | null;
  last_proof: ProofRecord | null;
}

export interface Manifest {
  connector: "scopebond-hook";
  adapter_version: string;
  generated_at: string;
  cells: CapabilityCell[];
}

interface CellSpec {
  adapter: Adapter;
  host_variants: HostVariant[];
  action_type: string;
  phase: EventPhase;
  /** Which harness event(s) carry it, for the reader. */
  via: string;
  supported: boolean;
  unsupported_reason?: string;
  observation_only?: boolean;
  fields: string[];
  operations: string[];
}

const GROUP_FIELDS = ["action_group", "action_group_size", "action_group_seq"];
const CLAUDE_HOSTS: HostVariant[] = ["claude_terminal", "claude_desktop"];
const CODEX_HOSTS: HostVariant[] = ["codex_cli", "codex_desktop"];

const NESTED = "nested_orchestration";

const SPECS: CellSpec[] = [
  // Claude Code ---------------------------------------------------------------------
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "shell.exec", phase: "pre_action", via: "PreToolUse Bash/PowerShell/Shell", supported: true, fields: ["program", "command", ...GROUP_FIELDS], operations: ["program", "destructive_program", "opaque_program", "derived_file_read", "derived_file_write", "derived_git_push"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "file.write", phase: "pre_action", via: "PreToolUse Write/Edit/MultiEdit/NotebookEdit", supported: true, fields: ["path", ...GROUP_FIELDS], operations: ["write", "protected_path", "ci_path", "root_scope_when_configured"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "file.read", phase: "pre_action", via: "PreToolUse Read", supported: true, fields: ["path", ...GROUP_FIELDS], operations: ["read", "credential_path"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "git.push", phase: "pre_action", via: "PreToolUse Bash (parsed git push)", supported: true, fields: ["ref", "force", ...GROUP_FIELDS], operations: ["push", "force", "delete", "refspec", "mirror_all", "unresolved_destination"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "net.fetch", phase: "pre_action", via: "PreToolUse WebFetch", supported: true, observation_only: true, fields: ["host", "path", "method", ...GROUP_FIELDS], operations: ["fetch_get"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "mcp.tool.call", phase: "pre_action", via: "PreToolUse mcp__server__tool", supported: true, observation_only: true, fields: ["server", "tool", "args_digest", ...GROUP_FIELDS], operations: ["tool_call"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: NESTED, phase: "pre_action", via: "Task / sub-agent tools", supported: false, unsupported_reason: "a tool that runs nested calls is recorded as one unevaluated action; calls it makes inside are not shown to this adapter and are not claimed", fields: [], operations: [] },
  // Codex ---------------------------------------------------------------------------
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "shell.exec", phase: "pre_action", via: "PreToolUse Bash/exec_command/unified_exec/PowerShell", supported: true, fields: ["program", "command", ...GROUP_FIELDS], operations: ["program", "destructive_program", "opaque_program", "derived_file_read", "derived_file_write", "derived_git_push"] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "file.write", phase: "pre_action", via: "PreToolUse apply_patch", supported: true, fields: ["path", ...GROUP_FIELDS], operations: ["write", "rename_destination", "protected_path", "ci_path", "root_scope_when_configured"] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "file.read", phase: "pre_action", via: "(no native read hook)", supported: false, unsupported_reason: "Codex sends no native file-read event; reads made through shell commands are derived under shell.exec, not claimed here", fields: [], operations: [] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "git.push", phase: "pre_action", via: "PreToolUse Bash (parsed git push)", supported: true, fields: ["ref", "force", ...GROUP_FIELDS], operations: ["push", "force", "delete", "refspec", "mirror_all", "unresolved_destination"] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "net.fetch", phase: "pre_action", via: "(no fetch hook)", supported: false, unsupported_reason: "Codex sends no network-fetch event to this adapter", fields: [], operations: [] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "mcp.tool.call", phase: "pre_action", via: "PreToolUse mcp__server__tool", supported: true, observation_only: true, fields: ["server", "tool", "args_digest", ...GROUP_FIELDS], operations: ["tool_call"] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: NESTED, phase: "pre_action", via: "sub-agent / nested tool wrappers", supported: false, unsupported_reason: "a wrapper that orchestrates nested calls has not been shown to route them through the hook, so it is not claimed", fields: [], operations: [] },
  // Cursor (tested mode) --------------------------------------------------------------
  { adapter: "cursor", host_variants: ["cursor"], action_type: "shell.exec", phase: "pre_action", via: "beforeShellExecution", supported: true, fields: ["program", "command", ...GROUP_FIELDS], operations: ["program", "destructive_program", "opaque_program", "derived_file_read", "derived_file_write", "derived_git_push"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "file.read", phase: "pre_action", via: "beforeReadFile", supported: true, fields: ["path", ...GROUP_FIELDS], operations: ["read", "credential_path"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "file.write", phase: "pre_action", via: "(no before-edit hook)", supported: false, unsupported_reason: "Cursor has no before-edit event, so a write cannot be stopped there", fields: [], operations: [] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "file.write", phase: "after_action", via: "afterFileEdit", supported: true, observation_only: true, fields: ["path", ...GROUP_FIELDS], operations: ["observed_write"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "git.push", phase: "pre_action", via: "beforeShellExecution (parsed git push)", supported: true, fields: ["ref", "force", ...GROUP_FIELDS], operations: ["push", "force", "delete", "refspec", "mirror_all", "unresolved_destination"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "net.fetch", phase: "pre_action", via: "(no fetch hook)", supported: false, unsupported_reason: "Cursor sends no network-fetch event to this adapter", fields: [], operations: [] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "mcp.tool.call", phase: "pre_action", via: "beforeMCPExecution", supported: true, observation_only: true, fields: ["server", "tool", "args_digest", ...GROUP_FIELDS], operations: ["tool_call"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: NESTED, phase: "pre_action", via: "nested tool wrappers", supported: false, unsupported_reason: "nested calls made inside a tool are not shown to this adapter and are not claimed", fields: [], operations: [] },
  // Typed operations (observations, not receipts): the closed git, package and github_resource
  // operations derived from the actual command before it runs. They are observation-only:
  // they describe what was dispatched and never gate it. A fixture proves the derivation on
  // this machine only; it does not prove the host delivers the event or that the workspace
  // accepted it, so these cells stay configured_unverified until a real-host proof exists.
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "git.commit", phase: "pre_action", via: "PreToolUse Bash/PowerShell (git commit)", supported: true, observation_only: true, fields: ["repository_id","refs","force","head_sha","resolution","remote_id"], operations: ["commit"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "package.install", phase: "pre_action", via: "PreToolUse Bash/PowerShell (npm, pnpm, yarn, pip, uv with named packages)", supported: true, observation_only: true, fields: ["manager","manager_version","packages","lifecycle_scripts"], operations: ["install","add","update"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "github.resource", phase: "pre_action", via: "PreToolUse Bash/PowerShell (gh) and mcp__github__ tools", supported: true, observation_only: true, fields: ["repository_id","base_sha","head_sha","release_digest","required_check_policy_version"], operations: ["pr_create","release_create"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "github.pr_change", phase: "pre_action", via: "gh pr edit / gh pr merge, merge_pull_request", supported: false, unsupported_reason: "a pull request named only by number has no head or base commit in the request; recording pr_update and pr_merge needs a platform read-back this hook does not perform", fields: [], operations: [] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "deploy.run", phase: "pre_action", via: "(no deploy adapter)", supported: false, unsupported_reason: "a deploy operation carries check results that only an independent platform source can supply; this hook is not one", fields: [], operations: [] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "git.commit", phase: "pre_action", via: "PreToolUse Bash (git commit)", supported: true, observation_only: true, fields: ["repository_id","refs","force","head_sha","resolution","remote_id"], operations: ["commit"] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "package.install", phase: "pre_action", via: "PreToolUse Bash (npm, pnpm, yarn, pip, uv with named packages)", supported: true, observation_only: true, fields: ["manager","manager_version","packages","lifecycle_scripts"], operations: ["install","add","update"] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "github.resource", phase: "pre_action", via: "PreToolUse Bash (gh) and mcp__github__ tools", supported: true, observation_only: true, fields: ["repository_id","base_sha","head_sha","release_digest","required_check_policy_version"], operations: ["pr_create","release_create"] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "github.pr_change", phase: "pre_action", via: "gh pr edit / gh pr merge, merge_pull_request", supported: false, unsupported_reason: "a pull request named only by number has no head or base commit in the request; recording pr_update and pr_merge needs a platform read-back this hook does not perform", fields: [], operations: [] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "deploy.run", phase: "pre_action", via: "(no deploy adapter)", supported: false, unsupported_reason: "a deploy operation carries check results that only an independent platform source can supply; this hook is not one", fields: [], operations: [] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "git.commit", phase: "pre_action", via: "beforeShellExecution (git commit)", supported: true, observation_only: true, fields: ["repository_id","refs","force","head_sha","resolution","remote_id"], operations: ["commit"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "package.install", phase: "pre_action", via: "beforeShellExecution (npm, pnpm, yarn, pip, uv with named packages)", supported: true, observation_only: true, fields: ["manager","manager_version","packages","lifecycle_scripts"], operations: ["install","add","update"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "github.resource", phase: "pre_action", via: "beforeShellExecution (gh) and beforeMCPExecution github tools", supported: true, observation_only: true, fields: ["repository_id","base_sha","head_sha","release_digest","required_check_policy_version"], operations: ["pr_create","release_create"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "github.pr_change", phase: "pre_action", via: "gh pr edit / gh pr merge, merge_pull_request", supported: false, unsupported_reason: "a pull request named only by number has no head or base commit in the request; recording pr_update and pr_merge needs a platform read-back this hook does not perform", fields: [], operations: [] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "deploy.run", phase: "pre_action", via: "(no deploy adapter)", supported: false, unsupported_reason: "a deploy operation carries check results that only an independent platform source can supply; this hook is not one", fields: [], operations: [] },
  // Network, Cloudflare and database operations (MP11): observation-only, derived from the actual
  // command (or, for a Claude Code WebFetch, the tool input) before it runs. Fixtures prove the
  // derivation on this machine; no real-host proof exists yet, so these stay configured_unverified.
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "network.request", phase: "pre_action", via: "PreToolUse Bash/PowerShell (curl, wget, Invoke-WebRequest, Invoke-RestMethod) and WebFetch", supported: true, observation_only: true, fields: ["scheme","host","port","method","net_operation"], operations: ["read","write","upload"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "cloudflare.resource", phase: "pre_action", via: "PreToolUse Bash/PowerShell (wrangler deploy, pages deploy, d1 create/delete, r2 bucket and object commands)", supported: true, observation_only: true, fields: ["resource_kind","account_id","environment_binding","artifact_digest","visibility_before","visibility_after"], operations: ["create","update","write","delete","set_visibility"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "database.exec", phase: "pre_action", via: "PreToolUse Bash/PowerShell (wrangler d1 execute and migrations apply, psql, sqlite3)", supported: true, observation_only: true, fields: ["provider","verb","predicate_class","database_id","migration_digest"], operations: ["read","insert","update","delete","delete_all","create","alter","drop","migrate"] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "browser.action", phase: "pre_action", via: "(no browser hook)", supported: false, unsupported_reason: "no approved browser or computer-use event is wired for this host: a browser tool reaches this adapter as a generic MCP tool call with no origin, verb or action class, so no browser operation is derived and none is claimed", fields: [], operations: [] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "communication.send", phase: "pre_action", via: "(no communications adapter)", supported: false, unsupported_reason: "mail and chat tools reach this adapter only as generic MCP tool calls; no provider adapter reads a destination domain or channel, or an attachment set, from the request, so no communication operation is derived", fields: [], operations: [] },
  { adapter: "claude", host_variants: CLAUDE_HOSTS, action_type: "visibility.change", phase: "pre_action", via: "(no visibility source)", supported: false, unsupported_reason: "no host event or supported command reports a resource's visibility before and after; an R2 public-URL change is typed as cloudflare_resource set_visibility with the before state unknown", fields: [], operations: [] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "network.request", phase: "pre_action", via: "PreToolUse Bash/exec_command/unified_exec/PowerShell (curl, wget, Invoke-WebRequest, Invoke-RestMethod)", supported: true, observation_only: true, fields: ["scheme","host","port","method","net_operation"], operations: ["read","write","upload"] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "cloudflare.resource", phase: "pre_action", via: "PreToolUse Bash/exec_command/unified_exec/PowerShell (wrangler deploy, pages deploy, d1 create/delete, r2 bucket and object commands)", supported: true, observation_only: true, fields: ["resource_kind","account_id","environment_binding","artifact_digest","visibility_before","visibility_after"], operations: ["create","update","write","delete","set_visibility"] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "database.exec", phase: "pre_action", via: "PreToolUse Bash/exec_command/unified_exec/PowerShell (wrangler d1 execute and migrations apply, psql, sqlite3)", supported: true, observation_only: true, fields: ["provider","verb","predicate_class","database_id","migration_digest"], operations: ["read","insert","update","delete","delete_all","create","alter","drop","migrate"] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "browser.action", phase: "pre_action", via: "(no browser hook)", supported: false, unsupported_reason: "no approved browser or computer-use event is wired for this host: a browser tool reaches this adapter as a generic MCP tool call with no origin, verb or action class, so no browser operation is derived and none is claimed", fields: [], operations: [] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "communication.send", phase: "pre_action", via: "(no communications adapter)", supported: false, unsupported_reason: "mail and chat tools reach this adapter only as generic MCP tool calls; no provider adapter reads a destination domain or channel, or an attachment set, from the request, so no communication operation is derived", fields: [], operations: [] },
  { adapter: "codex", host_variants: CODEX_HOSTS, action_type: "visibility.change", phase: "pre_action", via: "(no visibility source)", supported: false, unsupported_reason: "no host event or supported command reports a resource's visibility before and after; an R2 public-URL change is typed as cloudflare_resource set_visibility with the before state unknown", fields: [], operations: [] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "network.request", phase: "pre_action", via: "beforeShellExecution (curl, wget, Invoke-WebRequest, Invoke-RestMethod)", supported: true, observation_only: true, fields: ["scheme","host","port","method","net_operation"], operations: ["read","write","upload"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "cloudflare.resource", phase: "pre_action", via: "beforeShellExecution (wrangler deploy, pages deploy, d1 create/delete, r2 bucket and object commands)", supported: true, observation_only: true, fields: ["resource_kind","account_id","environment_binding","artifact_digest","visibility_before","visibility_after"], operations: ["create","update","write","delete","set_visibility"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "database.exec", phase: "pre_action", via: "beforeShellExecution (wrangler d1 execute and migrations apply, psql, sqlite3)", supported: true, observation_only: true, fields: ["provider","verb","predicate_class","database_id","migration_digest"], operations: ["read","insert","update","delete","delete_all","create","alter","drop","migrate"] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "browser.action", phase: "pre_action", via: "(no browser hook)", supported: false, unsupported_reason: "no approved browser or computer-use event is wired for this host: a browser tool reaches this adapter as a generic MCP tool call with no origin, verb or action class, so no browser operation is derived and none is claimed", fields: [], operations: [] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "communication.send", phase: "pre_action", via: "(no communications adapter)", supported: false, unsupported_reason: "mail and chat tools reach this adapter only as generic MCP tool calls; no provider adapter reads a destination domain or channel, or an attachment set, from the request, so no communication operation is derived", fields: [], operations: [] },
  { adapter: "cursor", host_variants: ["cursor"], action_type: "visibility.change", phase: "pre_action", via: "(no visibility source)", supported: false, unsupported_reason: "no host event or supported command reports a resource's visibility before and after; an R2 public-URL change is typed as cloudflare_resource set_visibility with the before state unknown", fields: [], operations: [] },
];

export const cellKey = (adapterVersion: string, host: HostVariant, actionType: string, phase: EventPhase): string =>
  `scopebond-hook@${adapterVersion}/${host}/${actionType}/${phase}`;

/** The vectors that prove one cell: those tagged with its action type for its adapter. For
 *  the after-action cell only the after-action vector counts. */
export function vectorsForCell(adapter: Adapter, actionType: string, phase: EventPhase): Vector[] {
  return VECTORS.filter((v) => v.agent === adapter && v.cell?.action_type === actionType
    && (phase === "after_action" ? v.cell.role === "after_action" : v.cell.role !== "after_action"));
}

/** Digest of a cell's vectors (id, payload and expectation). A proof recorded against one
 *  digest says nothing about a changed set. */
export function vectorDigest(vectors: readonly Vector[]): string | null {
  if (vectors.length === 0) return null;
  const canonical = JSON.stringify([...vectors].sort((a, b) => a.id.localeCompare(b.id)).map((v) => [v.id, v.event ?? null, v.input, v.expect, v.catalog, v.unknown === true]));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** The gaps the cell's vectors document, plus the always-true program-only limit. */
function gapsFor(adapter: Adapter, actionType: string): string[] {
  const gaps = new Set<string>();
  for (const v of VECTORS) if (v.gap && v.agent === adapter && (actionType === "shell.exec" ? v.rule === "R09" || v.rule === "R10" || v.rule === "R06" : false)) gaps.add(v.gap);
  return [...gaps];
}

export interface ManifestInput {
  adapterVersion: string;
  /** Which harnesses have the hook configured (any scope). */
  configured: Record<Adapter, boolean>;
  /** Recorded proofs by cell key. */
  proofs?: Record<string, ProofRecord | undefined>;
  now?: Date;
  /** Cell keys (any version) whose adapter no longer ships, for history. */
  retired?: string[];
}

/** Compute the state of one cell from what is configured and what has been proven. */
export function cellState(input: {
  supported: boolean; unsupportedReason?: string; configured: boolean; digest: string | null; adapterVersion: string;
  proof: ProofRecord | null | undefined; observationOnly: boolean; retired?: boolean;
}): { state: CapabilityState; reason: string } {
  if (input.retired) return { state: "retired", reason: "this adapter no longer ships; kept for history" };
  if (!input.supported) return { state: "unsupported", reason: input.unsupportedReason ?? "no hook for this action" };
  if (!input.configured) return { state: "inactive", reason: "the hook is not configured for this harness" };
  if (input.digest === null) return { state: "configured_unverified", reason: "configured; no test vectors exist for this cell, so it cannot be proven" };
  const proof = input.proof;
  if (!proof) return { state: "configured_unverified", reason: "configured; not yet proven (run `scopebond capabilities --prove`)" };
  if (proof.adapter_version !== input.adapterVersion || proof.test_vector_digest !== input.digest) {
    return { state: "configured_unverified", reason: "the recorded proof is for a different adapter version or vector set; run it again" };
  }
  const denyOk = input.observationOnly ? proof.safe_deny === "not_applicable" : proof.safe_deny === true;
  if (!proof.safe_allow || !denyOk || !proof.signature || !proof.grouping || proof.typed_operation === false) {
    return { state: "degraded", reason: `the current proof failed: ${[!proof.safe_allow && "safe allow", !denyOk && "safe deny", !proof.signature && "signature", !proof.grouping && "grouping", proof.typed_operation === false && "typed operation"].filter(Boolean).join(", ")}` };
  }
  if (proof.origin !== "live_harness") {
    return { state: "configured_unverified", reason: `${input.observationOnly ? "observation-only fixture" : "local fixture"} passed; a real ${"host"} run and Cloud acknowledgement are still outstanding` };
  }
  if (proof.cloud_ack !== "acknowledged") {
    return { state: "configured_unverified", reason: proof.cloud_ack === "failed" ? "Cloud did not acknowledge the proof receipt" : "real-host proof passed; Cloud acknowledgement outstanding" };
  }
  return { state: "verified_reporting", reason: input.observationOnly ? "observation-only: a known successful after-action receipt was acknowledged" : "safe allow, safe deny, signature and Cloud acknowledgement all recorded" };
}

/** The manifest for the installed hook. Pure: no filesystem, no clock beyond `now`. */
export function computeManifest(input: ManifestInput): Manifest {
  const cells: CapabilityCell[] = [];
  for (const spec of SPECS) {
    const vectors = spec.supported ? vectorsForCell(spec.adapter, spec.action_type, spec.phase) : [];
    const digest = vectorDigest(vectors);
    for (const host of spec.host_variants) {
      const key = cellKey(input.adapterVersion, host, spec.action_type, spec.phase);
      const proof = input.proofs?.[key] ?? null;
      const observationOnly = spec.observation_only === true;
      const { state, reason } = cellState({
        supported: spec.supported, unsupportedReason: spec.unsupported_reason, configured: input.configured[spec.adapter],
        digest, adapterVersion: input.adapterVersion, proof, observationOnly, retired: input.retired?.includes(key),
      });
      cells.push({
        key, connector: "scopebond-hook", adapter_version: input.adapterVersion, host_variant: host,
        action_type: spec.action_type, event_phase: spec.phase, state, reason,
        pre_action: spec.supported && spec.phase === "pre_action",
        after_action: spec.supported && spec.phase === "after_action",
        boundary: spec.supported && spec.phase === "pre_action" && !observationOnly ? "harness_hook" : "none",
        observation_only: observationOnly,
        emitted_required_fields: spec.fields, supported_operations: spec.operations,
        known_gaps: spec.supported ? gapsFor(spec.adapter, spec.action_type) : [],
        min_runtime: { node: ">=22.13" },
        test_vector_digest: digest, last_proof: proof,
      });
    }
  }
  return { connector: "scopebond-hook", adapter_version: input.adapterVersion, generated_at: (input.now ?? new Date()).toISOString(), cells };
}

/** The spec for a cell key, for the proof runner. */
export function specForCell(cell: CapabilityCell): { adapter: Adapter; action_type: string; phase: EventPhase } | null {
  const spec = SPECS.find((s) => s.action_type === cell.action_type && s.phase === cell.event_phase && s.host_variants.includes(cell.host_variant));
  return spec ? { adapter: spec.adapter, action_type: spec.action_type, phase: spec.phase } : null;
}

const VIA = new Map(SPECS.flatMap((s) => s.host_variants.map((h) => [`${h}/${s.action_type}/${s.phase}`, s.via] as const)));

/** Plain-text rendering. Unsupported stays unsupported; nothing here upgrades a state. */
export function renderManifest(manifest: Manifest): string {
  const lines: string[] = [];
  lines.push(`Capability manifest — scopebond-hook ${manifest.adapter_version}`);
  lines.push("A state is only ever what a recorded proof supports. A local fixture never makes a cell verified.");
  const hosts = [...new Set(manifest.cells.map((c) => c.host_variant))];
  for (const host of hosts) {
    lines.push("");
    lines.push(host);
    for (const cell of manifest.cells.filter((c) => c.host_variant === host)) {
      const phase = cell.event_phase === "after_action" ? "after action" : "before action";
      const via = VIA.get(`${host}/${cell.action_type}/${cell.event_phase}`);
      lines.push(`  ${cell.action_type.padEnd(21)} ${phase.padEnd(13)} ${cell.state.padEnd(21)}${cell.observation_only ? " observation-only" : ""}`);
      lines.push(`      ${cell.reason}${via ? ` [${via}]` : ""}`);
      for (const gap of cell.known_gaps) lines.push(`      limit: ${gap}`);
    }
  }
  const counts = new Map<string, number>();
  for (const cell of manifest.cells) counts.set(cell.state, (counts.get(cell.state) ?? 0) + 1);
  lines.push("");
  lines.push(`Summary: ${[...counts].map(([state, n]) => `${n} ${state}`).join(", ")}`);
  return lines.join("\n");
}
