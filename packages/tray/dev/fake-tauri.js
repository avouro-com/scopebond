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
      what: "Read .env.production", action_text: ".env.production", rule_title: "Read passwords, keys or secrets", project: "checkout", tool: "Claude Code",
      offers: offers({ once: true, fifteen: true, always: true, always_days: 30, ask: true }), reason_min: 10 },
    { action_id: "act-push-main-00000001", summary: "git.push origin main", at: ago(28), rule: "force-push-protected", can_act: true, acted: null,
      what: "git push --force origin main", action_text: "git push origin main", rule_title: "Rewrite history on a protected branch", project: "checkout",
      tool: "Claude Code", offers: offers({ ask: true }), reason_min: 20 },
    { action_id: "act-rm-dist-0000000001", summary: "shell.exec rm", at: ago(95), rule: null, can_act: false, acted: null,
      what: "rm -rf ./dist --token=***", action_text: "rm -rf ./dist --token=***", rule_title: null, project: "billing-api", tool: "Cursor", offers: null, reason_min: null },
    { action_id: "act-policy-0000000001", summary: "file.write .scopebond/policy.json", at: ago(140), rule: "guardrail-config-write", can_act: false, acted: null,
      what: "Edit .scopebond/policy.json", action_text: ".scopebond/policy.json", rule_title: "Change Scopebond's or the agent's safety settings", project: "checkout",
      tool: "Claude Code", offers: null, reason_min: null },
    { action_id: "act-curl-paste-000001", summary: "net.fetch pastebin.com", at: ago(26 * 60), rule: "network-egress", can_act: false, acted: "asked",
      what: "Reach https://pastebin.com/raw/x1", action_text: "https://pastebin.com/raw/x1", rule_title: "Contact websites and online services",
      project: "checkout", tool: "Codex", offers: null, reason_min: null },
  ];
  // One block of each outcome the agent sends (block-outcome.ts), for the outcomes scene and the generated lists.
  const outcomeBlocks = () => [
    { action_id: "act-out-unblock-000001", summary: "file.read .env.production", at: ago(3), rule: "secret-read", can_act: true, acted: null,
      what: "Read .env.production", action_text: ".env.production", rule_title: "Read passwords, keys or secrets", project: "checkout", tool: "Claude Code",
      offers: offers({ once: true, fifteen: true, always: true, always_days: 30, ask: true }), reason_min: 0, outcome: "unblock", outcome_text: null, tries: 1,
      rule_why: "Allow workspace reads, but never signing keys, environment secret files, SSH keys or cloud credentials." },
    { action_id: "act-out-ask-0000000001", summary: "git.push origin main", at: ago(9), rule: "push-protected", can_act: true, acted: null,
      what: "git push origin main", action_text: "git push origin main", rule_title: "Push straight to a protected branch", project: "checkout", tool: "Claude Code",
      offers: offers({ ask: true }), reason_min: 0, outcome: "ask", outcome_text: null, tries: 3 },
    { action_id: "act-out-always-000001", summary: "file.read receipts.db", at: ago(15), rule: "secret-read", can_act: false, acted: null,
      what: "Read ~/.scopebond/receipts.db", action_text: "~/.scopebond/receipts.db", rule_title: "Read passwords, keys or secrets", project: "checkout", tool: "Claude Code",
      offers: null, reason_min: null, outcome: "always_on", outcome_text: "Always on. Scopebond protects its own keys and records on this computer.", tries: 12,
      rule_why: "Never read Scopebond's own folder, which holds this computer's key and connection (always on; it cannot be relaxed)." },
    { action_id: "act-out-rule-00000001", summary: "file.write .github/workflows/release.yml", at: ago(31), rule: "ci-config-write", can_act: false, acted: null,
      what: "Edit .github/workflows/release.yml", action_text: ".github/workflows/release.yml", rule_title: "Change build and release settings", project: "billing-api",
      tool: "Cursor", offers: null, reason_min: null, outcome: "workspace_rule", outcome_text: "Set by Acme. Ask an admin to change the rule.",
      copy_details: "Edit .github/workflows/release.yml\nRule: Change build and release settings\nRecord: act-out-rule-00000001", tries: 1 },
    { action_id: "act-out-install-00001", summary: "software.install left-pad", at: ago(47), rule: null, can_act: false, acted: null,
      what: "Install left-pad 9.9.9 (npm)", action_text: "npm install left-pad@9.9.9", rule_title: "Install a package Safe Install flagged", project: "checkout",
      tool: "Claude Code", offers: null, reason_min: null, outcome: "safe_install", outcome_text: "Blocked by Safe Install: it is on your workspace's list of known malware.",
      copy_details: "Install left-pad 9.9.9 (npm)\nRule: Install a package Safe Install flagged\nRecord: act-out-install-00001", tries: 1 },
    { action_id: "act-out-waiting-00001", summary: "shell.exec rm", at: ago(64), rule: "destructive-shell", can_act: false, acted: "asked",
      what: "rm -rf D:/work/old-worktree", action_text: "rm -rf D:/work/old-worktree", rule_title: "Run a command that deletes data or shuts down the computer",
      project: "checkout", tool: "Claude Code", offers: null, reason_min: null, outcome: "requested", outcome_text: "Waiting for an admin",
      request: { state: "waiting", answered_by: null, answered_at: null }, tries: 1 },
    { action_id: "act-out-approved-0001", summary: "file.write .github/workflows/ci.yml", at: ago(80), rule: "ci-config-write", can_act: false, acted: "asked",
      what: "Edit .github/workflows/ci.yml", action_text: ".github/workflows/ci.yml", rule_title: "Change build and release settings", project: "checkout", tool: "Claude Code",
      offers: null, reason_min: null, outcome: "requested", outcome_text: "Approved by Morgan: ask Claude Code to try again",
      request: { state: "approved", answered_by: "Morgan", answered_at: ago(70) }, tries: 1 },
    { action_id: "act-out-declined-0001", summary: "net.fetch pastebin.com", at: ago(120), rule: "network-egress", can_act: false, acted: "asked",
      what: "Reach https://pastebin.com/raw/x1", action_text: "https://pastebin.com/raw/x1", rule_title: "Contact websites and online services", project: "checkout",
      tool: "Codex", offers: null, reason_min: null, outcome: "requested", outcome_text: "Declined by Morgan", request: { state: "declined", answered_by: "Morgan", answered_at: ago(110) }, tries: 1 },
    { action_id: "act-out-allowed-00001", summary: "file.read .env.staging", at: ago(150), rule: "secret-read", can_act: false, acted: "allowed",
      what: "Read .env.staging", action_text: ".env.staging", rule_title: "Read passwords, keys or secrets", project: "checkout", tool: "Claude Code",
      offers: null, reason_min: null, outcome: "allowed", outcome_text: "Allowed: ask Claude Code to try again", tries: 1 },
  ];
  /** The same action under the same rule, tried in three sessions and two tools today, beside other blocks (groups=1). */
  const repeatedBlocks = () => {
    const read = outcomeBlocks()[2];
    const tries = [[2, "Claude Code", 4], [24, "Cursor", 1], [61, "Claude Code", 7]].map(([min, tool, n], i) => ({ ...read,
      action_id: "act-rep-read-0000000" + i, at: ago(min), tool, tries: n }));
    return [tries[0], outcomeBlocks()[0], tries[1], outcomeBlocks()[1], tries[2], ...outcomeBlocks().slice(3)];
  };
  /** The agent's grouping (tray-model.ts groupBlocks): today's repeats of one action under one rule as one row. */
  const groupBlocks = (list) => {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const groups = []; const byKey = new Map();
    list.forEach((b, i) => {
      const today = Date.parse(b.at) >= midnight.getTime();
      const key = today ? (b.rule_title || b.rule || "") + "\n" + (b.what || b.summary) : "one\n" + (b.action_id || "") + "\n" + i;
      const known = today ? byKey.get(key) : undefined;
      const tries = b.tries > 0 ? b.tries : 1;
      if (known) { known.members.push(i); known.times += tries; return; }
      const g = { key, members: [i], times: tries, first_at: b.first_at || b.at, last_at: b.at, today };
      groups.push(g); if (today) byKey.set(key, g);
    });
    return groups;
  };
  /** n blocks over the last week, cycling through every outcome (blocks=n in the address). */
  const manyBlocks = (n) => {
    const kinds = outcomeBlocks();
    return Array.from({ length: n }, (_, i) => {
      const b = kinds[i % kinds.length];
      const minutes = Math.round(i * (n > 40 ? 7 * 24 * 60 / n : 12));
      return { ...b, action_id: "act-gen-" + String(i).padStart(14, "0"), at: ago(minutes), what: b.what + (i >= kinds.length ? " #" + i : ""), tries: i % 7 === 0 ? 1 + (i % 5) : 1 };
    });
  };
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
  // Settings' This computer, as the agent words it (tray-model.ts computerRows).
  const computerRows = [
    { label: "Protection", value: "On · 9 rules blocking · 4 packs", items: ["Cloud CLIs 1.2.0", "Infrastructure 1.1.0", "Databases 1.0.3", "MCP servers 0.9.2"] },
    { label: "Workspace", value: "Acme · Production" },
    { label: "Rules updated", value: "2 min ago" },
    { label: "Version", value: "Scopebond 0.11.5 · up to date" },
  ];
  const ahead = (min) => new Date(Date.now() + min * MIN).toISOString();
  const allowed = () => [
    { id: "alw_quiet000000000000001", kind: "quiet", rule: "secret-read", rule_title: "Read passwords, keys or secrets", what: "Read ~/.aws/credentials", choice: "always",
      state: "active", needs_admin: false, by: "person", created_at: ago(3 * 60), ends_at: ahead(30 * 24 * 60 - 180), answered_by: null },
    { id: "alw_hour00000000000000001", kind: "allow", rule: "destructive-shell", rule_title: "Run a command that deletes data or shuts down the computer", what: "rm -rf ./dist",
      choice: "hour", state: "active", needs_admin: false, by: "person", created_at: ago(10), ends_at: ahead(50), answered_by: null },
    { id: "alw_staging00000000000001", rule: "secret-read", rule_title: "Read passwords, keys or secrets", what: ".env.staging", choice: "fifteen", state: "active",
      needs_admin: false, by: "person", created_at: ago(4), ends_at: ahead(11), answered_by: null },
    { id: "alw_release00000000000001", rule: "push-protected", rule_title: "Push straight to a protected branch", what: "git push origin release/2.4", choice: "always",
      state: "active", needs_admin: false, by: "person", created_at: ago(2 * 24 * 60), ends_at: ahead(28 * 24 * 60), answered_by: null },
    { id: "alw_workflow0000000000001", rule: "ci-config-write", rule_title: "Change build and release settings", what: ".github/workflows/release.yml", choice: "always",
      state: "active", needs_admin: false, by: "admin", created_at: ago(20 * 60), ends_at: ahead(29 * 24 * 60), answered_by: "morgan@acme.test" },
  ];
  const asked = () => [
    { id: "req_dist000000000000000001", rule: "destructive-shell", rule_title: "Run a command that deletes data or shuts down the computer", what: "rm -rf ./dist", reason: "Clearing the old release build",
      asked_at: ago(120), sent: true, state: "waiting", answered_by: null, note: null, answered_at: null },
    { id: "req_workflow0000000000001", rule: "ci-config-write", rule_title: "Change build and release settings", what: ".github/workflows/release.yml",
      reason: "Adding the signing step to the release workflow", asked_at: ago(22 * 60), sent: true, state: "approved", answered_by: "morgan@acme.test", note: null, answered_at: ago(20 * 60) },
    { id: "req_paste00000000000000001", rule: "network-egress", rule_title: "Contact websites and online services", what: "https://pastebin.com/raw/x1",
      reason: "Sharing a log with the vendor", asked_at: ago(26 * 60), sent: true, state: "declined", answered_by: "morgan@acme.test", note: "Use the internal paste tool", answered_at: ago(25 * 60) },
  ];
  const base = () => ({
    state: "protected", headline: "Protected", tooltip: "Scopebond — Protected · Acme", rows, fix: null, actions, hint: null,
    recent_blocks: blocks(), detail: "3 blocked today · rules updated 3 min ago", workspace: "Acme", today: { actions: 1160, blocked: 3 },
    allowed: allowed(), asked: asked(),
    computer_rows: computerRows, version_label: "Scopebond 0.11.5",
  });

  const scenes = {
    protected: () => base(),
    quiet: () => ({ ...base(), recent_blocks: [], allowed: [], asked: [], detail: "Nothing blocked today · rules updated 3 min ago", today: { actions: 212, blocked: 0 } }),
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
  // blocks=n: the list of n blocks over the week, every outcome (0, 3, 40 and 200 are the reviewed sizes); outcomes=1: one of each.
  if (model && (params.get("blocks") !== null || params.get("outcomes") || params.get("groups"))) {
    const list = params.get("groups") ? repeatedBlocks() : params.get("outcomes") ? outcomeBlocks() : manyBlocks(Math.max(0, Math.min(500, Number(params.get("blocks")) || 0)));
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const today = list.filter((b) => Date.parse(b.at) >= midnight.getTime()).length;
    model.recent_blocks = list;
    model.today = { actions: 16867, blocked: today };
    model.detail = (today ? today.toLocaleString("en-US") + " blocked today" : "Nothing blocked today") + " · rules updated 3 min ago";
  }
  // What the workspace lets a person do (mode=self, the default; approval: only ask to unblock, an admin decides;
  // automatic: one length the workspace set, applied at once and reviewed by an admin later; final: nothing): the agent
  // says it per block in `offers`, and `can_ask` says whether asking is on under any rule.
  const mode = params.get("mode") || "self";
  if (model) {
    model.can_ask = mode !== "final" && mode !== "automatic";
    for (const b of model.recent_blocks) {
      if (mode === "approval" && b.can_act) b.offers = offers({ ask: true });
      if (mode === "automatic" && b.can_act) b.offers = offers({ fifteen: true, reviewed: true });
    }
    if (mode === "automatic" && model.allowed) model.allowed[0].unblocked = "automatic";
    for (const b of model.recent_blocks) {
      if (mode === "final") { b.can_act = false; b.offers = null; if (b.acted === "asked") b.acted = null; }
    }
    if (mode === "final" && model.asked) model.asked = [];
  }
  // The agent's groups, unless the scene is an older agent's (older=1: each block is its own row).
  if (model && !params.get("older")) model.blocked_groups = groupBlocks(model.recent_blocks);
  // An older agent sends neither Settings' facts nor the client's version: the panel shows its rows.
  if (model && params.get("older")) { delete model.computer_rows; delete model.version_label; }
  // notify=off: the person turned notifications off.
  let notifications = params.get("notify") === "off" ? "off" : "blocks";
  let note = null;
  let busy = null;
  let answered = null;
  // live=1: a question the hook is waiting on now (the live prompt), as the agent hands it to the tray.
  let pending = params.get("live") ? {
    action_id: "act-live-000000000001", what: "git push --force origin release/2.4", action_text: "git push origin release/2.4", rule: "force-push-protected",
    rule_title: "Rewrite history on a protected branch", tool: "Claude Code", project: "checkout", reason_min: 10,
    offers: offers(mode === "approval" ? { ask: true } : { once: true, fifteen: true, ask: true }),
    deadline: new Date(Date.now() + 41_000).toISOString(), opened: false,
  } : null;
  let openBlock = params.get("toast") || null;
  const say = (text) => { note = text; };

  const state = () => ({
    link: model ? "answering" : "not_answering",
    state: model ? model.state : "problem",
    stateLabel: model ? { protected: "Protected", working: "Working", offline: "Offline", problem: "Problem", disconnected: "Not connected" }[model.state] || "Needs attention" : "Problem",
    headline: model ? model.headline : "The Scopebond Agent is not answering",
    answer: model ? { tray: model, settings: { notifications } } : null,
    note, busy, version: "0.11.5", autostart: "on", answered, pending, openBlock: (() => { const o = openBlock; openBlock = null; return o; })(),
  });

  const handlers = new Map(Object.entries({
    panel_state: () => state(),
    panel_close: () => { say("(The panel would close here.)"); return null; },
    panel_ready: () => null,
    panel_action: ({ id }) => { say(id === "send_now" ? "Sent 312 records; nothing is waiting" : id === "open_workspace" ? "Opened this computer's page in your workspace" : "Checked just now: all good"); if (id === "send_now") model = scenes.protected(); return true; },
    panel_command: ({ id }) => {
      if (id.startsWith("notifications:")) notifications = id.slice(14);
      else say({ get_help: "Support report copied (no keys, records or commands) · the Help page is opening", copy_diagnostics: "Diagnostics copied (no keys or credentials)", open_logs: "(The logs folder would open.)", about: "(About Scopebond would open.)", hide_icon: "(The icon would hide.)", autostart: "(Start with Windows would change.)", start_agent: "Starting the Scopebond Agent…" }[id] || "Done");
      if (id === "start_agent") model = scenes.protected();
      return true;
    },
    panel_hold: () => null,
    panel_live: ({ actionId, choice, reason }) => {
      if (!pending || pending.action_id !== actionId) return false;
      if (!choice) { pending.opened = true; return true; }
      if (!pending.offers[choice] || String(reason || "").trim().length < pending.reason_min) { say("Say why in at least " + pending.reason_min + " characters."); return false; }
      const what = pending.action_text;
      pending = null;
      say(choice === "ask" ? "Request sent · the answer shows on the block" : (choice === "fifteen" ? "Allowed for 15 minutes" : "Allowed once") + " · Recorded and sent to Acme");
      if (choice !== "ask" && model) model.allowed.unshift({ id: "alw_live", rule: "force-push-protected", rule_title: "Rewrite history on a protected branch", what, choice, state: "active", needs_admin: false, by: "person", created_at: new Date().toISOString(), ends_at: new Date(Date.now() + 15 * MIN).toISOString(), answered_by: null, unblocked: "person" });
      return true;
    },
    panel_stop: ({ id }) => {
      const a = model && model.allowed.find((x) => x.id === id);
      if (!a) return false;
      model.allowed = model.allowed.filter((x) => x.id !== id);
      say((a.kind === "quiet" ? "You'll be asked about " + (a.what || "it") + " again" : "Stopped allowing " + (a.what || "it")) + " · Recorded and sent to Acme");
      return true;
    },
    panel_block: ({ actionId, choice, reason }) => {
      const b = model && model.recent_blocks.find((x) => x.action_id === actionId);
      if (choice) {
        if (!b || !b.offers || !b.offers[choice] || String(reason || "").trim().length < (b.reason_min || 10)) { say("Say why in at least " + ((b && b.reason_min) || 10) + " characters."); return false; }
        busy = "answer:" + actionId;
        setTimeout(() => {
          busy = null;
          b.can_act = false;
          b.acted = choice === "ask" ? "asked" : "allowed";
          const words = { once: "Allowed once", fifteen: "Allowed for 15 minutes", always: "Always allowed on this computer for " + (b.offers.always_days || 30) + " days", ask: "Request sent" }[choice];
          const until = new Date(Date.now() + 15 * MIN).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
          const text = choice === "ask" ? "Request sent · the answer shows on the block"
            : b.offers.reviewed ? "Unblocked until " + until + " · an admin will review it" : words + " · Recorded and sent to Acme";
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
        say(b && b.acted === "allowed" ? "Allowed. Run it again, or let the coding agent retry." : "Request sent · the answer shows on the block");
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
      // The Protection row's packs, opened (packs=1).
      if (params.get("packs")) setTimeout(() => { const d = document.querySelector("details.packs"); if (d) d.open = true; }, 30);
      if (params.get("tab")) click('[data-key="tab-' + params.get("tab") + '"]');
      if (params.get("open")) click('[data-key="block-' + params.get("open") + '"]');
      // A block's details (details=<action id>), and the first group's tries (expand=1).
      if (params.get("expand")) click('[data-key^="tries-"]');
      if (params.get("details")) setTimeout(() => click('[data-key="what-' + params.get("details") + '"], [data-key="try-' + params.get("details") + '"]'), 30);
      // Fill the form as a person would: a choice, a reason, and (with submit) the button.
      if (params.get("choice")) click('[data-key="choice-' + params.get("choice") + '"]');
      const area = document.getElementById("reason");
      if (area && params.get("reason")) { area.value = params.get("reason"); area.dispatchEvent(new Event("input", { bubbles: true })); }
      if (params.get("submit")) setTimeout(() => click('[data-key^="confirm-"]'), 50);
      // Stop allowing, as far as the confirm (stop=<id>), or all the way (&confirm=1).
      if (params.get("stop")) { click('[data-key="stop-' + params.get("stop") + '"]'); if (params.get("confirm")) setTimeout(() => click('[data-key="stop-yes-' + params.get("stop") + '"]'), 50); }
    }, 200);
  });
})();
