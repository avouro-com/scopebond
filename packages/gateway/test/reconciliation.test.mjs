import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGateway, createSupportRefundExecutor, MemoryReceiptStore,
} from "../dist/index.js";
import { loadOrCreateAttester, openReceiptStore } from "../dist/node.js";

const CONTROL_TOKEN = "test-control-token-000000000001";
const policy = {
  vocabulary_version: "1.0", policy_id: "refund-recovery", version: 1,
  clauses: [
    { id: "actions", type: "action_allowlist", mode: "enforce", action_types: ["support.refund"] },
    { id: "cap", type: "spend_limit", mode: "enforce", asset: "USD", max_per_action: 500 },
  ],
};
const intent = {
  action_type: "support.refund", asset: "USD", amount: 100,
  params: { ticket_id: "ticket_1", payment_id: "payment_1", reason_code: "customer_request" },
};

function upstream({ queryAvailable = true } = {}) {
  const effects = new Map();
  const calls = [];
  const fetch = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, method: init.method });
    if (init.method === "POST") {
      const actionId = init.headers["idempotency-key"];
      effects.set(actionId, { refund_id: "refund_1" });
      throw new Error("response lost after commit");
    }
    if (!queryAvailable) return new Response("unavailable", { status: 503 });
    const actionId = decodeURIComponent(parsed.pathname.split("/").at(-1));
    const found = effects.get(actionId);
    return found
      ? new Response(JSON.stringify(found), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
  };
  return { effects, calls, fetch };
}

function executor(service) {
  return createSupportRefundExecutor({
    origin: "https://support.example.test", apiToken: "sandbox-refund-secret-00000001", fetch: service.fetch,
  });
}

test("a lost response is queried by action id and finalized without replay", async () => {
  const service = upstream();
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, policy, executor: executor(service) });
  const result = await gateway.handleAction({ intent });
  assert.equal(result.receipt.payload.execution.state, "executed");
  assert.equal(service.effects.size, 1);
  assert.deepEqual(service.calls.map((call) => call.method), ["POST", "GET"]);
  assert.equal((await gateway.unresolvedActions()).length, 0);
});

test("an unavailable result query preserves outcome_unknown and exposes it only through control auth", async () => {
  const service = upstream({ queryAvailable: false });
  const gateway = createGateway({
    authentication: { mode: "insecure-development" }, policy, executor: executor(service),
    control: { bearerToken: CONTROL_TOKEN },
  });
  const response = await gateway.app.request("/v1/evaluate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent }),
  });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.receipt.payload.execution.state, "outcome_unknown");
  assert.equal((await gateway.app.request("/v1/actions/unresolved")).status, 401);
  const unresolved = await gateway.app.request("/v1/actions/unresolved", {
    headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
  });
  assert.equal(unresolved.status, 200);
  assert.equal((await unresolved.json()).actions[0].state, "outcome_unknown");
});

test("SQLite restart reconciles an unknown effect under its pinned policy", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "scopebond-reconcile-"));
  try {
    const service = upstream({ queryAvailable: false });
    const keyFile = join(directory, "attester.key");
    const dbFile = join(directory, "receipts.db");
    const { attester } = loadOrCreateAttester({ file: keyFile });
    const firstStore = openReceiptStore({ db: dbFile });
    if (firstStore.kind !== "sqlite") { t.skip("node:sqlite unavailable"); return; }
    const first = createGateway({ authentication: { mode: "insecure-development" }, policy, executor: executor(service), store: firstStore.store, attester });
    const unknown = await first.handleAction({ intent });
    const actionId = unknown.receipt.payload.action_ref.action_id;
    assert.equal(unknown.receipt.payload.execution.state, "outcome_unknown");
    await firstStore.store.close?.();

    service.fetch = upstream().fetch;
    const recoveryFetch = async (url, init) => {
      if (init.method === "GET") {
        return new Response(JSON.stringify({ refund_id: "refund_1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("reconciliation must never redispatch");
    };
    const secondStore = openReceiptStore({ db: dbFile });
    const second = createGateway({
      authentication: { mode: "insecure-development" },
      policy: { ...policy, version: 2 }, executor: createSupportRefundExecutor({
        origin: "https://support.example.test", apiToken: "sandbox-refund-secret-00000001", fetch: recoveryFetch,
      }),
      store: secondStore.store, attester,
    });
    const reconciled = await second.reconcileAction(actionId);
    assert.equal(reconciled.state, "executed");
    assert.equal(reconciled.terminal_receipt.payload.policy_ref.version, 1);
    assert.equal(reconciled.terminal_receipt.payload.action_ref.action_id, actionId);
    assert.equal((await second.unresolvedActions()).length, 0);
    assert.equal((await secondStore.store.list()).length, 2, "unknown evidence remains append-only beside its resolution");
    await secondStore.store.close?.();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a crash before the durable dispatch marker reconciles as confirmed failed", async () => {
  class FailPrepareStore extends MemoryReceiptStore {
    prepareDispatch() { throw new Error("synthetic crash before dispatch marker"); }
  }
  let executions = 0;
  const store = new FailPrepareStore();
  const gateway = createGateway({
    authentication: { mode: "insecure-development" }, policy, store,
    executor: { id: "test:no-dispatch", mode: "dispatch", execute: () => { executions++; return { ref: "unexpected" }; } },
  });
  await assert.rejects(gateway.handleAction({ intent }), /before dispatch marker/);
  const [record] = await gateway.unresolvedActions();
  assert.equal(record.state, "reserved");
  const recovery = createGateway({
    authentication: { mode: "insecure-development" }, policy, store, outboundExecution: false,
    executor: { id: "test:no-dispatch", mode: "dispatch", execute: () => { executions++; return { ref: "unexpected" }; } },
  });
  const reconciled = await recovery.reconcileAction(record.action_id);
  assert.equal(reconciled.state, "failed");
  assert.equal(reconciled.terminal_receipt.payload.execution.reference, "gateway:dispatch-not-started");
  assert.equal(executions, 0);
});

test("a result persisted upstream but lost before receipt finalization is recoverable", async () => {
  class FailFirstFinalizeStore extends MemoryReceiptStore {
    attempts = 0;
    finalizeAction(actionId, receipt, state) {
      this.attempts++;
      if (this.attempts === 1) throw new Error("synthetic receipt persistence failure");
      return super.finalizeAction(actionId, receipt, state);
    }
  }
  const store = new FailFirstFinalizeStore();
  let dispatches = 0;
  let queries = 0;
  const adapter = {
    id: "test:recover-finalization",
    mode: "dispatch",
    execute: () => { dispatches++; return { ref: "upstream:committed" }; },
    query: () => { queries++; return { state: "executed", ref: "upstream:committed" }; },
  };
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, policy, store, executor: adapter });
  await assert.rejects(gateway.handleAction({ intent }), /receipt persistence failure/);
  const [unresolved] = await gateway.unresolvedActions();
  assert.equal(unresolved.state, "dispatching");
  const reconciled = await gateway.reconcileAction(unresolved.action_id);
  assert.equal(reconciled.state, "executed");
  assert.equal(reconciled.terminal_receipt.payload.execution.reference, "upstream:committed");
  assert.equal(dispatches, 1);
  assert.equal(queries, 1);
});

test("recovery mode preserves unknown actions without result queries or dispatch", async () => {
  const service = upstream({ queryAvailable: false });
  const store = new MemoryReceiptStore();
  const first = createGateway({ authentication: { mode: "insecure-development" }, policy, store, executor: executor(service) });
  const unknown = await first.handleAction({ intent });
  const before = service.calls.length;
  const recovery = createGateway({
    authentication: { mode: "insecure-development" }, policy, store, executor: executor(service), outboundExecution: false,
  });
  await assert.rejects(
    recovery.reconcileAction(unknown.receipt.payload.action_ref.action_id),
    /disabled in recovery mode/,
  );
  assert.equal(service.calls.length, before);
  assert.equal((await recovery.unresolvedActions())[0].state, "outcome_unknown");
});
