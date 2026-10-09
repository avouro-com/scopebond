// Cloudflare Workers building blocks: a KV-backed ReceiptStore and helpers that
// bootstrap a persistent WebCrypto attester in KV, so a Worker gateway keeps a
// stable signing key and a durable receipt log without any node: dependency.

import { createGateway } from "./app.js";
import type { Gateway } from "./app.js";
import { createWebCryptoAttester, generateAttesterJwk } from "./webcrypto.js";
import type {
  ReceiptStore, SignedReceipt, Attester, Anchor, StopState, AuthorityReservation, AuthorityReservationResult,
  AuthorityFinalState, PriorScope,
} from "./receipts.js";
import type { Receipt, Policy } from "@scopebond/verify";
import type { GatewayAuthentication } from "./auth.js";

/** The subset of Cloudflare's KVNamespace this package uses. A Durable Object's storage fits it too
 *  (`{ get: async (k) => (await storage.get(k)) ?? null, put: (k, v) => storage.put(k, v) }`). */
export interface KvLike {
  get(key: string, type?: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Receipts per log page. A full page is never written again, so it is read once and kept. */
const PAGE_RECEIPTS = 100;
/** A page is also closed once it holds this many bytes, well below a KV value's size limit. */
const PAGE_BYTES = 4 * 1024 * 1024;

/** `count` receipts in `pages` pages; the first `closed` pages are full and hold `closed_count` receipts between them. */
interface LogHead { v: 1; count: number; pages: number; closed: number; closed_count: number }
const EMPTY_HEAD: LogHead = { v: 1, count: 0, pages: 0, closed: 0, closed_count: 0 };

/** What every KvReceiptStore on the same namespace and key shares within one isolate: the write lock, the closed pages
 *  already read, and actions reserved but not yet finished. */
interface Shared {
  tail: Promise<unknown>;
  closedPages: Map<number, SignedReceipt[]>;
  held: Map<string, Receipt>;
}
const sharedState = new WeakMap<object, Map<string, Shared>>();
function sharedFor(kv: object, key: string): Shared {
  let byKey = sharedState.get(kv);
  if (!byKey) { byKey = new Map(); sharedState.set(kv, byKey); }
  let shared = byKey.get(key);
  if (!shared) { shared = { tail: Promise.resolve(), closedPages: new Map(), held: new Map() }; byKey.set(key, shared); }
  return shared;
}

/** The receipt log in a KV namespace. Receipts are appended to pages (`<key>:page:<n>`) under a head record
 *  (`<key>:head`); a full page is closed and never rewritten, so nothing is ever dropped or reordered and anchors keep
 *  matching the log. Every write, and every reservation of a request or approval id, runs one at a time for all stores
 *  on the same namespace and key in this isolate, so concurrent requests cannot lose each other's receipts or both use
 *  one single-use id. Used ids are kept under their own keys (`<key>:used:<kind>:<id>`).
 *
 *  KV has no atomic update across isolates and is eventually consistent between locations, so these guarantees hold for
 *  one writer: a single isolate, or a Durable Object whose storage backs `KvLike`. Several isolates writing the same
 *  namespace at once can still overwrite each other's writes. A log written by the earlier single-array layout (one JSON
 *  array under `key`) is read as the start of the log and moved into pages on the next write. */
export class KvReceiptStore implements ReceiptStore {
  private readonly shared: Shared;
  /** A third argument (the cap of earlier releases) is accepted and ignored: the log is no longer capped. */
  constructor(private readonly kv: KvLike, private readonly key = "receipts", ...legacyCap: [number?]) {
    void legacyCap;
    this.shared = sharedFor(kv, key);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.shared.tail.then(fn, fn);
    this.shared.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  private async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key, "text");
    return raw === null || raw === undefined ? null : JSON.parse(raw) as T;
  }
  private pageKey(n: number): string { return `${this.key}:page:${n}`; }
  private usedKey(kind: string, id: string): string { return `${this.key}:used:${kind}:${id}`; }

  private async page(n: number, head: LogHead): Promise<SignedReceipt[]> {
    const cached = this.shared.closedPages.get(n);
    if (cached) return cached;
    const page = (await this.getJson<SignedReceipt[]>(this.pageKey(n))) ?? [];
    if (n < head.closed) this.shared.closedPages.set(n, page);
    return page;
  }

  /** The log as written: every page in order, cut to the count in the head (a page may hold one more receipt than the
   *  head when a write stopped between the two). Without a head, the earlier single-array layout. */
  private async snapshot(): Promise<{ head: LogHead | null; receipts: SignedReceipt[] }> {
    const head = await this.getJson<LogHead>(`${this.key}:head`);
    if (!head) return { head: null, receipts: (await this.getJson<SignedReceipt[]>(this.key)) ?? [] };
    const pages = await Promise.all(Array.from({ length: head.pages }, (_, n) => this.page(n, head)));
    return { head, receipts: pages.flat().slice(0, head.count) };
  }

  /** Append under the lock. The page is written before the head, so a stop in between leaves the head behind, never ahead. */
  private async append(receipt: SignedReceipt): Promise<void> {
    const head = (await this.getJson<LogHead>(`${this.key}:head`)) ?? await this.migrate();
    const open = head.closed; // the page being filled
    const inOpen = head.count - head.closed_count;
    const existing = inOpen > 0 ? (await this.getJson<SignedReceipt[]>(this.pageKey(open))) ?? [] : [];
    if (existing.length < inOpen) throw new Error("receipt log page is missing receipts its head counts; refusing to append");
    const page = existing.slice(0, inOpen); // a receipt a stopped write left past the head was never acknowledged
    page.push(receipt);
    const text = JSON.stringify(page);
    await this.kv.put(this.pageKey(open), text);
    const full = page.length >= PAGE_RECEIPTS || text.length >= PAGE_BYTES;
    await this.kv.put(`${this.key}:head`, JSON.stringify({
      v: 1, count: head.count + 1, pages: open + 1, closed: full ? open + 1 : open, closed_count: full ? head.count + 1 : head.closed_count,
    } satisfies LogHead));
    if (full) this.shared.closedPages.set(open, page);
  }

  /** Move a log in the earlier single-array layout (one JSON array under `key`) into closed pages, in order. */
  private async migrate(): Promise<LogHead> {
    const legacy = (await this.getJson<SignedReceipt[]>(this.key)) ?? [];
    const head: LogHead = { ...EMPTY_HEAD };
    let page: SignedReceipt[] = [];
    let bytes = 2;
    const write = async (closed: boolean): Promise<void> => {
      await this.kv.put(this.pageKey(head.pages), JSON.stringify(page));
      head.pages += 1;
      head.count += page.length;
      if (closed) { this.shared.closedPages.set(head.closed, page); head.closed += 1; head.closed_count = head.count; }
      page = [];
      bytes = 2;
    };
    for (const r of legacy) {
      page.push(r);
      bytes += JSON.stringify(r).length + 1;
      if (page.length >= PAGE_RECEIPTS || bytes >= PAGE_BYTES) await write(true);
    }
    if (page.length > 0) await write(false);
    if (legacy.length > 0) await this.kv.put(`${this.key}:head`, JSON.stringify(head));
    // The earlier layout kept no used-id records. Only a recent authorization can still be presented again, so the ids
    // of the last two hours of receipts are recorded (not the whole log, which would be one write per receipt).
    const recent = Date.now() - 2 * 60 * 60 * 1000;
    for (const r of legacy) if (Date.parse(r.payload?.timestamp ?? "") >= recent) await this.markUsed(r);
    return head;
  }

  /** Record the request and approval ids a receipt names as used, so they are refused if presented again. */
  private async markUsed(r: SignedReceipt): Promise<void> {
    const auth = r.payload?.authorization;
    const record = JSON.stringify({ action_id: r.payload?.action_ref?.action_id ?? null, at: r.payload?.timestamp ?? null });
    if (auth?.agent?.request_id) await this.kv.put(this.usedKey("request_id", auth.agent.request_id), record);
    if (auth?.approval?.approval_id) await this.kv.put(this.usedKey("approval_id", auth.approval.approval_id), record);
  }

  /** Append a receipt recorded without a reservation (an observation): its ids count as used, as any receipt's do. */
  async put(r: SignedReceipt): Promise<void> {
    await this.exclusive(async () => {
      const receipt = structuredClone(r);
      await this.append(receipt);
      await this.markUsed(receipt);
    });
  }
  async list(): Promise<SignedReceipt[]> { return structuredClone((await this.snapshot()).receipts); }
  async count(): Promise<number> {
    const head = await this.getJson<LogHead>(`${this.key}:head`);
    return head ? head.count : ((await this.getJson<SignedReceipt[]>(this.key)) ?? []).length;
  }
  /** Every stored payload, and the candidates of actions reserved here and not yet finished. */
  async executed(scope?: PriorScope): Promise<Receipt[]> {
    if (scope?.kind === "none") return [];
    const { receipts } = await this.snapshot();
    return structuredClone([...receipts.map((r) => r.payload as unknown as Receipt), ...this.shared.held.values()]);
  }

  /** Whether a request or approval id was consumed by a reservation or named by a stored receipt. Used ids are never
   *  forgotten, so `since` is not needed. */
  async authorizationUsed(kind: "request_id" | "approval_id", id: string): Promise<boolean> {
    return (await this.kv.get(this.usedKey(kind, id), "text")) !== null;
  }

  /** Decide and consume the action's ids in one step: no other write on this namespace runs in between, so two copies
   *  of one authorization cannot both be accepted, and a windowed limit counts every action decided before this one. */
  async reserveAction<T extends { allow: boolean }>(
    reservation: AuthorityReservation, decide: (prior: Receipt[]) => T, scope?: PriorScope,
  ): Promise<AuthorityReservationResult<T>> {
    return this.exclusive(async () => {
      // A log still in the earlier layout is carried over first, so the ids it holds are refused like any other.
      if (!(await this.getJson<LogHead>(`${this.key}:head`))) await this.migrate();
      const ids: Array<[string, string]> = [["action", reservation.action_id]];
      for (const [kind, id] of Object.entries(reservation.authorization_ids ?? {})) if (id) ids.push([kind, id]);
      if (this.shared.held.has(reservation.action_id)) return { duplicate: true };
      for (const [kind, id] of ids) {
        if ((await this.kv.get(this.usedKey(kind, id), "text")) !== null) return { duplicate: true };
      }
      const decision = decide(await this.executed(scope));
      const record = JSON.stringify({ action_id: reservation.action_id, at: reservation.candidate.timestamp });
      for (const [kind, id] of ids) await this.kv.put(this.usedKey(kind, id), record);
      if (decision.allow) this.shared.held.set(reservation.action_id, structuredClone(reservation.candidate));
      return { duplicate: false, decision };
    });
  }

  async finalizeAction(actionId: string, receipt: SignedReceipt, state: AuthorityFinalState): Promise<void> {
    void state; // nothing is dispatched through this store, so every final state ends the hold
    await this.exclusive(async () => {
      await this.append(structuredClone(receipt));
      this.shared.held.delete(actionId);
    });
  }

  async putAnchor(a: Anchor): Promise<void> {
    await this.exclusive(async () => {
      const all = (await this.getJson<Anchor[]>(this.key + ":anchors")) ?? [];
      all.push(a);
      await this.kv.put(this.key + ":anchors", JSON.stringify(all));
    });
  }
  async anchors(): Promise<Anchor[]> { return (await this.getJson<Anchor[]>(this.key + ":anchors")) ?? []; }
  async getStopState(): Promise<StopState> {
    return (await this.getJson<StopState>(this.key + ":stops")) ?? { global: false, agents: [] };
  }
  async setStopped(target: string, stopped: boolean): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.getStopState();
      const agents = new Set(state.agents);
      if (target === "global") state.global = stopped;
      else if (stopped) agents.add(target); else agents.delete(target);
      state.agents = [...agents].sort();
      await this.kv.put(this.key + ":stops", JSON.stringify(state));
    });
  }
}

/** Load the attester key from KV, or generate + persist one. Returns a WebCrypto
 *  attester with a stable kid — so receipts stay verifiable across requests. */
export async function loadOrCreateKvAttester(kv: KvLike, key = "attester:jwk"): Promise<Attester> {
  const shared = sharedFor(kv, key);
  const run = shared.tail.then(async () => {
    let raw = await kv.get(key, "text");
    if (!raw) {
      raw = JSON.stringify(await generateAttesterJwk());
      await kv.put(key, raw);
    }
    return raw;
  });
  shared.tail = run.then(() => undefined, () => undefined);
  return createWebCryptoAttester(JSON.parse(await run));
}

/** Build a gateway for a Worker: a persistent KV attester + KV receipt store. Create it once per isolate (at module
 *  scope) and, for more than one writer, back `kv` with a Durable Object's storage: see `KvReceiptStore`. */
export async function createWorkerGateway(opts: {
  policy: Policy;
  kv: KvLike;
  authentication: GatewayAuthentication;
  attesterKey?: string;
}): Promise<Gateway> {
  const attester = await loadOrCreateKvAttester(opts.kv, opts.attesterKey);
  return createGateway({ policy: opts.policy, attester, store: new KvReceiptStore(opts.kv), authentication: opts.authentication });
}
