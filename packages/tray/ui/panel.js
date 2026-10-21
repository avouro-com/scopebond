// The status panel. It draws what the tray holds from the agent's tray model (`panel_state`) and asks the tray to run
// the actions the model offers. Blocked comes first: what was blocked, the rule, the project and the tool, and what the
// person may do about it, with the Unblock form right there; then what was allowed and what was asked. Text from the agent
// is only ever set as text, never parsed as markup.
"use strict";

(function () {
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});
  const root = document.getElementById("panel");
  const SVG = "http://www.w3.org/2000/svg";
  // Blocks shown at a time; "Show more" adds as many again.
  const PAGE = 50;
  // What the person is looking at; kept across redraws.
  // `open`: the block whose Unblock form is open, with the choice and the reason typed so far.
  // `stopping`: the allowance whose "Stop allowing" waits for the person to confirm.
  // `shown`: how many rows the list shows (50 at a time).
  // `details`: the block whose details are open; `expanded`: the group whose tries are listed.
  const ui = { view: "list", tab: "blocked", open: null, choice: null, reason: "", stopping: null, shown: PAGE, details: null, expanded: null };
  let last = null;
  let lastJson = "";
  // Whether the tray was told the page has drawn (it made the window hidden, and shows it then).
  let ready = false;

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
  // The rule's name when the agent sends none (an older agent): never an empty line, never a rule id.
  const ANY_RULE = "A Scopebond rule";
  const ruleOf = (item) => (item.rule_title && String(item.rule_title).trim()) || ANY_RULE;
  // An action known only by its rule, in words: "An action under “Delete files”".
  const underRule = (item) => "An action under “" + ruleOf(item) + "”";

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
  const BUTTON = { once: "Allow once", fifteen: "Allow for 15 minutes", always: "Always allow", ask: "Send request" };
  const choicesOf = (b) => CHOICES.filter((c) => b.offers && b.offers[c]);
  let holding = false;
  function hold(on) {
    if (on === holding) return;
    holding = on;
    invoke("panel_hold", { hold: on }).catch(() => {});
  }
  // The hook's question waiting now (the live prompt), drawn and answered like a block.
  function pendingBlock(s) {
    const q = s && s.pending;
    if (!q || !q.action_id) return null;
    return Object.assign({}, q, { summary: q.what, can_act: true, acted: null, live: true, at: null });
  }
  function secondsLeft(deadline) {
    const left = Math.round((Date.parse(deadline) - Date.now()) / 1000);
    return Number.isFinite(left) ? Math.max(0, left) : 0;
  }
  function openForm(b) {
    // The person opened the waiting question here: no Scopebond window for it.
    if (b.live) invoke("panel_live", { actionId: b.action_id }).catch(() => {});
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
    try { sent = await invoke(b.live ? "panel_live" : "panel_block", { actionId: b.action_id, choice: ui.choice, reason: ui.reason }); } catch (_) { /* the note says why */ }
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
      ask: ["Ask an admin to unblock it instead", "An admin decides; the answer shows on the block"],
    }[c];
  }
  /** The length on its own, for a form with nothing to choose. */
  function lengthWords(b, c) {
    const o = b.offers || {};
    return { once: "Just this once", fifteen: "For 15 minutes", always: "For " + (o.always_days || 30) + " days" }[c] || "";
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
    // Where an admin decides, there is nothing to choose: the action, the reason and Send request.
    const askOnly = choices.length === 1 && choices[0] === "ask";
    // Where the workspace set the one length (and, it may be, reviews every unblock later), nothing to choose either: one
    // line names the length.
    const oneLength = choices.length === 1 && !askOnly;
    const reviewed = !!(b.offers && b.offers.reviewed);
    const where = askOnly ? "An admin decides; the answer shows on the block"
      : model.workspace ? "Recorded and sent to " + model.workspace : "Recorded and sent to your workspace";
    const fixedLine = oneLength ? lengthWords(b, choices[0]) + (reviewed ? ", set by your workspace; an admin reviews it later" : "") : null;
    const update = () => {
      const count = document.getElementById("count-" + id);
      if (count) count.textContent = countText(b);
      const go = root.querySelector('[data-key="confirm-' + CSS.escape(id) + '"]');
      if (go) go.disabled = !!s.busy || ui.reason.trim().length < (b.reason_min || 10);
    };
    return el("div", { class: "form", role: "group", "aria-label": (askOnly ? "Ask to unblock " : "Unblock ") + (b.what || b.summary) }, [
      el("div", { class: "cmd", "aria-label": "What ran", text: b.action_text || b.what || b.summary }),
      fixedLine ? el("p", { class: "fixed", text: fixedLine }) : null,
      askOnly || oneLength ? null : el("fieldset", { class: "choices" }, [el("legend", { text: choices.some((c) => c !== "ask") ? "Let it through" : "What to do" })].concat(choices.map((c) => {
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
          text: busy ? "Sending…" : oneLength && reviewed ? "Unblock now" : BUTTON[ui.choice] || "Send", onclick: () => submit(b) }),
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

  // ---- Blocked · Allowed. A request to an admin shows on its block's row (waiting, approved, declined), not in a list of its
  // own; Allowed lists what is let through now and what the person chose to keep blocked without being asked.
  const TABS = [["blocked", "Blocked"], ["allowed", "Allowed"]];
  function tabs(model) {
    // The agent's one count of today's distinct blocks (the header and the menu show the same); an older agent's list otherwise.
    const blocked = model && model.today && typeof model.today.blocked === "number" ? model.today.blocked
      : (model && model.recent_blocks || []).filter((b) => isToday(b.at) && !b.acted).length;
    const counts = { blocked, allowed: model && model.allowed ? model.allowed.length : 0 };
    const shown = TABS;
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

  async function copyDetails(text) {
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch (_) { /* said below */ }
    if (last) { last.note = copied ? "Details copied: paste them in a chat or a ticket" : "Couldn't copy the details"; draw(); }
  }
  /** The sentence that stands in for a button (always on, set by the workspace, Safe Install, a request's answer), with
   *  Copy details where it helps to ask someone. */
  function outcomeLine(b) {
    const tone = b.outcome === "requested" && b.request && b.request.state === "approved" ? " ok"
      : b.outcome === "requested" && b.request && b.request.state === "declined" ? " no" : b.outcome === "allowed" ? " ok" : "";
    return el("div", { class: "outcome" + tone }, [
      el("span", { text: b.outcome_text }),
      b.copy_details ? el("button", { class: "btn text", type: "button", "data-key": "copy-" + b.action_id, "aria-label": "Copy details: " + (b.what || b.summary),
        text: "Copy details", onclick: () => copyDetails(b.copy_details) }) : null,
    ]);
  }

  /** A block's details: the exact command (masked), why the rule exists, the record's id, and its place in Scopebond Cloud. */
  function details(model, b) {
    const id = b.action_id || "";
    const cloud = offered(model, "open_workspace");
    return el("div", { class: "details", id: "details-" + id, role: "region", "aria-label": "Details: " + (b.what || b.summary) }, [
      el("dl", { class: "rows" }, [
        el("dt", { text: "Command" }), el("dd", {}, [el("div", { class: "cmd", text: b.action_text || b.what || b.summary })]),
        b.rule_why ? el("dt", { text: "Why" }) : null, b.rule_why ? el("dd", { text: b.rule_why }) : null,
        el("dt", { text: "Rule" }), el("dd", { text: ruleOf(b) }),
        id ? el("dt", { text: "Record" }) : null, id ? el("dd", { class: "mono", text: id }) : null,
      ]),
      cloud ? el("div", {}, [el("button", { class: "btn text", type: "button", "data-key": "cloud-" + id, text: "View in Scopebond Cloud ↗",
        onclick: () => run("action", "open_workspace") })]) : null,
    ]);
  }
  /** The title of a block's row: a button that opens and closes its details. */
  function whatButton(b, words) {
    const id = b.action_id || "";
    const open = !!id && ui.details === id;
    if (!id) return el("span", { class: "what", text: words });
    return el("button", { class: "what link", type: "button", "data-key": "what-" + id, "aria-expanded": open ? "true" : "false", "aria-controls": "details-" + id,
      onclick: () => { ui.details = open ? null : id; draw("what-" + id); } }, [words]);
  }

  function blockItem(s, model, b, i, group) {
    const busy = s.busy;
    const words = b.what || b.summary;
    const times = group ? group.times : (b.tries && b.tries > 1 ? b.tries : 1);
    const repeated = times > 1 && b.at ? times + " times · last " + when(b.at) : null;
    const meta = [ruleOf(b), repeated, b.project, b.tool].filter(Boolean).join(" · ");
    const offers = b.offers;
    const allows = offers ? offers.once || offers.fifteen || offers.always : b.can_act;
    let act = null;
    if (b.outcome_text && !(ui.open === b.action_id && offers)) act = outcomeLine(b);
    else if (b.acted === "allowed") act = el("span", { class: "chip ok", text: "Allowed" });
    else if (b.acted === "asked") act = el("span", { class: "chip wait", text: "Request sent" });
    else if (b.can_act && b.action_id && ui.open === b.action_id && offers) act = unblockForm(s, model, b);
    else if (b.can_act && b.action_id && (allows || (offers && offers.ask))) {
      const mine = busy === "block:" + b.action_id;
      act = el("div", { class: "acts" }, [el("button", {
        class: "btn" + (allows ? " primary" : ""), type: "button", "data-key": "block-" + b.action_id, disabled: !!busy,
        "aria-busy": mine ? "true" : null, "aria-expanded": offers ? "false" : null,
        "aria-label": (allows ? "Unblock: " : "Ask to unblock: ") + words,
        text: mine ? "Waiting for your answer…" : allows ? "Unblock…" : "Ask to unblock…",
        // The form here when the agent says what may be done; an older agent's Scopebond window otherwise.
        onclick: () => { if (offers) { openForm(b); draw("reason"); } else run("block", b.action_id); },
      })]);
    }
    const answered = s.answered && s.answered.actionId === b.action_id && ["allowed", "proposed", "asked"].includes(s.answered.outcome) ? s.answered.text : null;
    const members = group && group.blocks.length > 1 ? group.blocks : null;
    const expanded = !!members && ui.expanded === group.key;
    return el("li", { class: "item", "data-index": String(i) }, [
      el("div", { class: "row" }, [
        el("span", { class: "mark", "aria-hidden": "true" }),
        b.live ? el("span", { class: "what", text: words }) : whatButton(b, words),
        b.live ? el("span", { class: "when", id: "countdown", "data-deadline": b.deadline, text: secondsLeft(b.deadline) + " s left" })
          : el("span", { class: "when", text: when(b.at) }),
      ]),
      meta ? el("span", { class: "meta", text: meta }) : null,
      !b.live && b.action_id && ui.details === b.action_id ? details(model, b) : null,
      answered ? el("span", { class: "done", text: answered }) : act,
      members ? el("div", {}, [el("button", { class: "btn text", type: "button", "data-key": "tries-" + group.key, "aria-expanded": expanded ? "true" : "false",
        text: (expanded ? "Hide each try" : "Show each try") + " (" + members.length + ")", onclick: () => { ui.expanded = expanded ? null : group.key; draw("tries-" + group.key); } })]) : null,
      expanded ? el("ul", { class: "tries-list", "aria-label": "Each try: " + words }, members.map((m) => tryItem(model, m, b))) : null,
    ]);
  }
  /** One try inside a group: when, where, and its own details. */
  function tryItem(model, b, head) {
    const id = b.action_id || "";
    const open = !!id && ui.details === id;
    const where = [b.tool, b.project, b.tries > 1 ? "×" + b.tries : null].filter(Boolean).join(" · ");
    return el("li", { class: "try" }, [
      el("div", { class: "row" }, [
        id ? el("button", { class: "link", type: "button", "data-key": "try-" + id, "aria-expanded": open ? "true" : "false", "aria-controls": "details-" + id,
          onclick: () => { ui.details = open ? null : id; draw("try-" + id); } }, [when(b.at)]) : el("span", { text: when(b.at) }),
        el("span", { class: "meta", text: [where, b.outcome_text !== head.outcome_text ? b.outcome_text : null].filter(Boolean).join(" · ") }),
      ]),
      open ? details(model, b) : null,
    ]);
  }

  /** The list's rows: the agent's groups (today's repeats of one action under one rule as one row), or each block alone from an
   *  older agent. Each with its blocks, newest first; the question waiting now is left out (it has its own row). */
  function groupsOf(s, model) {
    const blocks = model && model.recent_blocks || [];
    const skip = (b) => !b || (s.pending && b.action_id === s.pending.action_id);
    const given = model && Array.isArray(model.blocked_groups) ? model.blocked_groups : null;
    const groups = given
      ? given.map((g) => ({ key: String(g.key), times: Number(g.times) || 1, today: g.today === true, blocks: (g.members || []).map((i) => blocks[i]).filter((b) => !skip(b)) }))
      : blocks.filter((b) => !skip(b)).map((b, i) => ({ key: "one-" + i, times: b.tries > 1 ? b.tries : 1, today: isToday(b.at), blocks: [b] }));
    return groups.filter((g) => g.blocks.length);
  }

  function blockedList(s, model) {
    const groups = groupsOf(s, model);
    const live = pendingBlock(s);
    const out = [];
    if (live) out.push(el("h2", { id: "live-h", text: "Waiting for your answer" }), el("ul", { "aria-labelledby": "live-h" }, [blockItem(s, model, live, 0)]));
    if (!groups.length) return out.concat(live ? [] : [empty("Nothing blocked today", "Scopebond checks every action your coding agents take.")]);
    const today = groups.filter((g) => g.today);
    const earlier = groups.filter((g) => !g.today);
    // All of today, newest first, then earlier this week; PAGE rows at a time, with Show more.
    const todayShown = today.slice(0, ui.shown);
    const earlierShown = earlier.slice(0, Math.max(0, ui.shown - todayShown.length));
    const item = (g, i) => blockItem(s, model, g.blocks[0], i, g);
    if (!today.length) out.push(empty("Nothing blocked today", "Earlier blocks are below."));
    else out.push(el("h2", { id: "today-h", text: "Today" }), el("ul", { "aria-labelledby": "today-h" }, todayShown.map(item)));
    if (earlierShown.length) out.push(el("h2", { id: "earlier-h", text: "Earlier this week" }), el("ul", { "aria-labelledby": "earlier-h" }, earlierShown.map((g, i) => item(g, todayShown.length + i))));
    const left = groups.length - todayShown.length - earlierShown.length;
    if (left > 0) out.push(el("div", { class: "more" }, [el("button", { class: "btn", type: "button", "data-key": "more",
      text: "Show " + Math.min(PAGE, left) + " more", onclick: () => { ui.shown += PAGE; draw("more"); } })]));
    return out;
  }

  function ends(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const left = d.getTime() - Date.now();
    if (left < 36 * 3600000) return "Ends " + when(iso);
    return Math.round(left / 86400000) + " days left";
  }
  /** How long an allowance was made for, in the words the form uses (never "always"). */
  function lengthOf(a) {
    if (a.unblocked === "automatic") return "Unblocked automatically";
    const words = { once: "Once", fifteen: "For 15 minutes", hour: "For 1 hour", tomorrow: "Until tomorrow" }[a.choice];
    const days = Math.max(1, Math.round((Date.parse(a.ends_at) - Date.parse(a.created_at)) / 86400000));
    const length = words || (Number.isFinite(days) ? "For " + days + (days === 1 ? " day" : " days") : "");
    return a.by === "admin" ? ["Approved by " + (a.answered_by || "an admin"), length].filter(Boolean).join(" · ") : length;
  }
  function allowedList(model) {
    const all = model.allowed || [];
    const items = all.filter((a) => a.kind !== "quiet");
    const quiet = all.filter((a) => a.kind === "quiet");
    const out = [];
    if (!items.length) out.push(empty("Nothing allowed right now", "What you let through shows here until it ends."));
    else out.push(el("h2", { id: "allowed-h", text: "Allowed now" }), allowedItems(items));
    if (quiet.length) out.push(el("h2", { id: "quiet-h", text: "Kept blocked" }), el("p", { class: "note pad", text: "Blocked without asking you. Undo to be asked again." }), keptItems(quiet));
    return out;
  }
  /** What the person chose to keep blocked without being asked, each with Undo. */
  function keptItems(items) {
    return el("ul", { "aria-labelledby": "quiet-h" }, items.map((a) => {
      const what = a.what || underRule(a);
      return el("li", { class: "item" }, [
        el("div", { class: "row" }, [el("span", { class: "what", text: what }), el("span", { class: "chip", text: "Kept blocked" })]),
        el("span", { class: "meta", text: [ends(a.ends_at), a.what ? ruleOf(a) : null].filter(Boolean).join(" · ") }),
        a.by === "person" ? el("div", { class: "acts" }, [el("button", { class: "btn", type: "button", "data-key": "undo-" + a.id, "aria-label": "Undo: ask me again about " + what, text: "Undo",
          onclick: async () => { try { await invoke("panel_stop", { id: a.id }); } catch (_) { /* the note says why */ } setTimeout(refresh, 150); } })]) : null,
      ]);
    }));
  }
  function allowedItems(items) {
    return el("ul", { "aria-labelledby": "allowed-h" }, items.map((a) => {
      const how = lengthOf(a);
      const end = a.state === "proposed" ? "Waiting for an admin" : a.choice === "once" ? "Until it runs again" : ends(a.ends_at);
      const what = a.what || underRule(a);
      // "Stop allowing" for what the person let through, with a confirm in the row.
      const mine = a.by === "person" && (a.state === "active" || a.state === "proposed");
      const stop = !mine ? null : ui.stopping === a.id
        ? el("div", { class: "confirm", role: "group", "aria-label": "Stop allowing " + what }, [
          el("span", { class: "meta", text: "Stop allowing it? It stops at once, and your workspace is told." }),
          el("div", { class: "acts" }, [
            el("button", { class: "btn primary", type: "button", "data-key": "stop-yes-" + a.id, text: "Stop allowing",
              onclick: async () => { ui.stopping = null; try { await invoke("panel_stop", { id: a.id }); } catch (_) { /* the note says why */ } setTimeout(refresh, 150); } }),
            el("button", { class: "btn", type: "button", "data-key": "stop-no-" + a.id, text: "Keep", onclick: () => { ui.stopping = null; draw("stop-" + a.id); } }),
          ]),
        ])
        : el("div", { class: "acts" }, [el("button", { class: "btn", type: "button", "data-key": "stop-" + a.id, "aria-label": "Stop allowing " + what, text: "Stop allowing",
          onclick: () => { ui.stopping = a.id; draw("stop-yes-" + a.id); } })]);
      return el("li", { class: "item" }, [
        el("div", { class: "row" }, [
          el("span", { class: "what", text: what }),
          el("span", { class: "chip " + (a.state === "proposed" ? "wait" : "ok"), text: a.state === "proposed" ? "Waiting" : "Active" }),
        ]),
        el("span", { class: "meta", text: [how, end, a.what ? ruleOf(a) : null].filter(Boolean).join(" · ") }),
        stop,
      ]);
    }));
  }

  function list(s, model) {
    let body;
    if (ui.tab === "allowed") body = allowedList(model);
    else body = blockedList(s, model);
    return el("div", { class: "list", id: "list", role: "tabpanel", "aria-labelledby": "tab-" + ui.tab, tabindex: "-1" }, body);
  }

  // ---- Settings, one screen: the notification switch, Start with Windows, facts about this computer, and Get help.
  /** A setting that is on or off: the whole row is the switch's label, with a line under it saying what it does. */
  function switchRow(key, title, small, on, disabled, onchange) {
    return el("label", { class: "switch-row" + (disabled ? " off" : "") }, [
      el("span", { class: "grow" }, [el("span", { class: "title", text: title }), small ? el("small", { id: key + "-small", text: small }) : null]),
      el("input", { type: "checkbox", role: "switch", "data-key": key, checked: on, disabled, "aria-describedby": small ? key + "-small" : null, onchange }),
    ]);
  }
  /** One fact about this computer; a row with items (the packs in force) lists them when opened. */
  function computerRow(r) {
    const items = Array.isArray(r.items) ? r.items : [];
    return [
      el("dt", { text: r.label }),
      el("dd", {}, [r.value, items.length ? el("details", { class: "packs" }, [
        el("summary", { "data-key": "row-" + r.label, text: items.length === 1 ? "Show the pack" : "Show the " + items.length + " packs" }),
        el("ul", {}, items.map((i) => el("li", { text: i }))),
      ]) : null]),
    ];
  }
  function settings(s, model) {
    const answer = s.answer;
    // On unless the person turned it off; an older agent's "problems" (problems only, nobody's choice) reads as on.
    const on = !(answer && answer.settings && answer.settings.notifications === "off");
    const managed = s.autostart === "managed";
    const rows = model ? (Array.isArray(model.computer_rows) && model.computer_rows.length ? model.computer_rows : model.rows || []) : [];
    const version = model && model.version_label ? model.version_label : "Scopebond " + s.version;
    return el("div", { class: "settings", role: "region", "aria-label": "Settings" }, [
      el("div", {}, [el("button", { class: "btn text", type: "button", "data-key": "back", text: "← Back", onclick: () => { ui.view = "list"; draw("settings"); } })]),
      el("div", { class: "group" }, [
        switchRow("notify", "Tell me when something is blocked", "And when an admin answers your request. Alerts you must act on always show.", on, !model,
          () => run("command", "notifications:" + (on ? "off" : "blocks"))),
        switchRow("autostart", "Start with Windows", managed ? "Set for every user on this computer" : null, s.autostart !== "off", managed,
          () => run("command", "autostart")),
      ]),
      el("section", { "aria-labelledby": "computer-h" }, [
        el("h2", { id: "computer-h", text: "This computer" }),
        rows.length ? el("dl", { class: "rows" }, rows.flatMap((r) => computerRow(r))) : el("p", { class: "note", text: s.headline }),
        model && model.state === "protected" && model.hint ? el("p", { class: "note", text: model.hint }) : null,
        rows.some((r) => r.label === "Version") ? null : el("p", { class: "note", text: version }),
      ]),
      el("div", { class: "help" }, [
        el("button", { class: "btn", type: "button", "data-key": "help", "aria-describedby": "help-small", disabled: s.busy === "help", "aria-busy": s.busy === "help" ? "true" : null,
          text: "Get help…", onclick: () => run("command", "get_help") }),
        el("small", { id: "help-small", text: "Copies a support report (no keys, records or commands) and opens the Help page." }),
      ]),
    ]);
  }

  function footer(model) {
    const open = offered(model, "open_workspace");
    if (!open) return null;
    return el("footer", { class: "foot" }, [
      el("span", { class: "grow" }),
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
    if (ui.open && !(s.pending && s.pending.action_id === ui.open) && !(model && (model.recent_blocks || []).some((b) => b.action_id === ui.open && b.can_act && b.offers))) closeForm();
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
    if (!ready) { ready = true; invoke("panel_ready").catch(() => {}); }
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
    const live = pendingBlock(s);
    const target = s.openBlock && (live && live.action_id === s.openBlock ? live
      : s.answer && s.answer.tray && (s.answer.tray.recent_blocks || []).find((b) => b.action_id === s.openBlock && b.can_act && b.offers));
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
  // The waiting question's seconds left, without redrawing the panel.
  setInterval(() => {
    const c = document.getElementById("countdown");
    if (c) c.textContent = secondsLeft(c.getAttribute("data-deadline")) + " s left";
  }, 1000);
})();
