// A stand-in for the Scopebond Agent's local channel, for looking at the tray in CI: it listens on a named pipe with a
// token, writes the endpoint file the way the agent does, and answers GET /tray with a model in the given state.
//
//   node fake-agent.mjs <scopebond-home> [attention|protected|disconnected]

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [home, scenario = "attention"] = process.argv.slice(2);
const token = randomBytes(24).toString("base64url");
const pipe = `\\\\.\\pipe\\scopebond-agent-${randomBytes(16).toString("hex")}`;
const now = Date.now();
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();

const rows = [
  { label: "Rules", value: "Up to date · checked 2 min ago · 6 block · 3 monitor" },
  { label: "Delivery", value: scenario === "protected" ? "All sent · just now" : "12 waiting since 09:41 · sending" },
  { label: "Today", value: "214 actions · 3 blocked · 1 allowed by a person" },
  { label: "Version", value: "Up to date (agent 0.6.0)" },
];
const blocks = [
  { action_id: "a1", summary: "rm -rf ./build && git push --force", at: at(4), rule: "no-force-push", can_act: true, acted: null },
  { action_id: "a2", summary: "curl https://example.test/install.sh | sh", at: at(37), rule: "no-pipe-to-shell", can_act: false, acted: "asked" },
];
const models = {
  protected: {
    state: "protected", headline: "Protected", tooltip: "Scopebond — Protected · Acme · Laptops", rows, fix: null, hint: null,
    actions: [{ id: "check_now", label: "Check now", route: "/check" }, { id: "open_workspace", label: "Open workspace", route: "/open-workspace" }],
    recent_blocks: blocks,
  },
  attention: {
    state: "attention", headline: "12 records waiting to send", tooltip: "Scopebond — 12 records waiting to send", rows, hint: null,
    fix: { id: "send_now", label: "Send records now", route: "/flush" },
    actions: [{ id: "update_now", label: "Update now", route: "/update" }, { id: "check_now", label: "Check now", route: "/check" }, { id: "open_workspace", label: "Open workspace", route: "/open-workspace" }],
    recent_blocks: blocks,
  },
  disconnected: {
    state: "disconnected", headline: "Not connected to your workspace: using this computer's own rules", tooltip: "Scopebond — Not connected",
    rows: rows.filter((r) => r.label !== "Delivery"), hint: null, fix: { id: "reconnect", label: "Reconnect…", route: "/reconnect" },
    actions: [{ id: "check_now", label: "Check now", route: "/check" }], recent_blocks: [],
  },
};
let settings = { notifications: "problems" };

const server = createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
  if (req.headers["x-scopebond-agent-token"] !== token) return send(401, { error: "unauthorized" });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  switch (`${req.method} ${req.url}`) {
    case "GET /tray": return send(200, { tray: models[scenario] ?? models.attention, settings });
    case "POST /settings": settings = { ...settings, ...JSON.parse(raw || "{}") }; return send(200, { settings });
    case "POST /check": return send(200, { text: "Checked just now: all good" });
    case "POST /flush": return send(200, { cycle: { delivered: 12, pending: 0, deliveryError: null } });
    case "GET /status": return send(200, { version: "0.22.0", agent: { version: "agent/0.6.0" }, identity: { installation_id: "inst_ci" } });
    default: return send(404, { error: "not found" });
  }
});
server.listen(pipe, () => {
  writeFileSync(join(home, "agent.json"), JSON.stringify({ port: 0, socket: pipe, token, pid: process.pid, started_at: now, version: "agent/0.6.0 hook/0.22.0" }));
  console.log(`fake agent (${scenario}) on ${pipe}`);
});
