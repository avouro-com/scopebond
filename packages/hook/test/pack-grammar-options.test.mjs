// The grammar options a pack may set to read a command line the way a tool does, and the switches a parity check needs:
// path_options, strict_unknown, fallback_on_any_option, fallback_only_unread, double_dash, the unknown_option condition,
// positionals past an unknown option, the MCP profile that owns a call, and turning the built-in readers off. Every tool and
// server here is made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePack } from "@scopebond/policy-schema/pack";
import {
  decomposeShell, deriveFromGrammar, derivePackMcp, setBuiltinReaders, builtinReadersOn, setActivePacks, mapClaudeToolUse,
} from "../dist/index.js";

const one = (command) => { const [sc] = decomposeShell(command); return sc; };
const types = (actions) => actions.map((a) => a.action_type);
const del = { action_type: "cloud.resource.delete", params: { provider: { const: "unknown" }, risk_class: { const: "destructive" } } };
const name = (expr) => ({ action_type: "cloud.resource.delete", params: { provider: { const: "unknown" }, resource_digest: { digest: ["demo", expr] }, risk_class: { const: "destructive" } } });
const grammar = (extra) => ({ id: "demo", programs: ["democtl"], commands: [{ path: ["volume", "delete"], emit: [name({ positional: 0 })] }], ...extra });

/** A pack around grammars and profiles, only for the shape check. */
const pack = (grammars, profiles = []) => ({
  format: "scopebond:pack/v1", id: "demo", version: "1.0.0", issued_at: "2026-10-18T00:00:00Z", signature: { alg: "Ed25519", key_id: "k", value: `${"A".repeat(86)}==` },
  grammars, profiles, rules: [], vectors: [{ id: "v", shell: { command: "democtl x" }, expect: [] }],
});

test("the new grammar options and operators are part of the closed format", () => {
  const g = grammar({
    path_options: "known", strict_unknown: true, fallback_on_any_option: true, fallback_only_unread: true, double_dash: "positionals",
    fallback: [{ when: { all: [{ unknown_option: true }, { word: ["delete"] }] }, emit: [del] }],
    commands: [{ path: ["secret", "set"], emit: [{ ...name({ item: 1 }), for_each: { positionals: { from: 0, past_unknown: true } }, item_pattern: "^([A-Z]+)=" }] }],
  });
  assert.deepEqual(validatePack(pack([g])).errors, []);
  for (const bad of [{ path_options: "any" }, { double_dash: "keep" }, { strict_unknown: "yes" }, { fallback_only_unread: 1 }]) {
    assert.equal(validatePack(pack([grammar(bad)])).valid, false, JSON.stringify(bad));
  }
  assert.equal(validatePack(pack([grammar({ fallback: [{ when: { unknown_option: false }, emit: [del] }] })])).valid, false);
  assert.equal(validatePack(pack([grammar({ commands: [{ path: [], emit: [{ ...del, for_each: { positionals: { from: 0, past_unknown: false } } }] }] })])).valid, false);
});

test("path_options known: an unknown option before the path ends it, even with its value; after the path it does not", () => {
  const g = grammar({ path_options: "known", options: { valued: ["--region"] } });
  assert.equal(deriveFromGrammar(one("democtl --region x volume delete v1"), g).length, 1, "a known option before the path");
  assert.equal(deriveFromGrammar(one("democtl --mode=fast volume delete v1"), g).length, 0, "an unknown --name=value before the path");
  assert.equal(deriveFromGrammar(one("democtl volume delete v1 --mode=fast"), g).length, 1, "after the path");
  assert.equal(deriveFromGrammar(one("democtl volume delete --mode=fast v1"), grammar({}))[0].params.resource_digest !== undefined, true, "by default --name=value never ends the positionals");
});

test("path_options none: any option before the path ends it, takes no value, and counts as unknown", () => {
  const g = grammar({ path_options: "none", options: { valued: ["-v"] }, fallback_on_any_option: true, fallback: [{ when: { word: ["delete"] }, emit: [del] }] });
  const a = deriveFromGrammar(one("democtl -v volume delete v1"), g);
  assert.deepEqual(types(a), ["cloud.resource.delete"]);
  assert.equal(a[0].params.resource_digest, undefined, "the fallback, with no names: -v took no value, and volume is a word");
  assert.ok(deriveFromGrammar(one("democtl volume delete -v x v1"), g)[0].params.resource_digest, "after the first word, -v takes its value");
});

test("strict_unknown: an unknown --name=value ends the certain positionals", () => {
  const g = grammar({ strict_unknown: true });
  assert.equal(deriveFromGrammar(one("democtl volume delete --mode=fast v1"), g)[0].params.resource_digest, undefined);
  assert.ok(deriveFromGrammar(one("democtl volume delete v1 --mode=fast"), g)[0].params.resource_digest);
});

test("fallback_on_any_option and fallback_only_unread decide when the fallback runs", () => {
  const fallback = [{ when: { word: ["delete"] }, emit: [del] }];
  const reads = { path: [{ var: "noun" }, { var: "verb" }], emit: [] };
  const plain = grammar({ options: { flags: ["--yes"] }, fallback, commands: [reads] });
  assert.equal(deriveFromGrammar(one("democtl --yes x delete"), plain).length, 0, "a known option is not uncertain");
  assert.equal(deriveFromGrammar(one("democtl --yes x delete"), { ...plain, fallback_on_any_option: true }).length, 1, "unless any option counts");
  assert.equal(deriveFromGrammar(one("democtl x delete --odd"), plain).length, 1, "a command that derived nothing falls back");
  assert.equal(deriveFromGrammar(one("democtl x delete --odd"), { ...plain, fallback_only_unread: true }).length, 0, "only when no command read it, with fallback_only_unread");
  assert.equal(deriveFromGrammar(one("democtl --odd x delete"), { ...plain, fallback_only_unread: true }).length, 1);
});

test("double_dash positionals: the words after -- are read too", () => {
  const g = grammar({ commands: [{ path: ["volume", "delete"], max_positionals: 1, emit: [name({ positional: 0 })] }] });
  assert.equal(deriveFromGrammar(one("democtl volume delete v1 -- more"), g).length, 1);
  assert.equal(deriveFromGrammar(one("democtl volume delete v1 -- more"), { ...g, double_dash: "positionals" }).length, 0);
});

test("unknown_option and positionals past_unknown", () => {
  const g = grammar({ commands: [{ path: ["secret", "set"], emit: [
    { ...name({ item: 1 }), for_each: { positionals: { from: 0, past_unknown: true } }, item_pattern: "^([A-Z]+)=" },
    { ...del, when: { unknown_option: true } },
  ] }] });
  const a = deriveFromGrammar(one("democtl secret set A=1 --odd B=2"), g);
  assert.equal(a.length, 3, "both names, and the unknown option seen");
  assert.equal(deriveFromGrammar(one("democtl secret set A=1 B=2"), g).length, 2);
});

test("MCP: the first profile whose words name the server owns the call; the hint only when none does", () => {
  const act = (via) => ({ action_type: "work.item.create", params: { provider: { const: via }, risk_class: { const: "routine" } } });
  const p = {
    ...pack([], [
      { id: "tracker", servers: ["tracker"], tools: [{ names: ["create"], emit: [act("tracker")] }] },
      { id: "notes", servers: ["notes"], tools: [{ names: ["create", "update"], emit: [act("notes")] }] },
    ]),
  };
  assert.deepEqual(derivePackMcp("tracker-notes", "update", {}, undefined, [p]), [], "tracker owns it, and lists no update");
  assert.equal(derivePackMcp("notes", "create", {}, "tracker-url", [p])[0].params.provider, "notes", "the configured name wins over the hint");
  assert.equal(derivePackMcp("mine", "create", {}, "https://tracker.example/mcp", [p])[0].params.provider, "tracker", "the hint, when the name says nothing");
});

test("the built-in readers can be turned off (a parity check), and are on by default", () => {
  assert.equal(builtinReadersOn(), true);
  const command = "kubectl delete ns staging";
  const withBuiltIns = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } });
  setActivePacks([]);
  setBuiltinReaders(false);
  try {
    assert.deepEqual(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } }).map((m) => m.intent.action_type), ["shell.exec"]);
  } finally { setBuiltinReaders(true); }
  assert.ok(withBuiltIns.length > 1);
});
