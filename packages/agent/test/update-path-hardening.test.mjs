// The npm self-update and the hook-entry upkeep: the install command is hardened and pinned to the public registry, the
// exact version must carry provenance from this repository's main branch, the workspace's version answer is bounded,
// hook entries are always pinned to the hook the agent carries (never resolved through npx at run time), and an update
// whose new agent does not start is rolled back.
// HOME / USERPROFILE / APPDATA / LOCALAPPDATA / SCOPEBOND_HOME all point at temporary folders; child_process.spawn is
// stubbed for any `npm install -g` so nothing is installed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const root = mkdtempSync(join(tmpdir(), "sb-update-path-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
const saved = { ...process.env };
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  SCOPEBOND_HOME: join(home, ".scopebond"), SCOPEBOND_AGENT_TRAY: "off",
  npm_config_registry: "https://registry.example.invalid/", npm_config_ignore_scripts: "false",
});
const ENV_KEYS = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SCOPEBOND_HOME", "SCOPEBOND_AGENT_TRAY", "npm_config_registry", "npm_config_ignore_scripts"];
after(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

// Stub: any spawn whose arguments contain `install -g` is recorded and "succeeds"; everything else runs for real.
const realSpawn = cp.spawn;
const installs = [];
cp.spawn = function (command, args = [], options = {}) {
  if (Array.isArray(args) && args.includes("install") && args.includes("-g")) {
    installs.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => child.emit("close", 0));
    return child;
  }
  return realSpawn.apply(this, arguments);
};
syncBuiltinESMExports();

const { scaffold, hookVersion, hookCliPath, userHarnessFile } = await import("@scopebond/hook");
const { loadOrCreateAttester } = await import("@scopebond/gateway/node");
const { startService, installAgent, fetchClientVersion, maintainHookEntries, agentVersion, NPM_REGISTRY } = await import("../dist/index.js");

const REPO = "https://github.com/avouro-com/scopebond";

/** The registry's answer for one version of the agent, with a provenance statement shaped like npm's. */
function registry(version, { repository = REPO, ref = "refs/heads/main", provenance = true, digestOf = null } = {}) {
  const tarball = randomBytes(64);
  const sha512 = createHash("sha512").update(tarball);
  const integrity = `sha512-${sha512.copy().digest("base64")}`;
  const hex = digestOf ? createHash("sha512").update(digestOf).digest("hex") : sha512.digest("hex");
  const attestationsUrl = `https://registry.npmjs.org/-/npm/v1/attestations/@scopebond%2fagent@${version}`;
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `pkg:npm/%40scopebond/agent@${version}`, digest: { sha512: hex } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: { buildDefinition: { externalParameters: { workflow: { ref, repository, path: ".github/workflows/release.yml" } } } },
  };
  const meta = { name: "@scopebond/agent", version, dist: { integrity, ...(provenance ? { attestations: { url: attestationsUrl, provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } : {}) } };
  const bundle = { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64"), payloadType: "application/vnd.in-toto+json" } } }] };
  return {
    [`https://registry.npmjs.org/@scopebond%2fagent/${version}`]: meta,
    [attestationsUrl]: bundle,
  };
}
/** A fetch that answers from `routes` (URL → JSON body) and 404s everything else. */
const serve = (routes) => async (url) => { const u = String(url); return u in routes ? Response.json(routes[u]) : new Response("{}", { status: 404 }); };

function computer(cloudUrl) {
  const dir = mkdtempSync(join(root, "sb-"));
  scaffold(dir);
  const { attester } = loadOrCreateAttester({ file: join(dir, "attester.key") });
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({
    url: cloudUrl, credential: "sbm_us_test", credential_id: "cred-1", organization_id: "org-1", environment_id: "env-1",
    gateway_id: "gw-1", attester_kid: attester.kid, scopes: ["receipt:ingest", "gateway:heartbeat"],
    expires_at: new Date(Date.now() + 80 * 86_400_000).toISOString(),
  }));
  return dir;
}
const CLOUD = "https://cloud.example.invalid";
/** A workspace that answers /v1/client-version with `answer`, plus whatever registry routes are given. */
const cloud = (answer, routes = {}) => serve({ [`${CLOUD}/v1/client-version`]: answer, ...routes });

function claudeSettings(command) {
  const file = userHarnessFile("claude");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }] } }));
  return file;
}
const claudeCommand = () => JSON.parse(readFileSync(userHarnessFile("claude"), "utf8")).hooks.PreToolUse[0].hooks[0].command;

async function maintainWith(fetchImpl, extra = {}) {
  const dir = extra.dir ?? computer(CLOUD);
  const updated = [];
  const service = await startService({ dir, intervalMs: 60 * 60_000, log: () => {}, maintenance: false, tray: false, fetchImpl, onUpdated: (v) => updated.push(v), ...extra });
  try { return { result: await service.maintainNow(), updated, dir }; } finally { await service.stop(); }
}

/** The next minor version after the running agent: in range for an update. */
const next = () => { const [a, b] = agentVersion().split(".").map(Number); return `${a}.${b + 1}.0`; };

test("npm path: the install ignores package scripts, is pinned to the public registry, and does not inherit registry or script settings", async () => {
  installs.length = 0;
  const r = await installAgent("0.5.3", { fetchImpl: serve(registry("0.5.3")) });
  assert.equal(r.ok, true, r.output);
  assert.equal(installs.length, 1);
  const { args, options } = installs[0];
  const npmArgs = args.slice(args.indexOf("install"));
  assert.ok(npmArgs.includes("--ignore-scripts"), JSON.stringify(npmArgs));
  assert.ok(npmArgs.includes(`--registry=${NPM_REGISTRY}`), JSON.stringify(npmArgs));
  assert.ok(npmArgs.includes(`--@scopebond:registry=${NPM_REGISTRY}`), JSON.stringify(npmArgs));
  assert.ok(npmArgs.includes("@scopebond/agent@0.5.3"));
  assert.equal(NPM_REGISTRY, "https://registry.npmjs.org/");
  assert.ok(options.env, "the child gets an explicit environment");
  const keys = Object.keys(options.env).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("npm_config_registry") && !keys.includes("npm_config_ignore_scripts"), "registry and script settings from the environment are dropped");
});

test("npm path: nothing is installed unless the exact version carries provenance from this repository's main branch", async () => {
  installs.length = 0;
  const cases = {
    "no provenance": registry("0.5.3", { provenance: false }),
    "another repository": registry("0.5.3", { repository: "https://github.com/someone/else" }),
    "another branch": registry("0.5.3", { ref: "refs/heads/feature" }),
    "another tarball": registry("0.5.3", { digestOf: Buffer.from("not the published tarball") }),
    "registry unreachable": {},
  };
  for (const [name, routes] of Object.entries(cases)) {
    const r = await installAgent("0.5.3", { fetchImpl: serve(routes) });
    assert.equal(r.ok, false, name);
    assert.match(r.output, /provenance/, name);
  }
  assert.equal(installs.length, 0, "npm was never run");
});

test("a workspace-named hook version never turns a settings entry into a run-time npx resolve", async () => {
  // An entry pinned to a durable copy of an older hook (the form `npx @scopebond/hook init` writes).
  const pinned = join(process.env.SCOPEBOND_HOME, "runtime", "0.20.0", "node_modules", "@scopebond", "hook", "dist", "cli.js");
  mkdirSync(join(pinned, ".."), { recursive: true }); writeFileSync(pinned, "");
  claudeSettings(`"${process.execPath}" "${pinned}" claude`);
  const { result } = await maintainWith(cloud({ policy: "recommended", hook: "999.0.0", agent: null }));
  assert.doesNotMatch(claudeCommand(), /npx/, `hookEntries=${JSON.stringify(result.hookEntries)}`);
  assert.ok(claudeCommand().includes(hookCliPath()) || claudeCommand().includes(`${hookVersion()}`), `pinned to the carried hook: ${claudeCommand()}`);
  // A higher hook named by a well-formed answer is not followed either: the entry stays on the hook the agent carries.
  const [a, b] = hookVersion().split(".").map(Number);
  await maintainWith(cloud({ policy: "recommended", hook: `${a}.${b + 1}.0`, agent: null }));
  assert.doesNotMatch(claudeCommand(), /npx/);
  await maintainWith(cloud({ policy: "hold", hook: null, agent: null }));
  assert.doesNotMatch(claudeCommand(), /npx/);
});

test("an npx entry, at the carried version or any other, is re-pinned to the carried hook's path", () => {
  claudeSettings(`npx -y @scopebond/hook@${hookVersion()} claude`);
  const changed = maintainHookEntries(["claude"], false);
  assert.equal(changed.length, 1, "re-pinned even while held: the version does not change");
  assert.doesNotMatch(claudeCommand(), /npx/);
  claudeSettings("npx -y @scopebond/hook@999.0.0 claude");
  assert.equal(maintainHookEntries(["claude"], true).length, 1);
  assert.doesNotMatch(claudeCommand(), /npx/);
  claudeSettings("npx -y @scopebond/hook claude");
  assert.equal(maintainHookEntries(["claude"], false).length, 1, "an unversioned npx entry floats; it is always pinned");
  assert.doesNotMatch(claudeCommand(), /npx/);
});

test("the workspace's version answer is bounded: strict x.y.z, sane ranges, a size limit, and a known policy", async () => {
  installs.length = 0;
  const far = await maintainWith(cloud({ policy: "recommended", hook: null, agent: "999.0.0" }));
  assert.deepEqual(far.updated, []);
  assert.equal(installs.length, 0, "a version far beyond the running one is refused");
  const down = await maintainWith(cloud({ policy: "recommended", hook: null, agent: "0.0.1" }));
  assert.deepEqual(down.updated, []); assert.equal(installs.length, 0, `downgrade refused (current ${agentVersion()})`);
  const conn = { url: CLOUD, credential: "x" };
  assert.equal(await fetchClientVersion(conn, cloud({ policy: "recommended", hook: "12345.0.0", agent: "7.0.0" })), null, "out-of-range answer refused whole");
  assert.equal(await fetchClientVersion(conn, cloud({ policy: "recommended", hook: null, agent: "0.06.0" })), null, "leading zeros refused");
  assert.equal(await fetchClientVersion(conn, cloud({ policy: "recommended", hook: null, agent: "1.0.0-beta.1" })), null, "pre-release tags refused");
  assert.equal(await fetchClientVersion(conn, cloud({ policy: "recommended", hook: "latest; rm -rf", agent: null })), null, "a malformed version refuses the answer");
  const big = async () => new Response(JSON.stringify({ policy: "recommended", hook: null, agent: next(), pad: "x".repeat(64 * 1024) }), { headers: { "content-type": "application/json" } });
  assert.equal(await fetchClientVersion(conn, big), null, "an oversized answer is refused");
  assert.equal(await fetchClientVersion(conn, async () => new Response("[1,2]")), null, "not an object");
  assert.deepEqual(await fetchClientVersion(conn, cloud({ policy: "recommended", hook: hookVersion(), agent: next() })), { policy: "recommended", hook: hookVersion(), agent: next() });
  let opts = null;
  await fetchClientVersion(conn, async (_u, o) => { opts = o; return new Response("{}", { status: 404 }); });
  assert.equal(opts.redirect, "error", "redirects are refused on this request");
});

test("a policy other than recommended or hold refuses the whole answer, so nothing is installed", async () => {
  const v = await fetchClientVersion({ url: CLOUD, credential: "x" }, cloud({ policy: "stop", agent: "9.0.0" }));
  assert.equal(v, null);
});

test("an update whose new agent does not start is rolled back, and the same version is not retried at once", async () => {
  installs.length = 0;
  const target = next();
  const answer = cloud({ policy: "recommended", hook: null, agent: target }, registry(target));
  const failing = async () => ({ ok: false, output: "the new agent would not start" });
  const first = await maintainWith(answer, { startCheck: failing });
  assert.deepEqual(first.updated, []);
  assert.match(first.result.error, /did not start/);
  assert.equal(installs.length, 2, JSON.stringify(installs.map((i) => i.args)));
  assert.ok(installs[0].args.includes(`@scopebond/agent@${target}`));
  assert.ok(installs[1].args.includes(`@scopebond/agent@${agentVersion()}`), "rolled back to the running version");
  assert.ok(installs[1].args.includes("--ignore-scripts"), "the rollback is hardened too");
  installs.length = 0;
  const again = await maintainWith(answer, { dir: first.dir, startCheck: failing });
  assert.deepEqual(again.updated, []);
  assert.equal(installs.length, 0, "the version that failed to start is not installed again right away");
});

test("an update whose new agent starts and reports the target version hands over", async () => {
  installs.length = 0;
  const target = next();
  const checked = [];
  const r = await maintainWith(cloud({ policy: "recommended", hook: null, agent: target }, registry(target)), { startCheck: async (v) => { checked.push(v); return { ok: true, output: `agent/${v}` }; } });
  assert.deepEqual(r.updated, [target]);
  assert.deepEqual(checked, [target]);
  assert.equal(installs.length, 1);
});

test("the start check runs the installed program and requires it to report the version it was asked for", async () => {
  const { startCheck } = await import("../dist/index.js");
  const same = await startCheck(agentVersion());
  assert.equal(same.ok, true, same.output);
  const other = await startCheck(next());
  assert.equal(other.ok, false, "the program on disk still reports the running version");
});
