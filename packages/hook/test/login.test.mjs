import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { scaffold, isTrustedProject, resolveConfigDir, trustProjectPolicy, writeHarnessConfig } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// A minimal workspace for the device-code flow: /v1/device/code hands out a code;
// /v1/device/token answers `authorization_pending` a given number of times and then
// either an enrollment or a terminal error; /v1/enroll issues a credential.
function startFakeWorkspace({ pendingPolls = 1, outcome = "approve", kids = { attester: "k", agent: "a" } } = {}) {
  let polls = 0;
  const seen = { codeRequest: null, enrolled: false, tokenBodies: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/v1/device/code" && req.method === "POST") {
        seen.codeRequest = JSON.parse(body);
        return json(200, {
          device_code: "dc_".padEnd(43, "x"), user_code: "BCDF-GHJK",
          verification_uri: `http://127.0.0.1:${server.address().port}/app/device`,
          verification_uri_complete: `http://127.0.0.1:${server.address().port}/app/device?code=BCDF-GHJK`,
          expires_in: 600, interval: 1,
        });
      }
      if (req.url === "/v1/device/token" && req.method === "POST") {
        seen.tokenBodies.push(JSON.parse(body));
        polls += 1;
        if (polls <= pendingPolls) return json(400, { error: "authorization_pending" });
        if (outcome === "deny") return json(400, { error: "access_denied" });
        if (outcome === "expire") return json(400, { error: "expired_token" });
        return json(200, {
          enrollment: {
            enrollment_token: "sbe_login_test",
            proof_canonical: JSON.stringify({ challenge: "c1", enrollment_id: "e1", type: "scopebond:gateway-enrollment", version: 1 }),
          },
          organization_id: "org-1", environment_id: "env-1", agent_id: "agent-1",
        });
      }
      if (req.url === "/v1/enroll" && req.method === "POST") {
        const parsed = JSON.parse(body);
        assert.equal(parsed.enrollment_token, "sbe_login_test", "the approved enrollment is the one used");
        seen.enrolled = true;
        return json(200, {
          credential_id: "cred-1", credential: "sbm_login_credential",
          organization_id: "org-1", environment_id: "env-1", gateway_id: "gw-1",
          attester_kid: kids.attester, agent_kid: kids.agent, scopes: ["receipt:ingest"], expires_at: "2027-01-01T00:00:00.000Z",
        });
      }
      json(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }));
  });
}

function runCli(args, env, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
}

test("login: a code, then approval, then the enrollment completes as connect would", async () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-login-"));
  const dir = join(project, ".scopebond");
  // The workspace binds the credential to the enrolling keys, so learn them first.
  scaffold(dir);
  const kids = {
    attester: loadOrCreateAttester({ file: join(dir, "attester.key") }).attester.kid,
    agent: loadOrCreateAttester({ file: join(dir, "agent.key") }).attester.kid,
  };
  const workspace = await startFakeWorkspace({ pendingPolls: 1, kids });
  try {
    const r = await runCli(["login", workspace.url, "--no-install"], { ...process.env, SCOPEBOND_HOOK_DIR: dir }, project);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /BCDF-GHJK/, "shows the code to check");
    assert.match(r.stdout, /\/app\/device\?code=BCDF-GHJK/, "shows the page to open");
    assert.match(r.stdout, /Approved/);
    assert.match(r.stdout, /Connected to/);
    assert.match(r.stdout, /https:\/\/scopebond\.com\/get-started#desktop-agent/, "a connected computer is offered the background delivery agent");
    assert.doesNotMatch(r.stdout, /Start free with one agent/, "an approved workspace connection does not ask the user to sign up again");
    assert.equal(workspace.seen.enrolled, true);
    assert.equal(workspace.seen.codeRequest.harness, "claude");
    assert.ok(typeof workspace.seen.codeRequest.client_name === "string" && workspace.seen.codeRequest.client_name.length > 0);
    assert.ok(existsSync(join(dir, "cloud.json")), "the connection is saved");
    assert.doesNotMatch(r.stdout, /dc_x/, "the device code is never printed");
    assert.doesNotMatch(readFileSync(join(dir, "cloud.json"), "utf8"), /dc_x/, "and never written");
  } finally { workspace.close(); }
});

test("login --project: with a user-level install, the connected project governs, so its receipts reach the workspace", async () => {
  // A user-level install makes the hook ignore an untrusted project policy. Before this
  // was fixed, `login` and `connect` scaffolded the project without trusting it: the hook
  // then resolved to the user home, which holds no cloud.json, and nothing was reported.
  const home = mkdtempSync(join(tmpdir(), "sb-hook-login-home-"));
  scaffold(home);
  const project = mkdtempSync(join(tmpdir(), "sb-hook-login-trust-"));
  const dir = join(project, ".scopebond");
  scaffold(dir);
  const kids = {
    attester: loadOrCreateAttester({ file: join(dir, "attester.key") }).attester.kid,
    agent: loadOrCreateAttester({ file: join(dir, "agent.key") }).attester.kid,
  };
  const workspace = await startFakeWorkspace({ pendingPolls: 0, kids });
  const env = { ...process.env, SCOPEBOND_HOME: home };
  delete env.SCOPEBOND_HOOK_DIR;
  const previousHome = process.env.SCOPEBOND_HOME;
  try {
    const r = await runCli(["login", workspace.url, "--no-install", "--project"], env, project);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, "cloud.json")), "the connection is saved in the project");
    assert.ok(!existsSync(join(home, "cloud.json")), "and not in the user home");
    process.env.SCOPEBOND_HOME = home;
    assert.equal(isTrustedProject(dir), true, "the project policy is trusted");
    assert.equal(resolveConfigDir(project), dir, "the hook resolves to the connected project");
  } finally {
    if (previousHome === undefined) delete process.env.SCOPEBOND_HOME; else process.env.SCOPEBOND_HOME = previousHome;
    workspace.close();
  }
});

test("login: from a folder with no project setup, it repairs the user-level connection instead of creating a second one", async () => {
  // A computer set up once for the user: reconnecting from whatever folder the terminal
  // happens to be in must fix the connection the hook actually uses.
  const home = mkdtempSync(join(tmpdir(), "sb-hook-login-home-"));
  scaffold(home);
  const folder = mkdtempSync(join(tmpdir(), "sb-hook-login-bare-"));
  const kids = {
    attester: loadOrCreateAttester({ file: join(home, "attester.key") }).attester.kid,
    agent: loadOrCreateAttester({ file: join(home, "agent.key") }).attester.kid,
  };
  const workspace = await startFakeWorkspace({ pendingPolls: 0, kids });
  const env = { ...process.env, SCOPEBOND_HOME: home };
  delete env.SCOPEBOND_HOOK_DIR;
  try {
    const r = await runCli(["login", workspace.url, "--no-install"], env, folder);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(home, "cloud.json")), "the user-level connection is the one repaired");
    assert.ok(!existsSync(join(folder, ".scopebond")), "no second, project-level setup appears");
  } finally {
    workspace.close();
  }
});

/** A computer whose user home has keys but no Scopebond install yet (no policy), and a folder
 *  with a leftover project setup and project agent settings: what a person following the
 *  get-started page from such a folder has. HOME and USERPROFILE point at a temp dir so the
 *  user-level agent settings land there. */
function leftoverProjectComputer() {
  const profile = mkdtempSync(join(tmpdir(), "sb-hook-login-profile-"));
  const home = join(profile, ".scopebond");
  mkdirSync(home, { recursive: true });
  const kids = {
    attester: loadOrCreateAttester({ file: join(home, "attester.key") }).attester.kid,
    agent: loadOrCreateAttester({ file: join(home, "agent.key") }).attester.kid,
  };
  const folder = mkdtempSync(join(tmpdir(), "sb-hook-login-leftover-"));
  const project = join(folder, ".scopebond");
  scaffold(project);
  const projectSettings = join(folder, ".claude", "settings.json");
  writeHarnessConfig(projectSettings, "claude", "npx -y @scopebond/hook@0.16.0 claude");
  const env = { ...process.env, SCOPEBOND_HOME: home, HOME: profile, USERPROFILE: profile };
  delete env.SCOPEBOND_HOOK_DIR;
  return { profile, home, kids, folder, project, projectSettings, env, userSettings: join(profile, ".claude", "settings.json") };
}

test("login: from a folder with a leftover project setup, it signs in the user, not the project", async () => {
  const pc = leftoverProjectComputer();
  const workspace = await startFakeWorkspace({ pendingPolls: 0, kids: pc.kids });
  try {
    const r = await runCli(["login", workspace.url], pc.env, pc.folder);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(pc.home, "cloud.json")), "the user home is connected");
    assert.ok(existsSync(join(pc.home, "policy.json")), "and installed");
    assert.ok(!existsSync(join(pc.project, "cloud.json")), "the leftover project setup is not connected");
    assert.match(readFileSync(pc.userSettings, "utf8"), /scopebond/, "the hook goes into the user-level agent settings");
    assert.ok(r.stdout.includes(`Claude Code configured in ${pc.userSettings}`), "the project's hook entry does not count as the user's");
    // The project is not trusted, so the user's setup governs there; the sign-in says so and how to tidy up.
    assert.match(r.stdout, /earlier project setup/);
    assert.match(r.stdout, /ignores it/);
    assert.ok(r.stdout.includes(pc.projectSettings), "names the project settings file holding a hook entry");
    process.env.SCOPEBOND_HOME = pc.home;
    assert.equal(resolveConfigDir(pc.folder), pc.home, "sessions in that folder use the user-level connection");
  } finally {
    delete process.env.SCOPEBOND_HOME;
    workspace.close();
  }
});

test("login: a trusted project setup that takes precedence is named, with how to remove it, and status and doctor show it", async () => {
  const pc = leftoverProjectComputer();
  // Trust is recorded in the user home: pin the project there first, as `init` would have.
  process.env.SCOPEBOND_HOME = pc.home;
  try { trustProjectPolicy(pc.project); } finally { delete process.env.SCOPEBOND_HOME; }
  const workspace = await startFakeWorkspace({ pendingPolls: 0, kids: pc.kids });
  try {
    const r = await runCli(["login", workspace.url], pc.env, pc.folder);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(pc.home, "cloud.json")), "the user home is connected");
    assert.match(r.stdout, /takes precedence over this sign-in/);
    assert.match(r.stdout, /stay on this computer: it is not connected/);
    assert.ok(r.stdout.includes(`delete the folder ${pc.project}`), "says how to remove it");
    const status = await runCli(["status"], pc.env, pc.folder);
    assert.match(status.stdout, /user sign-in .* takes precedence here and is not connected/);
    const json = JSON.parse((await runCli(["status", "--json"], pc.env, pc.folder)).stdout);
    assert.equal(json.config.user_connection_shadowed, true);
    assert.equal(json.config.active, pc.project);
    const doctor = await runCli(["doctor"], pc.env, pc.folder);
    assert.notEqual(doctor.status, 0);
    assert.match(doctor.stdout, /NOT CONNECTED/);
    assert.match(doctor.stdout, /takes precedence over your user-level sign-in/);
    assert.doesNotMatch(doctor.stdout, /All good/);
  } finally { workspace.close(); }
});

test("login: on a computer with nothing set up yet, it connects the user's home, not the folder it was run from", async () => {
  // A first login usually runs from whatever folder the terminal opened in (an editor's
  // terminal opens in the project). It used to scaffold and connect that folder, so the
  // hook, resolving to the user home everywhere else, found no connection.
  const home = join(mkdtempSync(join(tmpdir(), "sb-hook-login-fresh-")), ".scopebond");
  const folder = mkdtempSync(join(tmpdir(), "sb-hook-login-editor-"));
  // The workspace binds the credential to the enrolling keys; creating them is not a setup
  // (no policy.json), so the home still counts as fresh.
  const kids = {
    attester: loadOrCreateAttester({ file: join(home, "attester.key") }).attester.kid,
    agent: loadOrCreateAttester({ file: join(home, "agent.key") }).attester.kid,
  };
  const workspace = await startFakeWorkspace({ pendingPolls: 0, kids });
  const env = { ...process.env, SCOPEBOND_HOME: home };
  delete env.SCOPEBOND_HOOK_DIR;
  try {
    const r = await runCli(["login", workspace.url, "--no-install"], env, folder);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(home, "cloud.json")), "the connection is in the user's home");
    assert.ok(!existsSync(join(folder, ".scopebond")), "nothing is written to the folder it was run from");
  } finally {
    workspace.close();
  }
});


test("login: a denied request connects nothing and says so", async () => {
  const workspace = await startFakeWorkspace({ pendingPolls: 0, outcome: "deny" });
  const project = mkdtempSync(join(tmpdir(), "sb-hook-login-deny-"));
  const dir = join(project, ".scopebond");
  try {
    const r = await runCli(["login", workspace.url, "--no-install"], { ...process.env, SCOPEBOND_HOOK_DIR: dir }, project);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /denied/);
    assert.equal(workspace.seen.enrolled, false);
    assert.ok(!existsSync(join(dir, "cloud.json")));
  } finally { workspace.close(); }
});

test("login: an expired code asks for a new one", async () => {
  const workspace = await startFakeWorkspace({ pendingPolls: 0, outcome: "expire" });
  const project = mkdtempSync(join(tmpdir(), "sb-hook-login-exp-"));
  try {
    const r = await runCli(["login", workspace.url, "--no-install"], { ...process.env, SCOPEBOND_HOOK_DIR: join(project, ".scopebond") }, project);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /expired/);
  } finally { workspace.close(); }
});

test("login: refuses a plain-http workspace that is not this machine", async () => {
  const project = mkdtempSync(join(tmpdir(), "sb-hook-login-http-"));
  const r = await runCli(["login", "http://example.com"], { ...process.env, SCOPEBOND_HOOK_DIR: join(project, ".scopebond") }, project);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
});
