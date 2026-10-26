// Every pattern the hook writes into a policy passes the shared pattern check (@scopebond/policy-schema/pattern), which the
// verifier applies to every policy it loads. A builder that produced a pattern the check refuses would make the whole policy
// invalid, and every call would be denied, so each builder is run here over representative inputs: the starter and floor
// policies, the computer's own rules with custom lists, a workspace's rules with every list, exclusion and exception it can
// set (allowed sites with wildcards included), blocked services of every kind, and the rule packs' clauses.
//
// And when a workspace answer would still compile to such a pattern, it is refused as a whole: the rules in force stay, and
// the refusal says which pattern and why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patternProblem, POLICY_PATTERN_MAX } from "@scopebond/policy-schema/pattern";
import { validatePolicy } from "@scopebond/verify";
import {
  scaffold, compile, defaultRules, pathRuleFor, starterPolicy, inspectManaged, compileManaged, installManaged, digestManaged, policyBuilds,
  blockedServiceClauses, packRuleClauses, packRuleAdjustments, MANAGED_DOC_FILE,
} from "../dist/index.js";
import { selfProtectionClauses, withSelfProtection } from "../dist/runtime.js";
import { shellExceptionBounds, packExceptionBounds } from "../dist/rule-exceptions.js";
import { maskHomeInPolicy } from "../dist/home-mask.js";
import { TARGET_PACK } from "./target-pack.mjs";

const packs = ["build-hygiene", "ci-guard", "git-safety", "secrets-hygiene"].map((id) => JSON.parse(readFileSync(new URL(`../packs/${id}.json`, import.meta.url), "utf8")));
// Home folders as the masking reads them, built from parts as the home-mask tests write them.
const P = (...parts) => parts.join("/");
const W = (...parts) => parts.join("\\");
const HOMES = [P("", "home", "dev"), P("C:", "Users", "Dev")];

/** Every pattern in a policy or a list of clauses, with where it is. */
function patternsOf(value, at = "") {
  const out = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (k === "pattern" && typeof x === "string") out.push([path, x]);
      else walk(x, `${path}.${k}`);
    }
  };
  walk(value, at);
  return out;
}

function assertAllBounded(label, value) {
  const found = patternsOf(value);
  assert.ok(found.length > 0, `${label}: no patterns found`);
  for (const [where, pattern] of found) {
    const problem = patternProblem(pattern, POLICY_PATTERN_MAX);
    assert.equal(problem, null, `${label} ${where}: ${problem}\n  ${pattern.slice(0, 300)}`);
  }
  return found.length;
}

function assertValidPolicy(label, policy) {
  assertAllBounded(label, policy);
  const result = validatePolicy(policy);
  assert.ok(result.valid, `${label}: ${result.errors.join("; ")}`);
  // The same policy as it is loaded on a computer: the home folder masked in every pattern.
  const masked = maskHomeInPolicy(policy, HOMES);
  assertAllBounded(`${label} (home masked)`, masked);
  assert.ok(validatePolicy(masked).valid, `${label} (home masked): ${validatePolicy(masked).errors.join("; ")}`);
}

const INSTALLATION = "gw-patterns";
const rich = () => ({
  "force-push-protected": { mode: "block", protected_branches: ["main", "release/*", "hotfix/*", "prod"] },
  "push-protected": { mode: "block", protected_branches: ["main", "release/*", "v1.x"], excluded_branches: ["release/notes", "docs/site"] },
  "destructive-shell": {
    mode: "block", destructive_programs: ["shred", "dd", "mkfs.ext4", "terraform"],
    exceptions: [{ programs: ["rm"], targets: ["/tmp/scratch/**", "~/build/*/out", "c:/work/*/dist", "/srv/cache"] }, { programs: ["crontab", "dd"] }],
  },
  "secret-read": { mode: "block", excluded_paths: ["config/example.env", "fixtures/keys/**", "docs/a-b_c@1+2.md"] },
  "ci-config-write": { mode: "block", excluded_paths: [".github/workflows/docs.yml", "ci/templates/**"] },
  "network-egress": {
    mode: "block", allowed_hosts: ["api.example.com", "*.example.org", "*.cdn.example.net", "registry.npmjs.org", "*.s3.amazonaws.com"],
    exceptions: [{ hosts: ["*.internal.example.com", "status.example.io"] }],
  },
  "cloud-destructive": { mode: "block", exceptions: [{ kube_contexts: ["kind-*", "minikube", "dev-*-east", "a**"] }, { terraform_workspaces: ["sandbox-*", "*-preview"] }] },
  "production-deploy": { mode: "block", exceptions: [{ environments: ["staging", "preview", "qa:1"] }] },
  "database-migrate": { mode: "block", exceptions: [{ database_urls: ["postgres://localhost:5432/app", "mysql://127.0.0.1/test"] }] },
});
const blockedServices = [
  { kind: "mcp_server", key: "github" }, { kind: "mcp_server", key: "acme-db-admin" }, { kind: "mcp_server", key: "fs_server.v2" },
  { kind: "host", key: "paste.example.com" }, { kind: "host", key: "files.example.net:8443" },
  { kind: "cli", key: "terraform" }, { kind: "cli", key: "aws" },
  { kind: "package", key: "npm:left-pad" }, { kind: "package", key: "pypi:requests" },
];
function richDoc(revision = 1) {
  const rules = rich();
  const pack_rules = {
    "git-force-push": { mode: "block" }, "package-publish": { mode: "monitor" },
    "deploy-guard": { mode: "block", exceptions: [{ environments: ["staging"] }, { kube_contexts: ["kind-*"] }, { database_urls: ["postgres://localhost/app"] }] },
  };
  return {
    type: "scopebond:managed-rules", version: 1, revision, export_id: `rev-${revision}-${INSTALLATION}`, environment_id: "env-1",
    agent_id: "agent-1", installation_id: INSTALLATION, rules_catalog_version: "coding-pack/3", rules,
    blocked_services: blockedServices, pack_rules, rules_digest: digestManaged(rules, blockedServices, pack_rules),
  };
}

test("the starter policy, its enforcing form and the always-on floor carry only bounded patterns", () => {
  assertValidPolicy("starter", starterPolicy("kid"));
  assertValidPolicy("starter (enforce)", starterPolicy("kid", { enforce: ["protect-branches", "safe-shell", "protect-write", "protect-read"] }));
  assertValidPolicy("floor", withSelfProtection({ vocabulary_version: "1.0", policy_id: "p", version: 1, clauses: [] }));
  assertAllBounded("self-protection", selfProtectionClauses());
});

test("the computer's own rules with custom lists compile to bounded patterns", () => {
  const rules = {
    ...defaultRules(),
    enforce: ["protect-branches", "safe-shell", "protect-write", "protect-read"],
    protected_branches: ["main", "master", "release/*", "hotfix/*", "env/prod"],
    destructive_programs: [...defaultRules().destructive_programs, "shred", "mkfs.ext4"],
    protected_write: [...defaultRules().protected_write, pathRuleFor("infra/"), pathRuleFor("secrets/prod.json"), pathRuleFor(W("C:", "Users", "Dev", "keys", ""))],
    protected_read: [...defaultRules().protected_read, pathRuleFor("~/.config/gcloud/"), pathRuleFor("deploy.key")],
  };
  assertValidPolicy("compile(custom rules)", compile(rules, "kid"));
  assertValidPolicy("compile(default rules)", compile(defaultRules(), "kid"));
});

test("a workspace's rules with every list, exclusion, exception and blocked service compile to bounded patterns", () => {
  const doc = richDoc();
  const inspected = inspectManaged(doc, { installationId: INSTALLATION, currentRevision: null });
  assert.equal(inspected.ok, true, inspected.message);
  const policy = compileManaged(defaultRules(), inspected.doc, "kid");
  const n = assertAllBounded("compileManaged", policy);
  assert.ok(n >= 12, `${n} patterns`);
  assertValidPolicy("compileManaged", policy);
  // The allowed-sites rule, with wildcard sites, is the one that once compiled to a refused pattern.
  const sites = policy.clauses.find((c) => c.id === "allowed-sites");
  assert.ok(sites, "the allowed-sites clause is compiled");
  assert.match(sites.param_bounds.host.pattern, /\(\?:\[\^\.\]\+\\\.\)\+/);
  assert.ok(policy.clauses.some((c) => Array.isArray(c.exceptions) && c.exceptions.length), "exceptions are compiled");
  assert.ok(policy.clauses.filter((c) => /^blocked-/.test(c.id)).length >= 3, "blocked services are compiled");
  // Each builder on its own as well.
  assertAllBounded("blocked services", blockedServiceClauses(blockedServices));
  assertAllBounded("shell exceptions", shellExceptionBounds(rich()["destructive-shell"].exceptions));
  assertAllBounded("pack exceptions", packExceptionBounds([...rich()["cloud-destructive"].exceptions, ...rich()["production-deploy"].exceptions, ...rich()["database-migrate"].exceptions]));
});

test("the rule packs' clauses, with a workspace's modes and exceptions, carry only bounded patterns", () => {
  const all = [...packs, TARGET_PACK];
  const ids = new Set(all.flatMap((p) => (p.rules ?? []).map((r) => String(r.id))));
  const clauses = packRuleClauses(ids, all, packRuleAdjustments(richDoc(), defaultRules()));
  assert.ok(clauses.length > 0);
  if (patternsOf(clauses).length) assertAllBounded("pack rule clauses", clauses);
  assertValidPolicy("policy with pack rules", { vocabulary_version: "1.0", policy_id: "p", version: 1, clauses: [...starterPolicy("kid").clauses, ...clauses] });
});

test("a workspace answer that would compile to a refused pattern is refused whole; the rules in force stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-pattern-answer-"));
  const { agentKid } = scaffold(dir);
  const policyPath = join(dir, "policy.json");
  const before = readFileSync(policyPath, "utf8");
  // A computer whose own rules carry a protected path written as a pattern that can backtrack catastrophically: the
  // workspace's answer compiles with them, so the result would be an invalid policy.
  const rulesPath = join(dir, "rules.json");
  const local = JSON.parse(readFileSync(rulesPath, "utf8"));
  local.protected_write = [...local.protected_write, { kind: "raw", pattern: "(?!(?:a+)+$)", label: "a pattern that backtracks" }];
  writeFileSync(rulesPath, JSON.stringify(local));
  const doc = richDoc(2);
  const inspected = inspectManaged(doc, { installationId: INSTALLATION, currentRevision: null });
  assert.equal(inspected.ok, true, inspected.message);
  const installed = installManaged(dir, inspected.doc, agentKid, policyBuilds);
  assert.equal(installed.ok, false);
  assert.equal(installed.reason, "invalid_document");
  assert.match(installed.message, /compile to a pattern this computer refuses/);
  assert.match(installed.message, /a repeated group that holds a repeat/, "it says why");
  assert.match(installed.message, /rule [a-z-]+, param_bounds path/, "it says which pattern");
  assert.match(installed.message, /the rules in force stay/);
  assert.equal(readFileSync(policyPath, "utf8"), before, "policy.json is untouched");
  assert.equal(existsSync(join(dir, MANAGED_DOC_FILE)), false, "the answer is not kept");
  assert.ok(validatePolicy(JSON.parse(before)).valid, "the rules in force are still a valid policy");
});
