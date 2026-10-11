// What the agent tells a person to type, in the words of how it was installed: the signed installer's `scopebond-agent`
// (on PATH) and `scopebond-agent hook …`, never npm or npx; an npm install keeps its own forms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentCli, hookCli, setupCli, autostartHealth } from "../dist/index.js";
import { healthOf } from "../dist/health.js";

const native = { kind: "per-user", platform: "win32" };
const machine = { kind: "per-machine", platform: "win32" };
const npmWin = { kind: "npm", platform: "win32" };
const npmMac = { kind: "npm", platform: "darwin" };

test("the signed install names its own program; npm keeps the .cmd shim on Windows and npx for the hook", () => {
  assert.equal(agentCli("autostart on", native), "scopebond-agent autostart on");
  assert.equal(agentCli("status", machine), "scopebond-agent status");
  assert.equal(agentCli("autostart on", npmWin), "scopebond-agent.cmd autostart on");
  assert.equal(agentCli("autostart on", npmMac), "scopebond-agent autostart on");
  assert.equal(hookCli("dedupe", native), "scopebond-agent hook dedupe");
  assert.equal(hookCli("dedupe", npmWin, "1.2.3"), "npx.cmd -y @scopebond/hook@1.2.3 dedupe");
  assert.equal(hookCli("dedupe", npmMac, "1.2.3"), "npx -y @scopebond/hook@1.2.3 dedupe");
  assert.equal(setupCli("https://x.example", native), "scopebond-agent setup https://x.example");
  assert.equal(setupCli("https://x.example", npmWin, "0.7.0"), "npx.cmd -y @scopebond/agent@0.7.0 setup https://x.example");
});

const status = (delivery) => ({
  schema: "scopebond.status.v1", version: "0.21.0", state: "delivering",
  delivery: { connected: true, last_success_at: null, last_attempt_at: null, last_error: null, last_error_code: null, connection_refused_since: null, pending: 0, oldest_pending_age_s: null, gaps_by_reason: {}, queue_error: null, ...delivery },
  identity: { installation_id: null, generation: 0, key_kid: null, credential_expires_at: null }, config: { active: "C:/x", others: [], user_connection_shadowed: false },
  agents: { claude: true, cursor: false, codex: false },
});

test("health hints: the signed install never says npm or npx", () => {
  const notConnected = status({ connected: false });
  const refused = status({ connection_refused_since: 1 });
  for (const c of [native, machine]) {
    for (const s of [notConnected, refused]) {
      const hint = healthOf(s, null, c).hint;
      assert.doesNotMatch(hint, /npx|npm/, hint);
      assert.match(hint, /scopebond-agent (setup|hook login) https:\/\/<your-workspace>/);
    }
    assert.match(healthOf(notConnected, null, c).hint, /Sign in…/);
  }
  assert.equal(healthOf(notConnected, null, npmWin).hint, `Connect it: ${hookCli("login https://<your-workspace>", npmWin)}`);
  assert.match(healthOf(refused, null, npmMac).hint, /^Sign in again: npx -y @scopebond\/hook@\S+ login https:\/\/<your-workspace>$/);
});

test("beside the native tray, the autostart fix names scopebond-agent, not the .exe or the npm shim", () => {
  const reg = () => false;
  const health = autostartHealth("C:\\nowhere", "win32", "C:\\Programs\\Scopebond\\scopebond-tray.exe", reg);
  assert.equal(health.ok, false);
  assert.match(health.detail, /run: scopebond-agent autostart on\)$/);
});
