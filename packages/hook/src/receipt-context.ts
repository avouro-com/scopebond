// Receipt context (`payload.context`): where a receipt was produced, so a workspace can group
// records by session and filter them by tool, model and repository. Nothing personal: the
// repository is the git remote `origin` as `host/owner/name` (never a local path), the session
// id is the same keyed opaque id the observations carry (never the harness's raw id), and no
// prompt, transcript, user name or path is read.
//
// A connected hook includes it only once its workspace has said it reads it: the rules check
// (`GET /v1/policy`) or a delivery answer carries `x-scopebond-receipt-context: 1`, which is kept
// in the managed meta as `receipt_context`. An older workspace refuses a receipt with a key it
// does not know, so until then receipts it will be sent carry no context. A hook that is not
// connected always includes it: the receipts stay on this computer.

import { validateReceiptContext, type ReceiptPayloadContext } from "@scopebond/gateway";
import { normalizeRemote, systemGit, type GitProbe } from "./typed-ops.js";
import { loadOrCreateBindingKey } from "./observation.js";
import { readMeta, writeMeta } from "./managed.js";
import type { Harness } from "./install.js";

/** The header a workspace sends (value `1`) on the rules check or a delivery answer when it reads `payload.context`. */
export const RECEIPT_CONTEXT_HEADER = "x-scopebond-receipt-context";

/** Whether a response says its workspace reads receipt context. */
export function receiptContextFrom(headers: { get(name: string): string | null } | undefined | null): boolean {
  return headers?.get?.(RECEIPT_CONTEXT_HEADER)?.trim() === "1";
}

/** Record that the workspace reads receipt context (a delivery answer said so). Never throws. */
export function noteReceiptContext(dir: string): void {
  try {
    const meta = readMeta(dir);
    if (meta.receipt_context !== true) writeMeta(dir, { ...meta, receipt_context: true });
  } catch { /* the next rules check says it again */ }
}

/** Whether receipts built now may carry a context: always when not connected, else only once the workspace said it reads it. */
export function receiptContextAllowed(dir: string, connected: boolean): boolean {
  if (!connected) return true;
  try { return readMeta(dir).receipt_context === true; } catch { return false; }
}

const HOST = /^[a-z0-9][a-z0-9.-]*$/;
const SEGMENT = /^[A-Za-z0-9._~%+-]+$/;

/** A git remote as `host/owner/name`: lowercase host, no scheme, credentials, port, query or `.git`, and the path lowercased on
 *  github.com (where it is not case-sensitive). Null for a local path, an unreadable remote, or one longer than 200 characters. */
export function canonicalRepository(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const remote = normalizeRemote(url);
  if (!remote || remote.host === "local" || !HOST.test(remote.host)) return null;
  const segments = remote.path.split("/");
  if (segments.length < 2 || segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return null;
  const path = remote.host === "github.com" ? remote.path.toLowerCase() : remote.path;
  const repository = `${remote.host}/${path}`;
  return repository.length <= 200 ? repository : null;
}

/** A printable value of at most `max` characters, or null. */
function printable(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || [...text].length > max) return null;
  for (const ch of text) { const code = ch.codePointAt(0)!; if (code < 0x20 || code === 0x7f) return null; }
  return text;
}

/** The model id the harness put in its hook input, if any. Claude Code sends it on some events only; the transcript is never read. */
export function harnessModel(input: Record<string, unknown>): string | null {
  return printable(input.model, 128);
}

/** The harness's version when its hook input says it (Cursor's `cursor_version`); Claude Code and Codex do not. */
export function harnessVersion(harness: Harness, input: Record<string, unknown>): string | null {
  return harness === "cursor" ? printable(input.cursor_version, 64) : null;
}

const gitFacts = new Map<string, { repository: string | null; branch: string | null }>();

/** The repository and branch of `cwd`, read once per directory for this process. */
export function repositoryFacts(cwd: string, probe: GitProbe = systemGit, branch?: string | null): { repository: string | null; branch: string | null } {
  const cached = gitFacts.get(cwd);
  if (cached) return cached;
  let facts: { repository: string | null; branch: string | null };
  try {
    facts = {
      repository: canonicalRepository(probe.remoteUrl(cwd, "origin")),
      branch: printable(branch === undefined ? probe.branch(cwd) : branch, 200),
    };
  } catch { facts = { repository: null, branch: null }; }
  gitFacts.set(cwd, facts);
  return facts;
}

/** Tests: forget what was read. */
export function clearRepositoryFacts(): void { gitFacts.clear(); }

export interface ContextInput {
  harness: Harness;
  /** The harness's hook input. Only `session_id`, `model` and (Cursor) `cursor_version` are read. */
  input: Record<string, unknown>;
  /** The hook's folder: its keyed session id comes from the observation binding key kept there. */
  dir: string;
  cwd: string;
  connected: boolean;
  probe?: GitProbe;
  /** The current branch when the caller has already read it. */
  branch?: string | null;
}

/** The context to sign into this call's receipts, or null when it may not be sent or cannot be read. Never throws. */
export function receiptContextFor(options: ContextInput): ReceiptPayloadContext | null {
  try {
    if (!receiptContextAllowed(options.dir, options.connected)) return null;
    const raw = options.input.session_id;
    let session: string | null = null;
    if (typeof raw === "string" && raw !== "") {
      try { session = loadOrCreateBindingKey(options.dir).sessionId(raw); } catch { session = null; }
    }
    const { repository, branch } = repositoryFacts(options.cwd, options.probe, options.branch);
    const context: ReceiptPayloadContext = {
      harness: options.harness,
      harness_version: harnessVersion(options.harness, options.input),
      model: harnessModel(options.input),
      session_id: session,
      repository,
      branch,
    };
    return validateReceiptContext(context) ? context : null;
  } catch { return null; }
}
