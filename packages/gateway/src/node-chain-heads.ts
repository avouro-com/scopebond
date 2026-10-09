// The chain heads a computer keeps from its workspace's delivery answers (`chain_head`), in one small JSON file beside its
// receipts. A head is the workspace's signed statement of how far an environment's evidence chain had come (newest sequence
// number and newest evidence segment) when it answered. Held here, outside the workspace, the heads let anyone show later
// that the chain lost, reordered or re-chained records: `checkChainHeads` and `verifySegmentChain` in
// @scopebond/verify/chain compare them with each other, with a published day's anchor list and with downloaded segments.
//
// Per chain the file keeps, in the order received: the newest head of each UTC day, every head that disagrees with the one
// before it (a lower sequence number, or another segment at the same position: that is the evidence), and at most
// MAX_HEADS_PER_CHAIN heads. Writes replace the file atomically; a write that fails is ignored (delivery never depends on it).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isSignedChainHead, type SignedChainHead } from "@scopebond/verify/chain";
import { placeOwnerOnly } from "./node-files.js";

export const CHAIN_HEADS_FILE = "chain-heads.json";
export const MAX_HEADS_PER_CHAIN = 1_000;

export interface ChainHeadsState { version: 1; chains: Record<string, SignedChainHead[]> }

const empty = (): ChainHeadsState => ({ version: 1, chains: {} });

/** Whether `next` disagrees with `last` (the evidence a later check needs, so it is never folded away). */
function disagrees(last: SignedChainHead, next: SignedChainHead): boolean {
  if (next.head.ingest_seq < last.head.ingest_seq) return true;
  const a = last.head.segment, b = next.head.segment;
  return !!a && !!b && a.last_ingest_seq === b.last_ingest_seq && a.digest !== b.digest;
}

/** Adds a head to the state (pure). The newest head of a day replaces the day's previous one unless either disagrees with
 *  what came before it. */
export function mergeChainHead(state: ChainHeadsState, head: SignedChainHead): ChainHeadsState {
  if (!isSignedChainHead(head)) return state;
  const list = [...(state.chains[head.head.anchor_id] ?? [])];
  const last = list.at(-1);
  const before = list.at(-2);
  const sameDay = last && last.head.issued_at.slice(0, 10) === head.head.issued_at.slice(0, 10);
  const lastIsEvidence = !!last && !!before && disagrees(before, last);
  if (last && last.head.issued_at === head.head.issued_at && last.head.ingest_seq === head.head.ingest_seq) return state;
  if (last && sameDay && !lastIsEvidence && !disagrees(last, head)) list[list.length - 1] = head;
  else list.push(head);
  return { version: 1, chains: { ...state.chains, [head.head.anchor_id]: list.slice(-MAX_HEADS_PER_CHAIN) } };
}

/** The heads kept in `file` (an empty state when there is none or it cannot be read). */
export function readChainHeads(file: string): ChainHeadsState {
  try {
    if (!existsSync(file)) return empty();
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Partial<ChainHeadsState>;
    if (parsed?.version !== 1 || typeof parsed.chains !== "object" || parsed.chains === null) return empty();
    const chains: Record<string, SignedChainHead[]> = {};
    for (const [id, list] of Object.entries(parsed.chains)) if (Array.isArray(list)) chains[id] = list.filter(isSignedChainHead);
    return { version: 1, chains };
  } catch { return empty(); }
}

/** Every kept head, all chains, in the order received per chain. */
export const keptHeads = (state: ChainHeadsState): SignedChainHead[] => Object.values(state.chains).flat();

/** Keeps one head in `file`. Never throws. */
export function recordChainHead(file: string, head: SignedChainHead): void {
  try {
    const before = readChainHeads(file);
    const after = mergeChainHead(before, head);
    if (after === before) return;
    mkdirSync(dirname(file), { recursive: true });
    // A new file, owner-only from its first byte, renamed over the old one (a link at the name is replaced, never followed).
    placeOwnerOnly(file, JSON.stringify(after, null, 1) + "\n", false);
  } catch { /* the next answer carries a newer head */ }
}

/** An `onChainHead` callback for the Cloud exporter that keeps heads in `file`. */
export const chainHeadRecorder = (file: string) => (head: SignedChainHead): void => recordChainHead(file, head);
