// The chain heads a computer keeps from its workspace's delivery answers (`chain_head`), in one small JSON file beside its
// receipts. A head is the workspace's signed statement of how far an environment's evidence chain had come (newest sequence
// number and newest evidence segment) when it answered. Held here, outside the workspace, the heads let anyone show later
// that the chain lost, reordered or re-chained records: `checkChainHeads` and `verifySegmentChain` in
// @scopebond/verify/chain compare them with each other, with a published day's anchor list and with downloaded segments.
//
// Per chain the file keeps, in the order received: the newest head of each UTC day, every head that disagrees with the one
// before it (a lower sequence number, or another segment at the same position: that is the evidence), and at most
// MAX_HEADS_PER_CHAIN heads. Beside each head it keeps this computer's own times (`local`: when the delivery the head
// answered was sent, and by when the head was held). The workspace signs the head's `issued_at` and could choose it; these
// times it cannot, so they are what shows that a head received later went back. A head kept without them (by an earlier
// version) is marked held by the time of the next write. Writes replace the file atomically; a write that fails is ignored
// (delivery never depends on it).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isSignedChainHead, type HeadTiming, type KeptChainHead, type SignedChainHead } from "@scopebond/verify/chain";
import type { ChainHeadDelivery } from "./cloud.js";

export const CHAIN_HEADS_FILE = "chain-heads.json";
export const MAX_HEADS_PER_CHAIN = 1_000;

export interface ChainHeadsState { version: 1; chains: Record<string, KeptChainHead[]> }

const empty = (): ChainHeadsState => ({ version: 1, chains: {} });

/** Whether `next` disagrees with `last` (the evidence a later check needs, so it is never folded away). */
function disagrees(last: SignedChainHead, next: SignedChainHead): boolean {
  if (next.head.ingest_seq < last.head.ingest_seq) return true;
  const a = last.head.segment, b = next.head.segment;
  return !!a && !!b && a.last_ingest_seq === b.last_ingest_seq && a.digest !== b.digest;
}

/** Each kept head marked held by `heldAt` at the latest: it was in the file by then. A head without a time gets it, and a
 *  time after it (which cannot be) is brought back to it. The same state when nothing changes. */
function heldBy(state: ChainHeadsState, heldAt: string): ChainHeadsState {
  const limit = Date.parse(heldAt);
  if (!Number.isFinite(limit)) return state;
  let changed = false;
  const chains: Record<string, KeptChainHead[]> = {};
  for (const [id, list] of Object.entries(state.chains)) {
    chains[id] = list.map((h) => {
      const local: HeadTiming = h.local !== null && typeof h.local === "object" ? h.local : {};
      const held = typeof local.received_at === "string" ? Date.parse(local.received_at) : NaN;
      if (Number.isFinite(held) && held <= limit) return h;
      changed = true;
      return { ...h, local: { ...(typeof local.sent_at === "string" ? { sent_at: local.sent_at } : {}), received_at: heldAt } };
    });
  }
  return changed ? { version: 1, chains } : state;
}

/** Adds a head to the state (pure). The newest head of a day replaces the day's previous one unless either disagrees with
 *  what came before it. Only the signed head is kept from what the workspace sent, with `local` (this computer's times for
 *  it) beside it when given; with `heldAt`, every head already kept is marked held by then at the latest. */
export function mergeChainHead(state: ChainHeadsState, head: SignedChainHead, local?: HeadTiming, heldAt?: string): ChainHeadsState {
  if (!isSignedChainHead(head)) return state;
  const base = heldAt === undefined ? state : heldBy(state, heldAt);
  const list = [...(base.chains[head.head.anchor_id] ?? [])];
  const last = list.at(-1);
  const before = list.at(-2);
  const sameDay = last && last.head.issued_at.slice(0, 10) === head.head.issued_at.slice(0, 10);
  const lastIsEvidence = !!last && !!before && disagrees(before, last);
  if (last && last.head.issued_at === head.head.issued_at && last.head.ingest_seq === head.head.ingest_seq) return base;
  // Nothing the workspace put beside its signed head is kept: times it supplied would order the check it is checked by.
  const kept: KeptChainHead = { head: head.head, signed: head.signed, signature: head.signature, ...(local ? { local } : {}) };
  if (last && sameDay && !lastIsEvidence && !disagrees(last, head)) list[list.length - 1] = kept;
  else list.push(kept);
  return { version: 1, chains: { ...base.chains, [head.head.anchor_id]: list.slice(-MAX_HEADS_PER_CHAIN) } };
}

/** The heads kept in `file` (an empty state when there is none or it cannot be read). */
export function readChainHeads(file: string): ChainHeadsState {
  try {
    if (!existsSync(file)) return empty();
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Partial<ChainHeadsState>;
    if (parsed?.version !== 1 || typeof parsed.chains !== "object" || parsed.chains === null) return empty();
    const chains: Record<string, KeptChainHead[]> = {};
    for (const [id, list] of Object.entries(parsed.chains)) if (Array.isArray(list)) chains[id] = list.filter(isSignedChainHead);
    return { version: 1, chains };
  } catch { return empty(); }
}

/** Every kept head, all chains, in the order received per chain, each with this computer's times beside it. */
export const keptHeads = (state: ChainHeadsState): KeptChainHead[] => Object.values(state.chains).flat();

const iso = (ms: number): string | undefined => Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;

/** Keeps one head in `file`, with when its delivery was sent and its answer arrived (`delivery`, this computer's clock;
 *  without it, the head is marked held by the time of the write). Never throws. */
export function recordChainHead(file: string, head: SignedChainHead, delivery?: ChainHeadDelivery): void {
  try {
    const before = readChainHeads(file);
    // Everything read was in the file by now, and so is the new head.
    const heldAt = new Date().toISOString();
    const sent = iso(Number(delivery?.sentAt)), received = iso(Number(delivery?.receivedAt));
    const local: HeadTiming = { ...(sent ? { sent_at: sent } : {}), received_at: received ?? heldAt };
    const after = mergeChainHead(before, head, local, heldAt);
    if (after === before) return;
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(after, null, 1) + "\n", { mode: 0o600 });
    renameSync(temporary, file);
  } catch { /* the next answer carries a newer head */ }
}

/** An `onChainHead` callback for the Cloud exporter that keeps heads, with their delivery times, in `file`. */
export const chainHeadRecorder = (file: string) => (head: SignedChainHead, delivery?: ChainHeadDelivery): void => recordChainHead(file, head, delivery);
