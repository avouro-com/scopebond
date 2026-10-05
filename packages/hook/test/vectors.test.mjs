// R04-R10 and the catalog classes, as one table: every vector goes through the mapper,
// the compiled default policy (a real signed decision) and the catalog classifier, and
// the three must agree. Windows PowerShell and POSIX spellings are in the same table;
// the mapper is pure, so both run on every host. Vectors that need a real filesystem
// (workspace root scope) run only on a host with the matching path style.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VECTORS, mapVector, classifyIntent, classificationBlocks, BLOCKING, defaultRules, compile, saveRules,
  scaffold, createHookRuntime, fillPushBranch, applyRootScope, classifyRoot,
} from "../dist/index.js";

const temps = [];
after(() => { for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a still-open handle on Windows; the OS temp dir is cleaned later */ } } });
const temp = (prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); temps.push(dir); return dir; };

function runtimeFor(rules) {
  const dir = temp("sb-vec-");
  scaffold(dir);
  const policyPath = join(dir, "policy.json");
  if (rules) {
    const kid = JSON.parse(readFileSync(policyPath, "utf8")).clauses.find((c) => c.type === "key_policy").active_keys[0];
    saveRules(dir, rules);
    writeFileSync(policyPath, JSON.stringify(compile(rules, kid), null, 2));
  }
  return createHookRuntime({
    policyPath, keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
    cwd: rules ? rules.__cwd : undefined,
  });
}

const platform = process.platform === "win32" ? "win32" : "posix";
const base = VECTORS.filter((v) => !v.roots);
const scoped = VECTORS.filter((v) => v.roots);

const runtime = runtimeFor();
after(() => runtime.close());

test("the vector table covers every rule R04-R10 and both dialects", () => {
  for (const rule of ["R04", "R05", "R06", "R08", "R09", "R10", "C02"]) {
    assert.ok(VECTORS.some((v) => v.rule === rule && v.dialect === "powershell"), `${rule} has a PowerShell vector`);
    assert.ok(VECTORS.some((v) => v.rule === rule && v.dialect === "posix"), `${rule} has a POSIX vector`);
  }
  assert.equal(new Set(VECTORS.map((v) => v.id)).size, VECTORS.length, "vector ids are unique");
});

for (const v of base) {
  test(`${v.id} ${v.agent}/${v.dialect}: ${v.expect} ${v.catalog.join("+") || "-"}${v.unknown ? " unknown" : ""}${v.gap ? " (documented gap)" : ""}`, async () => {
    const mapped = fillPushBranch(mapVector(v), "feature/work");
    const rules = defaultRules();
    // Catalog side: the blocking classes the intents carry, and whether any is unresolved.
    const classes = new Set();
    let unknown = false;
    let blocked = false;
    for (const m of mapped) {
      const c = classifyIntent(m.intent, rules);
      c.ids.filter((id) => BLOCKING.includes(id)).forEach((id) => classes.add(id));
      if (c.unknown.length) unknown = true;
      if (classificationBlocks(c)) blocked = true;
    }
    assert.deepEqual([...classes].sort(), [...v.catalog].sort(), "catalog classes");
    assert.equal(unknown, v.unknown === true, "unknown classification");
    // Compiled-policy side: a real signed decision.
    const decision = await runtime.evaluate(mapped);
    assert.equal(decision.decision === "deny" ? "deny" : "allow", v.expect, `policy decision (${decision.reason?.split("\n")[0]})`);
    // Parity: the catalog blocks exactly when the compiled policy denies.
    assert.equal(blocked, decision.decision === "deny", "classification agrees with the compiled policy");
  });
}

for (const v of scoped) {
  const runnable = v.roots === platform;
  test(`${v.id} ${v.agent}/${v.dialect}: ${v.expect} ${v.catalog.join("+") || "-"} [root scope]`, { skip: runnable ? false : `needs a ${v.roots} host` }, async () => {
    const cwd = realpathSync(temp("sb-root-"));
    mkdirSync(join(cwd, "sub"));
    const rules = { ...defaultRules(), allowed_roots: ["."] };
    const dir = temp("sb-vec-roots-");
    scaffold(dir);
    const policyPath = join(dir, "policy.json");
    const kid = JSON.parse(readFileSync(policyPath, "utf8")).clauses.find((c) => c.type === "key_policy").active_keys[0];
    saveRules(dir, rules);
    writeFileSync(policyPath, JSON.stringify(compile(rules, kid), null, 2));
    const rt = createHookRuntime({ policyPath, keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "r.db"), cwd });
    try {
      const mapped = mapVector(v, cwd);
      const scopedIntents = applyRootScope(mapped, { cwd, roots: ["."] });
      const classes = new Set();
      for (const m of scopedIntents) classifyIntent(m.intent, rules).ids.filter((id) => BLOCKING.includes(id)).forEach((id) => classes.add(id));
      assert.deepEqual([...classes].sort(), [...v.catalog].sort(), "catalog classes");
      const decision = await rt.evaluate(mapped);
      assert.equal(decision.decision === "deny" ? "deny" : "allow", v.expect, decision.reason?.split("\n")[0]);
    } finally { rt.close(); }
  });
}

test("a symlink inside the workspace that leads outside is a root escape (junction on Windows)", async (t) => {
  const outside = realpathSync(temp("sb-outside-"));
  const cwd = realpathSync(temp("sb-work-"));
  try { symlinkSync(outside, join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { t.skip(`cannot create a link here: ${error.code}`); return; }
  assert.equal(classifyRoot("alias/file.txt", { cwd, roots: ["."] }), "outside", "written through the alias");
  assert.equal(classifyRoot("alias", { cwd, roots: ["."] }), "outside", "the alias itself resolves outside");
  assert.equal(classifyRoot("plain/file.txt", { cwd, roots: ["."] }), "inside", "a not-yet-created path under the root");
  assert.equal(classifyRoot("../x", { cwd, roots: ["."] }), "outside");
});

test("a target that cannot be resolved is unresolved, never inside", () => {
  const cwd = realpathSync(temp("sb-work-"));
  const failing = () => { const error = new Error("denied"); error.code = "EACCES"; throw error; };
  assert.equal(classifyRoot("a/b.txt", { cwd, roots: ["."], realpath: failing }), "unresolved");
  assert.equal(classifyRoot("", { cwd, roots: ["."] }), "unresolved");
});

test("root scope stamps every write, including rename destinations and link targets", () => {
  const cwd = realpathSync(temp("sb-work-"));
  const mapped = mapVector(VECTORS.find((v) => v.rule === "R05" && v.input.tool_input?.command === "mv a.txt sub/b.txt"), cwd);
  const stamped = applyRootScope(mapped, { cwd, roots: ["."] });
  const writes = stamped.filter((m) => m.intent.action_type === "file.write");
  assert.ok(writes.length >= 2, "source removal and destination are both writes");
  assert.ok(writes.every((m) => m.intent.params.root_scope === "inside"));
  assert.ok(stamped.filter((m) => m.intent.action_type !== "file.write").every((m) => m.intent.params.root_scope === undefined));
});

test("without allowed_roots the compiled policy has no root clause (default unchanged)", () => {
  assert.equal(compile(defaultRules(), "k").clauses.some((c) => c.id === "protect-root"), false);
  const withRoots = compile({ ...defaultRules(), allowed_roots: ["."] }, "k");
  assert.ok(withRoots.clauses.some((c) => c.id === "protect-root"));
});

test("a write is denied when the hook never stamped its root scope (fail closed)", async () => {
  const dir = temp("sb-vec-closed-");
  scaffold(dir);
  const policyPath = join(dir, "policy.json");
  const kid = JSON.parse(readFileSync(policyPath, "utf8")).clauses.find((c) => c.type === "key_policy").active_keys[0];
  // A policy that demands a root scope, but no rules.json listing roots: nothing stamps it.
  writeFileSync(policyPath, JSON.stringify(compile({ ...defaultRules(), allowed_roots: ["."] }, kid)));
  rmSync(join(dir, "rules.json"), { force: true });
  const rt = createHookRuntime({ policyPath, keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "r.db") });
  try {
    const decision = await rt.evaluate(mapVector(VECTORS.find((v) => v.rule === "R08" && v.expect === "allow" && v.agent === "claude" && v.dialect === "posix" && v.cell?.action_type === "file.write")));
    assert.equal(decision.decision, "deny");
  } finally { rt.close(); }
});

test("root scope on POSIX-style paths (pure, with an injected resolver so it runs on every host)", () => {
  const identity = (p) => p;
  const opts = { cwd: "/tmp/w", roots: ["."], realpath: identity };
  assert.equal(classifyRoot("src/a.ts", opts), "inside");
  assert.equal(classifyRoot("a/../b.txt", opts), "inside");
  assert.equal(classifyRoot("../out.txt", opts), "outside");
  assert.equal(classifyRoot("/etc/passwd", opts), "outside");
  assert.equal(classifyRoot("/tmp/w-other/x", opts), "outside", "a sibling with the root as a name prefix is outside");
  // A link inside the root that resolves elsewhere.
  const linked = (p) => (p === "/tmp/w/alias" ? "/etc" : p);
  const withLink = { cwd: "/tmp/w", roots: ["."], realpath: (p) => { if (p.startsWith("/tmp/w/alias/") && !p.endsWith("new.txt")) return linked(p); if (p === "/tmp/w/alias/new.txt") { const e = new Error("nope"); e.code = "ENOENT"; throw e; } return linked(p); } };
  assert.equal(classifyRoot("alias/new.txt", withLink), "outside");
  // Windows-style paths fold case and separators.
  assert.equal(classifyRoot("C:\\W\\Sub\\x.txt", { cwd: "C:\\w", roots: ["."], realpath: identity }), "inside");
  assert.equal(classifyRoot("C:\\Other\\x.txt", { cwd: "C:\\w", roots: ["."], realpath: identity }), "outside");
  assert.equal(classifyRoot("..\\x.txt", { cwd: "C:\\w", roots: ["."], realpath: identity }), "outside");
});
