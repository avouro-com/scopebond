// For reviewing the panel in a browser only: a stand-in for the tray's `window.__TAURI__.core.invoke`, answering
// `panel_state` with made-up scenes. Never built into the program (build.rs copies only ui/panel.css and ui/panel.js).
// Run `node packages/tray/dev/preview.mjs` and open the page it prints; one scene alone is dist/panel-frame.html#scene=protected
// (add &view=settings, &tab=allowed or &open=<action id>).
"use strict";

(function () {
  const params = new URLSearchParams(location.hash.slice(1));
  const scene = params.get("scene") || "protected";
  const MIN = 60_000;
  const ago = (min) => new Date(Date.now() - min * MIN).toISOString();
  const offers = (o) => ({ once: false, fifteen: false, always: false, always_days: null, always_needs_admin: false, ask: false, ...o });

  const blocks = () => [
    { action_id: "act-read-env-0000000001", summary: "file.read .env.production", at: ago(6), rule: "secret-read", can_act: true, acted: null,
      what: "Read .env.production", action_text: ".env.production", rule_title: "Reading a secret file", project: "checkout", tool: "Claude Code",
      offers: offers({ once: true, fifteen: true, always: true, always_days: 30, ask: true }), reason_min: 10 },
    { action_id: "act-push-main-00000001", summary: "git.push origin main", at: ago(28), rule: "force-push-protected", can_act: true, acted: null,
      what: "git push --force origin main", action_text: "git push origin main", rule_title: "Force-push to a protected branch", project: "checkout",
      tool: "Claude Code", offers: offers({ ask: true }), reason_min: 20 },
    { action_id: "act-rm-dist-0000000001", summary: "shell.exec rm", at: ago(95), rule: null, can_act: false, acted: null,
      what: "rm -rf ./dist --token=***", action_text: "rm -rf ./dist --token=***", rule_title: null, project: "billing-api", tool: "Cursor", offers: null, reason_min: null },
    { action_id: "act-curl-paste-000001", summary: "net.fetch pastebin.com", at: ago(26 * 60), rule: "network-egress", can_act: false, acted: "asked",
      what: "Reach https://pastebin.com/raw/x1", action_text: "https://pastebin.com/raw/x1", rule_title: "Request to a site not on the allowed list",
      project: "checkout", tool: "Codex", offers: null, reason_min: null },
  ];
  const actions = [
    { id: "check_now", label: "Check now", route: "/check" },
    { id: "open_workspace", label: "Open workspace", route: "/open-workspace" },
  ];
  const rows = [
    { label: "Rules", value: "Up to date · checked 3 min ago · 6 block · 2 monitor" },
    { label: "Delivery", value: "All sent · 1 min ago" },
    { label: "Today", value: "1,160 actions · 3 blocked" },
    { label: "Version", value: "Up to date (agent 0.9.0)" },
  ];
  const ahead = (min) => new Date(Date.now() + min * MIN).toISOString();
  const allowed = () => [
    { id: "alw_staging00000000000001", rule: "secret-read", rule_title: "Reading a secret file", what: ".env.staging", choice: "fifteen", state: "active",
      needs_admin: false, by: "person", created_at: ago(4), ends_at: ahead(11), answered_by: null },
    { id: "alw_release00000000000001", rule: "push-protected", rule_title: "Push to a protected branch", what: "git push origin release/2.4", choice: "always",
      state: "active", needs_admin: false, by: "person", created_at: ago(2 * 24 * 60), ends_at: ahead(28 * 24 * 60), answered_by: null },
    { id: "alw_workflow0000000000001", rule: "ci-config-write", rule_title: "Changing CI configuration", what: ".github/workflows/release.yml", choice: "always",
      state: "active", needs_admin: false, by: "admin", created_at: ago(20 * 60), ends_at: ahead(29 * 24 * 60), answered_by: "morgan@acme.test" },
  ];
  const asked = () => [
    { id: "req_dist000000000000000001", rule: "destructive-shell", rule_title: "Destructive command", what: "rm -rf ./dist", reason: "Clearing the old release build",
      asked_at: ago(120), sent: true, state: "waiting", answered_by: null, note: null, answered_at: null },
    { id: "req_workflow0000000000001", rule: "ci-config-write", rule_title: "Changing CI configuration", what: ".github/workflows/release.yml",
      reason: "Adding the signing step to the release workflow", asked_at: ago(22 * 60), sent: true, state: "approved", answered_by: "morgan@acme.test", note: null, answered_at: ago(20 * 60) },
    { id: "req_paste00000000000000001", rule: "network-egress", rule_title: "Request to a site not on the allowed list", what: "https://pastebin.com/raw/x1",
      reason: "Sharing a log with the vendor", asked_at: ago(26 * 60), sent: true, state: "declined", answered_by: "morgan@acme.test", note: "Use the internal paste tool", answered_at: ago(25 * 60) },
  ];
  const base = () => ({
    state: "protected", headline: "Protected", tooltip: "Scopebond — Protected · Acme", rows, fix: null, actions, hint: null,
    recent_blocks: blocks(), detail: "Rules checked 3 min ago · 3 blocked today", workspace: "Acme", today: { actions: 1160, blocked: 3 },
    allowed: allowed(), asked: asked(),
  });

  const scenes = {
    protected: () => base(),
    quiet: () => ({ ...base(), recent_blocks: [], allowed: [], asked: [], detail: "Rules checked 3 min ago · nothing blocked today", today: { actions: 212, blocked: 0 } }),
    attention: () => ({
      ...base(), state: "attention", headline: "312 records waiting to send", detail: null,
      hint: "Your workspace refused the last try. The records wait on this computer and are sent again.",
      fix: { id: "send_now", label: "Send records now", route: "/flush" },
      rows: [rows[0], { label: "Delivery", value: "312 waiting · last try refused (HTTP 503)" }, rows[2], rows[3]],
    }),
    disconnected: () => ({
      ...base(), state: "disconnected", headline: "Not connected to your workspace: using this computer's own rules", detail: null,
      hint: "Sign in again to connect this computer: the approval page opens in your browser.",
      fix: { id: "reconnect", label: "Reconnect…", route: "/reconnect" }, actions: [actions[0]], workspace: null,
    }),
  };

  // Only the scenes above: the name from the address is compared with each, never used to look one up.
  const make = scene === "quiet" ? scenes.quiet : scene === "attention" ? scenes.attention : scene === "disconnected" ? scenes.disconnected : scenes.protected;
  let model = scene === "not_answering" ? null : make();
  // What the workspace lets a person do (mode=self, the default; approval: only ask to unblock, an admin decides; final: nothing): the agent
  // says it per block in `offers`, and `can_ask` says whether asking is on under any rule.
  const mode = params.get("mode") || "self";
  if (model) {
    model.can_ask = mode !== "final";
    for (const b of model.recent_blocks) {
      if (mode === "approval" && b.can_act) b.offers = offers({ ask: true });
      if (mode === "final") { b.can_act = false; b.offers = null; if (b.acted === "asked") b.acted = null; }
    }
    if (mode === "final" && model.asked) model.asked = [];
  }
  let notifications = "blocks";
  let note = null;
  let busy = null;
  let answered = null;
  let openBlock = params.get("toast") || null;
  const say = (text) => { note = text; };

  const state = () => ({
    link: model ? "answering" : "not_answering",
    state: model ? model.state : "problem",
    stateLabel: model ? { protected: "Protected", working: "Working", offline: "Offline", problem: "Problem", disconnected: "Not connected" }[model.state] || "Needs attention" : "Problem",
    headline: model ? model.headline : "The Scopebond Agent is not answering",
    answer: model ? { tray: model, settings: { notifications } } : null,
    note, busy, version: "0.1.0", autostart: "on", answered, openBlock: (() => { const o = openBlock; openBlock = null; return o; })(),
  });

  const handlers = new Map(Object.entries({
    panel_state: () => state(),
    panel_close: () => { say("(The panel would close here.)"); return null; },
    panel_action: ({ id }) => { say(id === "send_now" ? "Sent 312 records; nothing is waiting" : id === "open_workspace" ? "Opened this computer's page in your workspace" : "Checked just now: all good"); if (id === "send_now") model = scenes.protected(); return true; },
    panel_command: ({ id }) => {
      if (id.startsWith("notifications:")) notifications = id.slice(14);
      else say({ copy_diagnostics: "Diagnostics copied (no keys or credentials)", open_logs: "(The logs folder would open.)", about: "(About Scopebond would open.)", hide_icon: "(The icon would hide.)", autostart: "(Start with Windows would change.)", start_agent: "Starting the Scopebond Agent…" }[id] || "Done");
      if (id === "start_agent") model = scenes.protected();
      return true;
    },
    panel_hold: () => null,
    panel_block: ({ actionId, choice, reason }) => {
      const b = model && model.recent_blocks.find((x) => x.action_id === actionId);
      if (choice) {
        if (!b || !b.offers || !b.offers[choice] || String(reason || "").trim().length < (b.reason_min || 10)) { say("Say why in at least " + ((b && b.reason_min) || 10) + " characters."); return false; }
        busy = "answer:" + actionId;
        setTimeout(() => {
          busy = null;
          b.can_act = false;
          b.acted = choice === "ask" ? "asked" : "allowed";
          const words = { once: "Allowed once", fifteen: "Allowed for 15 minutes", always: "Always allowed on this computer for " + (b.offers.always_days || 30) + " days", ask: "Sent to an admin" }[choice];
          const text = choice === "ask" ? "Sent to an admin · you'll see the answer under Asked" : words + " · Recorded and sent to Acme";
          answered = { actionId, outcome: choice === "ask" ? "asked" : "allowed", text };
          say(text);
          if (choice === "ask") model.asked.unshift({ id: "req_new", rule: b.rule, rule_title: b.rule_title, what: b.action_text, reason: String(reason).trim(), asked_at: new Date().toISOString(), sent: true, state: "waiting", answered_by: null, note: null, answered_at: null });
          else model.allowed.unshift({ id: "alw_new", rule: b.rule, rule_title: b.rule_title, what: b.action_text, choice, state: "active", needs_admin: false, by: "person", created_at: new Date().toISOString(), ends_at: new Date(Date.now() + (choice === "fifteen" ? 15 : choice === "once" ? 1440 : 30 * 1440) * MIN).toISOString(), answered_by: null });
        }, 600);
        return true;
      }
      busy = "block:" + actionId;
      setTimeout(() => {
        busy = null;
        const b = model && model.recent_blocks.find((x) => x.action_id === actionId);
        if (b) { b.can_act = false; b.acted = b.offers && b.offers.once ? "allowed" : "asked"; }
        say(b && b.acted === "allowed" ? "Allowed. Run it again, or let the coding agent retry." : "Request sent · you'll see the answer under Requests");
      }, 1200);
      return true;
    },
  }));

  window.__TAURI__ = { core: { invoke: (cmd, args) => new Promise((resolve, reject) => {
    const h = typeof cmd === "string" ? handlers.get(cmd) : undefined;
    if (!h) { reject(new Error("unknown command " + cmd)); return; }
    resolve(JSON.parse(JSON.stringify(h(args || {}) ?? null)));
  }) } };

  // Open a view or tab the scene asks for, as a person would (by clicking), once the panel has drawn.
  window.addEventListener("load", () => {
    const click = (sel) => { const n = document.querySelector(sel); if (n) n.click(); };
    setTimeout(() => {
      if (params.get("view") === "settings") click('[data-key="settings"]');
      if (params.get("tab")) click('[data-key="tab-' + params.get("tab") + '"]');
      if (params.get("open")) click('[data-key="block-' + params.get("open") + '"]');
      // Fill the form as a person would: a choice, a reason, and (with submit) the button.
      if (params.get("choice")) click('[data-key="choice-' + params.get("choice") + '"]');
      const area = document.getElementById("reason");
      if (area && params.get("reason")) { area.value = params.get("reason"); area.dispatchEvent(new Event("input", { bubbles: true })); }
      if (params.get("submit")) setTimeout(() => click('[data-key^="confirm-"]'), 50);
    }, 200);
  });
})();
