// The status panel. It draws what the tray holds from the agent's tray model (`panel_state`) and asks the tray to run
// the actions the model offers. Blocked comes first: what was blocked, the rule, the project and the tool, and what the
// person may do about it, with the Unblock form right there; then what was allowed and what was asked. Text from the agent
// is only ever set as text, never parsed as markup.
"use strict";

(function () {
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});
  const root = document.getElementById("panel");
  const SVG = "http://www.w3.org/2000/svg";
  // What the person is looking at; kept across redraws.
  // `open`: the block whose Unblock form is open, with the choice and the reason typed so far.
  const ui = { view: "list", tab: "blocked", open: null, choice: null, reason: "" };
  let last = null;
  let lastJson = "";

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key === "onclick") node.addEventListener("click", value);
      else if (key === "onchange") node.addEventListener("change", value);
      else if (key === "onkeydown") node.addEventListener("keydown", value);
      else if (key === "oninput") node.addEventListener("input", value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children || []) if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    return node;
  }

  /** A small icon drawn from a fixed path (never from the agent's text). */
  function icon(d, stroke) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    if (stroke) { path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5"); path.setAttribute("stroke-linecap", "round"); }
    else path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    return svg;
  }
  const GEAR = "M8 5.2A2.8 2.8 0 1 0 8 10.8 2.8 2.8 0 0 0 8 5.2zm6.3 3.6l-1.4.3a5 5 0 0 1-.4 1l.8 1.2-1.1 1.1-1.2-.8a5 5 0 0 1-1 .4l-.3 1.4H7.3L7 12a5 5 0 0 1-1-.4l-1.2.8-1.1-1.1.8-1.2a5 5 0 0 1-.4-1L2.7 8.8V7.2L4.1 7a5 5 0 0 1 .4-1l-.8-1.2 1.1-1.1 1.2.8a5 5 0 0 1 1-.4l.3-1.4h1.4l.3 1.4a5 5 0 0 1 1 .4l1.2-.8 1.1 1.1-.8 1.2a5 5 0 0 1 .4 1l1.4.3z";
  const CROSS = "M4 4l8 8M12 4l-8 8";

  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  function when(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const days = Math.round((day(new Date()) - day(d)) / 86400000);
    if (days <= 0) return t;
    if (days === 1) return "Yesterday " + t;
    if (days < 7) return d.toLocaleDateString([], { weekday: "short" }) + " " + t;
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  const isToday = (iso) => { const d = new Date(iso); return !Number.isNaN(d.getTime()) && day(d) === day(new Date()); };
  const plural = (n, one, many) => n.toLocaleString() + " " + (n === 1 ? one : many);

  async function run(kind, value) {
    try {
      if (kind === "action") await invoke("panel_action", { id: value });
      else if (kind === "block") await invoke("panel_block", { actionId: value });
      else await invoke("panel_command", { id: value });
    } catch (_) { /* the next refresh shows the state */ }
    setTimeout(refresh, 150);
  }

  function offered(model, id) {
    if (!model) return null;
    return [model.fix].concat(model.actions || []).find((a) => a && a.id === id) || null;
  }

  // ---- The Unblock form: the choices the workspace offers for this block, a reason, and a button named for the result.
  const CHOICES = ["once", "fifteen", "always", "ask"];
  const BUTTON = { once: "Allow once", fifteen: "Allow for 15 minutes", always: "Always allow", ask: "Send to admin" };
  const choicesOf = (b) => CHOICES.filter((c) => b.offers && b.offers[c]);
  let holding = false;
  function hold(on) {
    if (on === holding) return;
    holding = on;
    invoke("panel_hold", { hold: on }).catch(() => {});
  }
  function openForm(b) {
    ui.open = b.action_id;
    ui.choice = choicesOf(b)[0] || null;
    ui.reason = "";
    ui.view = "list";
    ui.tab = "blocked";
    hold(true);
  }
  function closeForm() {
    ui.open = null;
    ui.choice = null;
    ui.reason = "";
    hold(false);
  }
  async function submit(b) {
    let sent = false;
    try { sent = await invoke("panel_block", { actionId: b.action_id, choice: ui.choice, reason: ui.reason }); } catch (_) { /* the note says why */ }
    if (sent) closeForm();
    setTimeout(refresh, 150);
  }
  function choiceWords(b, c) {
    const until = new Date(Date.now() + 15 * 60000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const o = b.offers || {};
    const days = o.always_days || 30;
    return {
      once: ["Just this once", "The next time it runs"],
      fifteen: ["For 15 minutes", "This action, until " + until],
      always: ["Always on this computer", o.always_needs_admin ? "After an admin approves; allowed for 15 minutes meanwhile" : "For " + days + " days"],
      ask: [choicesOf(b).length > 1 ? "Ask an admin instead" : "Ask an admin", "They answer in Scopebond Cloud; you see it under Asked"],
    }[c];
  }
  function countText(b) {
    const min = b.reason_min || 10;
    const left = min - ui.reason.trim().length;
    return left > 0 ? left + (left === 1 ? " more character" : " more characters") : "Enough";
  }
  function unblockForm(s, model, b) {
    const id = b.action_id;
    const busy = s.busy === "answer:" + id;
    const enough = ui.reason.trim().length >= (b.reason_min || 10);
    const choices = choicesOf(b);
    // Where the workspace only lets the person ask an admin, there is nothing to choose: the reason and Send to admin.
    const askOnly = choices.length === 1 && choices[0] === "ask";
    const where = askOnly ? "You'll see the answer under Asked"
      : model.workspace ? "Recorded and sent to " + model.workspace : "Recorded and sent to your workspace";
    const update = () => {
      const count = document.getElementById("count-" + id);
      if (count) count.textContent = countText(b);
      const go = root.querySelector('[data-key="confirm-' + CSS.escape(id) + '"]');
      if (go) go.disabled = !!s.busy || ui.reason.trim().length < (b.reason_min || 10);
    };
    return el("div", { class: "form", role: "group", "aria-label": (askOnly ? "Ask an admin about " : "Unblock ") + (b.what || b.summary) }, [
      el("div", { class: "cmd", "aria-label": "What ran", text: b.action_text || b.what || b.summary }),
      askOnly ? null : el("fieldset", { class: "choices" }, [el("legend", { text: choices.some((c) => c !== "ask") ? "Let it through" : "What to do" })].concat(choices.map((c) => {
        const [title, small] = choiceWords(b, c);
        return el("label", { class: "choice" }, [
          el("input", { type: "radio", name: "choice-" + id, value: c, "data-key": "choice-" + c, checked: ui.choice === c,
            onchange: () => { ui.choice = c; draw("choice-" + c); } }),
          el("span", {}, [title, el("small", { text: small })]),
        ]);
      }))),
      el("label", { class: "reason" }, [
        el("span", {}, ["Why ", el("span", { class: "count", id: "count-" + id, text: countText(b) })]),
        el("textarea", { id: "reason", "data-key": "reason", rows: "2", maxlength: "500", "aria-describedby": "count-" + id,
          placeholder: "For example: the tests need the production API URL",
          oninput: (e) => { ui.reason = e.target.value; hold(true); update(); } }),
      ]),
      el("div", { class: "acts" }, [
        el("button", { class: "btn primary", type: "button", "data-key": "confirm-" + id, disabled: !enough || !!s.busy, "aria-busy": busy ? "true" : null,
          text: busy ? "Sending…" : BUTTON[ui.choice] || "Send", onclick: () => submit(b) }),
        el("button", { class: "btn", type: "button", "data-key": "cancel-" + id, text: "Cancel", onclick: () => { closeForm(); draw("block-" + id); } }),
      ]),
      el("span", { class: "meta", text: where }),
    ]);
  }

  // ---- The header: the S tile and its badge, the state, one line under it.
  function header(s, model) {
    const settings = ui.view === "settings";
    let sub = model ? (model.state === "protected" ? model.detail || "" : model.headline) : s.headline;
    if (sub === s.stateLabel) sub = "";
    return el("header", { class: "head" }, [
      el("span", { class: "tilewrap", role: "img", "aria-label": "Scopebond: " + s.stateLabel }, [
        el("span", { class: "tile", "aria-hidden": "true", text: "S" }),
        el("span", { class: "dot state-" + s.state, "aria-hidden": "true" }),
      ]),
      el("div", { class: "titles" }, [
        el("h1", { id: "headline", text: s.stateLabel }),
        sub ? el("p", { class: "sub", id: "subline", text: sub }) : null,
      ]),
      el("button", {
        class: "ibtn", type: "button", "data-key": "settings", "aria-label": "Settings", "aria-pressed": settings ? "true" : "false",
        onclick: () => { ui.view = settings ? "list" : "settings"; draw(); },
      }, [icon(GEAR)]),
      el("button", { class: "ibtn", type: "button", "data-key": "close", "aria-label": "Close", onclick: () => invoke("panel_close") }, [icon(CROSS, true)]),
    ]);
  }

  // ---- The one problem and its one fix, only when there is one.
  function banner(s, model) {
    if (!model) {
      if (s.link !== "not_answering" && s.link !== "stopped") return null;
      return el("div", { class: "banner state-problem" }, [
        el("p", { text: s.link === "stopped" ? "It was stopped on this computer. Your coding agents are still checked; start it to see what was blocked." : "Your coding agents are still checked. Start it to see what was blocked and to send records." }),
        el("div", {}, [el("button", { class: "btn primary", type: "button", "data-key": "start", text: "Start the Scopebond Agent", onclick: () => run("command", "start_agent") })]),
      ]);
    }
    const quiet = model.state === "protected" || model.state === "working";
    const hint = quiet ? null : model.hint;
    if (!model.fix && !hint) return null;
    const busy = s.busy;
    return el("div", { class: "banner state-" + model.state }, [
      hint ? el("p", { text: hint }) : null,
      model.fix ? el("div", {}, [el("button", {
        class: "btn primary", type: "button", "data-key": "fix", disabled: !!busy, "aria-busy": busy === model.fix.id ? "true" : null,
        text: busy === model.fix.id ? "Working…" : model.fix.label, onclick: () => run("action", model.fix.id),
      })]) : null,
    ]);
  }

  // ---- Blocked · Allowed · Requests (the requests to an admin are "asked" in the agent's model)
  const TABS = [["blocked", "Blocked"], ["allowed", "Allowed"], ["asked", "Requests"]];
  /** Requests is there when the workspace lets the person ask an admin (under any rule, or for a listed block), or when they
   *  have asked before; otherwise the panel does not mention asking at all. Allowed always is (it also lists what an admin
   *  approved). */
  function showsAsked(model) {
    if (!model) return false;
    return model.can_ask === true || (model.asked || []).length > 0 || (model.recent_blocks || []).some((b) => b.offers && b.offers.ask);
  }
  function tabs(model) {
    const blocked = (model && model.recent_blocks || []).filter((b) => isToday(b.at) && !b.acted).length;
    const counts = { blocked, allowed: model && model.allowed ? model.allowed.length : 0, asked: model && model.asked ? model.asked.length : 0 };
    const shown = TABS.filter(([k]) => k !== "asked" || showsAsked(model));
    if (!shown.some(([k]) => k === ui.tab)) ui.tab = "blocked";
    const keys = shown.map(([k]) => k);
    const move = (e) => {
      const i = keys.indexOf(ui.tab);
      const next = e.key === "ArrowRight" ? keys[(i + 1) % keys.length] : e.key === "ArrowLeft" ? keys[(i + keys.length - 1) % keys.length]
        : e.key === "Home" ? keys[0] : e.key === "End" ? keys[keys.length - 1] : null;
      if (!next) return;
      e.preventDefault();
      ui.tab = next;
      draw("tab-" + next);
    };
    return el("div", { class: "seg", role: "tablist", "aria-label": "Lists" }, shown.map(([k, label]) => el("button", {
      type: "button", role: "tab", id: "tab-" + k, "data-key": "tab-" + k, "aria-selected": ui.tab === k ? "true" : "false",
      "aria-controls": "list", tabindex: ui.tab === k ? "0" : "-1", onkeydown: move,
      onclick: () => { ui.tab = k; draw("tab-" + k); },
    }, [label, counts[k] ? el("span", { class: "n", text: String(counts[k]) }) : null])));
  }

  function empty(title, text) {
    return el("div", { class: "empty" }, [el("strong", { text: title }), el("span", { text })]);
  }

  function blockItem(s, model, b, i) {
    const busy = s.busy;
    const words = b.what || b.summary;
    const meta = [b.rule_title, b.project, b.tool].filter(Boolean).join(" · ");
    const offers = b.offers;
    const allows = offers ? offers.once || offers.fifteen || offers.always : b.can_act;
    let act = null;
    if (b.acted === "allowed") act = el("span", { class: "chip ok", text: "Allowed" });
    else if (b.acted === "asked") act = el("span", { class: "chip wait", text: "Sent to an admin" });
    else if (b.can_act && b.action_id && ui.open === b.action_id && offers) act = unblockForm(s, model, b);
    else if (b.can_act && b.action_id && (allows || (offers && offers.ask))) {
      const mine = busy === "block:" + b.action_id;
      act = el("div", { class: "acts" }, [el("button", {
        class: "btn" + (allows ? " primary" : ""), type: "button", "data-key": "block-" + b.action_id, disabled: !!busy,
        "aria-busy": mine ? "true" : null, "aria-expanded": offers ? "false" : null,
        "aria-label": (allows ? "Unblock: " : "Ask an admin about: ") + words,
        text: mine ? "Waiting for your answer…" : allows ? "Unblock…" : "Ask an admin…",
        // The form here when the agent says what may be done; an older agent's Scopebond window otherwise.
        onclick: () => { if (offers) { openForm(b); draw("reason"); } else run("block", b.action_id); },
      })]);
    }
    const answered = s.answered && s.answered.actionId === b.action_id && ["allowed", "proposed", "asked"].includes(s.answered.outcome) ? s.answered.text : null;
    return el("li", { class: "item", "data-index": String(i) }, [
      el("div", { class: "row" }, [
        el("span", { class: "mark", "aria-hidden": "true" }),
        el("span", { class: "what", text: words }),
        el("span", { class: "when", text: when(b.at) }),
      ]),
      meta ? el("span", { class: "meta", text: meta }) : null,
      answered ? el("span", { class: "done", text: answered }) : act,
    ]);
  }

  function blockedList(s, model) {
    const blocks = model && model.recent_blocks || [];
    if (!blocks.length) return [empty("Nothing blocked today", "Scopebond checks every action your coding agents take.")];
    const today = blocks.filter((b) => isToday(b.at));
    const earlier = blocks.filter((b) => !isToday(b.at));
    const out = [];
    if (!today.length) out.push(empty("Nothing blocked today", "Earlier blocks are below."));
    else out.push(el("h2", { id: "today-h", text: "Today" }), el("ul", { "aria-labelledby": "today-h" }, today.map((b, i) => blockItem(s, model, b, i))));
    if (earlier.length) out.push(el("h2", { id: "earlier-h", text: "Earlier" }), el("ul", { "aria-labelledby": "earlier-h" }, earlier.map((b, i) => blockItem(s, model, b, today.length + i))));
    return out;
  }

  function ends(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const left = d.getTime() - Date.now();
    if (left < 36 * 3600000) return "Ends " + when(iso);
    return Math.round(left / 86400000) + " days left";
  }
  function allowedList(model) {
    const items = model.allowed || [];
    if (!items.length) return [empty("Nothing allowed right now", "What you let through shows here until it ends.")];
    return [el("ul", { "aria-label": "Allowed" }, items.map((a) => {
      const how = a.choice === "once" ? "Just this once" : a.choice === "fifteen" ? "For 15 minutes" : a.by === "admin" ? "Approved by " + (a.answered_by || "an admin") : "Always on this computer";
      const end = a.state === "proposed" ? "Waiting for an admin" : a.choice === "once" ? "Until it runs again" : ends(a.ends_at);
      return el("li", { class: "item" }, [
        el("div", { class: "row" }, [
          el("span", { class: "what", text: a.what || (a.rule_title ? "An action under " + a.rule_title : "An action") }),
          el("span", { class: "chip " + (a.state === "proposed" ? "wait" : "ok"), text: a.state === "proposed" ? "Waiting" : "Active" }),
        ]),
        el("span", { class: "meta", text: [how, end, a.what ? a.rule_title : null].filter(Boolean).join(" · ") }),
      ]);
    }))];
  }
  function askedList(model) {
    const items = model.asked || [];
    if (!items.length) return [empty("No requests to an admin", "When you ask an admin to allow something, their answer shows here.")];
    return [el("ul", { "aria-label": "Asked" }, items.map((r) => {
      const chip = r.state === "approved" ? ["ok", "Approved"] : r.state === "declined" ? ["no", "Declined"] : ["wait", "Waiting for an admin"];
      const who = r.answered_by ? " by " + r.answered_by : "";
      const said = r.state === "approved" ? "Approved" + who : r.state === "declined" ? "Declined" + who : "Asked " + when(r.asked_at) + (r.sent ? "" : " · not sent yet");
      return el("li", { class: "item" }, [
        el("div", { class: "row" }, [el("span", { class: "what", text: r.what }), el("span", { class: "chip " + chip[0], text: chip[1] })]),
        el("span", { class: "meta", text: [said, r.rule_title].filter(Boolean).join(" · ") }),
        r.note ? el("span", { class: "meta", text: "“" + r.note + "”" }) : null,
        el("span", { class: "meta", text: "Your reason: " + r.reason }),
      ]);
    }))];
  }

  function list(s, model) {
    let body;
    if (ui.tab === "allowed") body = allowedList(model);
    else if (ui.tab === "asked") body = askedList(model);
    else body = blockedList(s, model);
    return el("div", { class: "list", id: "list", role: "tabpanel", "aria-labelledby": "tab-" + ui.tab, tabindex: "-1" }, body);
  }

  // ---- Settings: notifications, start with Windows, this computer, the other actions, help.
  function settings(s, model) {
    const answer = s.answer;
    const current = answer && answer.settings ? answer.settings.notifications : "problems";
    const agentUp = !!model;
    const radios = [["blocks", "Blocks and problems"], ["problems", "Problems only"], ["off", "Off"]];
    const managed = s.autostart === "managed";
    const busy = s.busy;
    const actions = model ? [model.fix].concat(model.actions || []).filter((a, i, all) => a && a.id !== "open_workspace" && all.findIndex((x) => x && x.id === a.id) === i) : [];
    const rows = model && model.rows || [];
    return el("div", { class: "settings", role: "region", "aria-label": "Settings" }, [
      el("div", {}, [el("button", { class: "btn text", type: "button", "data-key": "back", text: "← Back", onclick: () => { ui.view = "list"; draw("settings"); } })]),
      el("fieldset", {}, [el("legend", { text: "Notifications" })].concat(radios.map(([v, label]) => el("label", { class: "radio" }, [
        el("input", { type: "radio", name: "notifications", value: v, "data-key": "notify-" + v, checked: current === v, disabled: !agentUp,
          onchange: () => run("command", "notifications:" + v) }),
        label,
      ])))),
      el("label", { class: "toggle" }, [
        el("span", { text: managed ? "Start with Windows (set for every user)" : "Start with Windows" }),
        el("input", { type: "checkbox", "data-key": "autostart", checked: s.autostart !== "off", disabled: managed, onchange: () => run("command", "autostart") }),
      ]),
      el("section", { "aria-labelledby": "computer-h" }, [
        el("h2", { id: "computer-h", text: "This computer" }),
        rows.length ? el("dl", { class: "rows" }, rows.flatMap((r) => [el("dt", { text: r.label }), el("dd", { text: r.value })])) : el("p", { class: "note", text: s.headline }),
        model && model.state === "protected" && model.hint ? el("p", { class: "note", text: model.hint }) : null,
      ]),
      el("div", { class: "linkrow", role: "group", "aria-label": "Actions" }, actions.map((a) => el("button", {
        class: "btn text", type: "button", "data-key": "action-" + a.id, disabled: !!busy, "aria-busy": busy === a.id ? "true" : null,
        text: busy === a.id ? "Working…" : a.label, onclick: () => run("action", a.id),
      })).concat([
        el("button", { class: "btn text", type: "button", "data-key": "diagnostics", text: "Copy diagnostics", onclick: () => run("command", "copy_diagnostics") }),
        el("button", { class: "btn text", type: "button", "data-key": "logs", text: "Open logs folder", onclick: () => run("command", "open_logs") }),
      ])),
      el("div", { class: "linkrow" }, [
        el("button", { class: "btn text", type: "button", "data-key": "about", text: "Help", onclick: () => run("command", "about") }),
        el("button", { class: "btn text", type: "button", "data-key": "hide", text: "Hide icon", onclick: () => run("command", "hide_icon") }),
      ]),
      el("p", { class: "note", text: "Scopebond tray " + s.version }),
    ]);
  }

  function footer(model) {
    const open = offered(model, "open_workspace");
    const today = model && model.today;
    if (!open && !today) return null;
    return el("footer", { class: "foot" }, [
      el("span", { class: "grow", text: today ? "Today: " + plural(today.actions, "action", "actions") : "" }),
      open ? el("button", {
        class: "btn text", type: "button", "data-key": "cloud", text: (model.workspace ? "Open " + model.workspace + " in Scopebond Cloud" : "Open in Scopebond Cloud") + " ↗",
        onclick: () => run("action", "open_workspace"),
      }) : null,
    ]);
  }

  function draw(focusKey) {
    const s = last;
    if (!s) return;
    const model = s.answer && s.answer.tray;
    // The form's block is gone (answered elsewhere, or no longer offered): close the form.
    if (ui.open && !(model && (model.recent_blocks || []).some((b) => b.action_id === ui.open && b.can_act && b.offers))) closeForm();
    const typing = document.activeElement && document.activeElement.id === "reason" ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    // Keep keyboard focus on the same control across redraws.
    const active = document.activeElement;
    const focused = focusKey || (active && active.dataset ? active.dataset.key : null);
    const parts = [header(s, model)];
    // The status line: a polite live region, so a screen reader hears results and changes without losing its place.
    const note = s.note || "";
    // When the block's own line already shows the result, the live region still says it, without showing it twice.
    const shown = ui.view !== "settings" && s.answered && s.answered.text === note;
    parts.push(el("p", { id: "status", class: "status" + (note ? "" : " empty") + (shown ? " sr-only" : ""), role: "status", "aria-live": "polite", text: note }));
    if (ui.view === "settings") {
      parts.push(settings(s, model));
    } else if (!model) {
      // Nothing to list until the agent answers.
      parts.push(banner(s, model));
      parts.push(el("div", { class: "list", id: "list" }, [empty("Waiting for the Scopebond Agent", "What was blocked shows here once it answers.")]));
    } else {
      parts.push(banner(s, model));
      parts.push(tabs(model));
      parts.push(list(s, model));
      parts.push(footer(model));
    }
    root.replaceChildren(...parts.filter(Boolean));
    root.setAttribute("aria-busy", s.busy ? "true" : "false");
    const area = document.getElementById("reason");
    if (area) area.value = ui.reason;
    const again = focused && root.querySelector('[data-key="' + CSS.escape(focused) + '"]');
    if (again && !again.disabled) again.focus();
    if (area && typing && document.activeElement === area) area.setSelectionRange(typing[0], typing[1]);
  }

  async function refresh() {
    let s;
    try { s = await invoke("panel_state"); } catch (_) { return; }
    const json = JSON.stringify(s);
    if (json === lastJson) return;
    const first = lastJson === "";
    lastJson = json;
    last = s;
    // A notification's Unblock…: open that block's form.
    const target = s.openBlock && s.answer && s.answer.tray && (s.answer.tray.recent_blocks || []).find((b) => b.action_id === s.openBlock && b.can_act && b.offers);
    if (target) { openForm(target); draw("reason"); return; }
    draw();
    if (first) {
      const start = root.querySelector(".banner .primary") || root.querySelector('[role="tab"][aria-selected="true"]') || root.querySelector("button");
      if (start) start.focus();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    // Esc first leaves the form, then closes the panel.
    if (ui.open) { const id = ui.open; closeForm(); draw("block-" + id); return; }
    invoke("panel_close");
  });
  // No browser menu or reload in a status panel.
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  refresh();
  setInterval(refresh, 2000);
})();
