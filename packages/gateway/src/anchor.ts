// Tamper-evidence for the receipt log: a sha256 Merkle tree over receipts, so a
// single published root commits to every receipt, and an inclusion proof shows a
// specific receipt is covered without revealing the others. Anchors are chained
// (each references the previous anchor's hash) so the anchor log is itself
// tamper-evident. Pure and runtime-agnostic (uses sha256 over hex strings).

import { sha256 } from "./receipts.js";

const hashPair = (a: string, b: string): string => sha256(a + b);

/** Merkle root over ordered leaf hashes (hex). Odd nodes are paired with
 *  themselves. An empty set commits to sha256(""). */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256("");
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(hashPair(a, b));
    }
    level = next;
  }
  return level[0];
}

export interface ProofStep { hash: string; side: "left" | "right"; }

/** Inclusion proof for the leaf at `index` (siblings bottom-up). */
export function merkleProof(leaves: string[], index: number): ProofStep[] {
  const proof: ProofStep[] = [];
  if (index < 0 || index >= leaves.length) return proof;
  let idx = index;
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : level[i];
      if (i === idx) proof.push({ hash: b, side: "right" });
      else if (i + 1 === idx) proof.push({ hash: a, side: "left" });
      next.push(hashPair(a, b));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

/** Verify an inclusion proof: recompute the root from the leaf and its siblings. */
export function verifyProof(leaf: string, proof: ProofStep[], root: string): boolean {
  let h = leaf;
  for (const step of proof) h = step.side === "right" ? hashPair(h, step.hash) : hashPair(step.hash, h);
  return h === root;
}

// v2 (RFC 9162, signed, versioned): the pure implementation lives in
// @scopebond/verify/anchor (WebCrypto, async) so any verifier uses the same code.
// The v1 functions above are kept, unchanged, for existing consumers and for
// verifying legacy anchors.
export {
  ANCHOR_ALGO_V1, ANCHOR_ALGO_V2, ANCHOR_TYPE,
  leafHash, nodeHash, receiptLeafHash, receiptLeafHashV1, merkleTreeHash, merkleRootV1,
  inclusionProof, verifyInclusionProof, consistencyProof, verifyConsistencyProof,
  anchorBody, anchorHash, anchorRoot, verifyAnchorRoot, verifyAnchorSignature, verifyAnchorChain,
  isAnchorV2,
} from "@scopebond/verify/anchor";
export type {
  AnchorV1, AnchorV2, AnchorV2Body, AnyAnchor, InclusionProof, ConsistencyProof, AnchorChainResult, Ed25519PublicJwk,
} from "@scopebond/verify/anchor";
