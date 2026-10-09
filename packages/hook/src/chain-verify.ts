// `scopebond verify --anchor <file-or-url> [--segments <dir>]`: check the evidence-chain heads this computer kept from its
// workspace's delivery answers against a published day's anchor list and, optionally, against the evidence segments
// downloaded from the workspace. Every head the workspace ever gave this computer must agree with what it publishes and
// with the segments it serves: a chain whose sequence goes back, a segment position that names two segments, or a head
// whose segment is no longer in the chain means records were removed, reordered or re-chained after this computer was told
// they were held.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { checkChainHeads, verifyAnchorList, verifyChainHeadSignature, verifySegmentChain, type AnchorList, type SignedChainHead } from "@scopebond/gateway";
import { CHAIN_HEADS_FILE, keptHeads, readChainHeads } from "@scopebond/gateway/node";

export interface ChainCheckOptions {
  /** The hook's folder (holds chain-heads.json). */
  dir: string;
  /** Published day lists: files or https URLs. */
  anchors: string[];
  /** A folder of downloaded evidence segments (.json.gz as served, or .json). */
  segmentsDir?: string;
  /** This computer's receipt key, to check every record in the segments. */
  publicKeyPem?: string;
  fetchImpl?: typeof fetch;
}

export interface ChainCheckReport { ok: boolean; lines: string[]; problems: string[] }

const MAX_ANCHOR_BYTES = 64 * 1024 * 1024;

async function loadAnchor(source: string, fetchImpl: typeof fetch): Promise<unknown> {
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !local) throw new Error(`${source}: only https addresses are fetched`);
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_ANCHOR_BYTES) throw new Error(`${source}: larger than an anchor list can be`);
    return JSON.parse(text);
  }
  return JSON.parse(readFileSync(source, "utf8").replace(/^﻿/, ""));
}

function readSegments(dir: string): string[] {
  const texts: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (name.endsWith(".json.gz") || name.endsWith(".gz")) texts.push(gunzipSync(readFileSync(path)).toString("utf8"));
    else if (name.endsWith(".json")) texts.push(readFileSync(path, "utf8"));
  }
  return texts;
}

export async function checkChains(options: ChainCheckOptions): Promise<ChainCheckReport> {
  const lines: string[] = [];
  const problems: string[] = [];
  const file = join(options.dir, CHAIN_HEADS_FILE);
  const kept = existsSync(file) ? keptHeads(readChainHeads(file)) : [];
  const chains = new Set(kept.map((h) => h.head.anchor_id));
  lines.push(kept.length
    ? `${kept.length} chain head(s) kept for ${chains.size} chain(s) in ${file}.`
    : "No chain heads kept yet: they arrive with the answers of a connected workspace (Scopebond Cloud) as records are delivered.");

  const published: SignedChainHead[] = [];
  for (const source of options.anchors) {
    let list: unknown;
    try { list = await loadAnchor(source, options.fetchImpl ?? fetch); }
    catch (error) { problems.push(`anchor ${source}: ${(error as Error).message}`); continue; }
    const check = await verifyAnchorList(list);
    const day = (list as Partial<AnchorList>)?.date ?? "?";
    for (const p of check.problems) problems.push(`anchor ${day}: ${p}`);
    if (!check.valid && !Array.isArray((list as Partial<AnchorList>)?.heads)) continue;
    const heads = ((list as AnchorList).heads ?? []).filter((h) => chains.has(h?.head?.anchor_id));
    lines.push(`Anchor ${day}: ${check.signed ? `signed by ${check.kid}` : "unsigned (it shows what was published, not who published it)"}; ${check.heads} chain(s), ${heads.length} of them this computer's.`);
    published.push(...heads);
    // The heads this computer kept must verify under the same published key.
    const key = (list as AnchorList).key;
    if (check.signed && key) {
      for (const h of kept) {
        if (!h.signed || h.signature?.kid !== key.kid) continue;
        if (!(await verifyChainHeadSignature(h, key))) problems.push(`chain ${h.head.anchor_id.slice(0, 12)}: the head kept from ${h.head.issued_at} does not verify under ${key.kid}`);
      }
    }
  }

  if (kept.length) {
    const heads = checkChainHeads(kept, published);
    problems.push(...heads.problems);
    if (heads.ok) lines.push(`Chain heads agree${options.anchors.length ? ` (${heads.matched} published head(s) compared)` : ""}: no chain went back and no position names two segments.`);
  }

  if (options.segmentsDir) {
    let texts: string[] = [];
    try { texts = readSegments(options.segmentsDir); } catch (error) { problems.push(`segments ${options.segmentsDir}: ${(error as Error).message}`); }
    const segments = await verifySegmentChain(texts, kept, options.publicKeyPem ? { publicKey: options.publicKeyPem } : {});
    problems.push(...segments.problems);
    if (segments.ok) {
      const covered = Object.values(segments.covered);
      lines.push(`${segments.segments} segment(s), ${segments.records} record(s) check${options.publicKeyPem ? ", each signed by this computer's key" : ""}${covered.length ? `; every kept head's segment is in its chain (through sequence ${Math.max(...covered)})` : ""}.`);
    }
  }
  return { ok: problems.length === 0, lines, problems };
}
