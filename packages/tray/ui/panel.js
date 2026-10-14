// The status panel. It draws what the tray holds from the agent's tray model (`panel_state`) and asks the tray to run
// the actions the model offers. Blocked comes first: what was blocked, the rule, the project and the tool, and what the
// person may do about it. Text from the agent is only ever set as text, never parsed as markup.
"use strict";

(function () {
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});
  const root = document.getElementById("panel");
  const SVG = "http://www.w3.org/2000/svg";
  // What the person is looking at; kept across redraws.
  const ui = { view: "list", tab: "blocked" };
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

  function blockItem(b, i, busy) {
    const words = b.what || b.summary;
    const meta = [b.rule_title, b.project, b.tool].filter(Boolean).join(" · ");
    const offers = b.offers;
    const allows = offers ? offers.once || offers.fifteen || offers.always : b.can_act;
    let act = null;
    if (b.acted === "allowed") act = el("span", { class: "chip ok", text: "Allowed" });
    else if (b.acted === "asked") act = el("span", { class: "chip wait", text: "Request sent" });
    else if (b.can_act && b.action_id && (allows || (offers && offers.ask))) {
      const mine = busy === "block:" + b.action_id;
      act = el("div", { class: "acts" }, [el("button", {
        class: "btn" + (allows ? " primary" : ""), type: "button", "data-key": "block-" + b.action_id, disabled: !!busy,
        "aria-busy": mine ? "true" : null,
        "aria-label": (allows ? "Unblock: " : "Ask to unblock: ") + words,
        text: mine ? "Waiting for your answer…" : allows ? "Unblock…" : "Ask to unblock…",
        onclick: () => run("block", b.action_id),
      })]);
    }
    return el("li", { class: "item", "data-index": String(i) }, [
      el("div", { class: "row" }, [
        el("span", { class: "mark", "aria-hidden": "true" }),
        el("span", { class: "what", text: words }),
        el("span", { class: "when", text: when(b.at) }),
      ]),
      meta ? el("span", { class: "meta", text: meta }) : null,
      act,
    ]);
  }

  function blockedList(s, model) {
    const blocks = model && model.recent_blocks || [];
    if (!blocks.length) return [empty("Nothing blocked today", "Scopebond checks every action your coding agents take.")];
    const today = blocks.filter((b) => isToday(b.at));
    const earlier = blocks.filter((b) => !isToday(b.at));
    const out = [];
    if (!today.length) out.push(empty("Nothing blocked today", "Earlier blocks are below."));
    else out.push(el("h2", { id: "today-h", text: "Today" }), el("ul", { "aria-labelledby": "today-h" }, today.map((b, i) => blockItem(b, i, s.busy))));
    if (earlier.length) out.push(el("h2", { id: "earlier-h", text: "Earlier" }), el("ul", { "aria-labelledby": "earlier-h" }, earlier.map((b, i) => blockItem(b, today.length + i, s.busy))));
    return out;
  }

  function list(s, model) {
    let body;
    if (ui.tab === "allowed") body = [empty("Nothing allowed right now", "What you let through shows here until it ends.")];
    else if (ui.tab === "asked") body = [empty("No requests", "When you ask to unblock something, the answer shows here.")];
    else body = blockedList(s, model);
    return el("div", { class: "list", id: "list", role: "tabpanel", "aria-labelledby": "tab-" + ui.tab, tabindex: "-1" }, body);
  }

  // ---- Settings: notifications, start with Windows, this computer, the other actions, help.
  function settings(s, model) {
    const answer = s.answer;
    const current = answer && answer.settings ? answer.settings.notifications : "problems";
    const agentUp = !!model;
    const radios = [["all", "Blocks and problems"], ["problems", "Problems only"], ["off", "Off"]];
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
    // Keep keyboard focus on the same control across redraws.
    const active = document.activeElement;
    const focused = focusKey || (active && active.dataset ? active.dataset.key : null);
    const parts = [header(s, model)];
    // The status line: a polite live region, so a screen reader hears results and changes without losing its place.
    const note = s.note || "";
    parts.push(el("p", { id: "status", class: "status" + (note ? "" : " empty"), role: "status", "aria-live": "polite", text: note }));
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
    const again = focused && root.querySelector('[data-key="' + CSS.escape(focused) + '"]');
    if (again && !again.disabled) again.focus();
  }

  async function refresh() {
    let s;
    try { s = await invoke("panel_state"); } catch (_) { return; }
    const json = JSON.stringify(s);
    if (json === lastJson) return;
    const first = lastJson === "";
    lastJson = json;
    last = s;
    draw();
    if (first) {
      const start = root.querySelector(".banner .primary") || root.querySelector('[role="tab"][aria-selected="true"]') || root.querySelector("button");
      if (start) start.focus();
    }
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); invoke("panel_close"); }
  });
  // No browser menu or reload in a status panel.
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  refresh();
  setInterval(refresh, 2000);
})();
