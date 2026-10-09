// Property-based tests (fast-check): invariants that must hold for every input, not only the examples the other suites pick.
// A failure prints the smallest counterexample fast-check found, and its seed reproduces the run.
// A .js file (ESM: the package is "type": "module") because the OpenSSF Scorecard fuzzing check reads .js/.ts files, not .mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { compileManaged, defaultRules, digestRules, scrubSecrets, redactCommand, mapClaudeToolUse } from "../dist/index.js";

const INSTALLATION = "gw-prop-1";
const AGENT_KID = "agent-prop";
const managedDoc = (allowedHosts) => {
  const rules = {
    "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
    "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "block", allowed_hosts: allowedHosts },
  };
  return {
    type: "scopebond:managed-rules", version: 1, revision: 1, export_id: `rev-1-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules_catalog_version: "coding-pack/3", rules, rules_digest: digestRules(rules),
  };
};
/** The host bound the workspace's allowed sites compile to. */
const hostBound = (allowedHosts) => {
  const policy = compileManaged(defaultRules(), managedDoc(allowedHosts), AGENT_KID);
  const patterns = policy.clauses.map((c) => c.param_bounds?.host?.pattern).filter(Boolean);
  assert.equal(patterns.length, 1, "exactly one clause bounds the host");
  // eslint-disable-next-line security/detect-non-literal-regexp -- test-only; the compiled host pattern is the thing under test
  return new RegExp(patterns[0]);
};

// Host names the managed document accepts: lowercase labels of letters, digits and inner hyphens, and a letter-only top level.
// eslint-disable-next-line security/detect-unsafe-regex -- test-only generator pattern; bounded ({0,10}) and never run on outside input
const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
const host = fc.tuple(fc.array(label, { minLength: 1, maxLength: 3 }), fc.stringMatching(/^[a-z]{2,6}$/)).map(([labels, tld]) => [...labels, tld].join("."));
const mixCase = (text, flips) => [...text].map((c, i) => (flips[i % flips.length] ? c.toUpperCase() : c)).join("");

test("allowed sites: the host bound matches each named host in any case, and nothing longer or shorter", () => {
  fc.assert(fc.property(fc.uniqueArray(host, { minLength: 1, maxLength: 4 }), fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), label, (hosts, flips, extra) => {
    const bound = hostBound(hosts);
    for (const h of hosts) {
      assert.ok(bound.test(h), `${h} is allowed`);
      assert.ok(bound.test(mixCase(h, flips)), `${mixCase(h, flips)} is allowed (hosts are case-insensitive)`);
      // A name the list does not hold stays outside it: a longer name ending in the host, one with a site appended, or a prefix.
      if (!hosts.includes(`${extra}.${h}`)) assert.ok(!bound.test(`${extra}.${h}`), `${extra}.${h} is not allowed`);
      if (!hosts.includes(`${extra}${h}`)) assert.ok(!bound.test(`${extra}${h}`), `${extra}${h} is not allowed`);
      assert.ok(!bound.test(`${h}.evil.example`), `${h}.evil.example is not allowed`);
      assert.ok(!bound.test(`${h}\n`), "a trailing newline is not allowed");
    }
  }), { numRuns: 200 });
});

test("allowed sites: a wildcard allows every subdomain of the site and not the site itself", () => {
  fc.assert(fc.property(host, fc.array(label, { minLength: 1, maxLength: 3 }), (site, subs) => {
    const bound = hostBound([`*.${site}`]);
    assert.ok(bound.test(`${subs.join(".")}.${site}`));
    assert.ok(!bound.test(site), "the bare site is not a subdomain");
    assert.ok(!bound.test(`${subs.join("")}${site}`), "a name merely ending in the site is not a subdomain");
  }), { numRuns: 200 });
});

// GitHub tokens of the shapes the scrubber recognizes, embedded in arbitrary text after a separator a command or log would use.
const githubToken = fc.oneof(
  fc.tuple(fc.constantFrom("ghp_", "gho_", "ghu_", "ghs_", "ghr_"), fc.stringMatching(/^[A-Za-z0-9]{36}$/)).map(([p, s]) => p + s),
  fc.stringMatching(/^[A-Za-z0-9_]{40,82}$/).map((s) => `github_pat_${s}`),
);
const separator = fc.constantFrom(" ", "=", ":", "\"", "'", "/", "\n", "\t", "(", ",");

test("scrubbing: a GitHub token never survives, wherever it sits in the text", () => {
  fc.assert(fc.property(fc.string(), separator, githubToken, separator, fc.string(), (before, s1, token, s2, after) => {
    const text = `${before}${s1}${token}${s2}${after}`;
    assert.ok(!scrubSecrets(text).includes(token), "scrubSecrets removed the token");
    assert.ok(!redactCommand(`curl -H ${text}`).includes(token), "redactCommand removed the token");
  }), { numRuns: 500 });
});

test("scrubbing: scrubbed text is a fixed point, so a record scrubbed twice reads the same", () => {
  fc.assert(fc.property(fc.string(), separator, fc.option(githubToken, { nil: "" }), fc.string(), (before, s1, token, after) => {
    const once = scrubSecrets(`${before}${s1}${token} ${after}`);
    assert.equal(scrubSecrets(once), once);
  }), { numRuns: 500 });
});

test("mapping: any Claude Code tool call maps to an intent without throwing", () => {
  const toolInput = fc.oneof(
    fc.record({ command: fc.string() }),
    fc.record({ file_path: fc.string(), content: fc.string() }),
    fc.record({ url: fc.string(), prompt: fc.string() }),
    fc.jsonValue(),
  );
  const toolName = fc.oneof(fc.constantFrom("Bash", "Write", "Edit", "Read", "WebFetch", "Grep", "Glob", "MultiEdit", "NotebookEdit"), fc.string());
  fc.assert(fc.property(toolName, toolInput, fc.constantFrom("/repo", "C:\\repo", ""), (tool_name, tool_input, cwd) => {
    const mapped = mapClaudeToolUse({ tool_name, tool_input, cwd });
    assert.equal(typeof mapped, "object");
    assert.notEqual(mapped, null);
  }), { numRuns: 500 });
});
