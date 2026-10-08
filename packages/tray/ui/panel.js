// The status panel. It draws what the tray holds from the agent's tray model (`panel_state`) and asks the tray to run
// the actions the model offers. Text from the agent is only ever set as text, never parsed as markup.
"use strict";

(function () {
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});
  const root = document.getElementById("panel");
  let lastJson = "";
  let lastAnnounced = "";

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key === "onclick") node.addEventListener("click", value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children || []) if (child) node.appendChild(child);
    return node;
  }

  function time(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  async function run(kind, value) {
    try {
      if (kind === "action") await invoke("panel_action", { id: value });
      else if (kind === "block") await invoke("panel_block", { actionId: value });
      else await invoke("panel_command", { id: value });
    } catch (_) { /* the next refresh shows the state */ }
    setTimeout(refresh, 150);
  }

  function render(s) {
    const answer = s.answer;
    const model = answer && answer.tray;
    const busy = s.busy;
    // Keep keyboard focus on the same control across redraws.
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;

    const header = el("header", { class: "head" }, [
      el("span", { class: "badge state-" + s.state, role: "img", "aria-label": s.stateLabel }),
      el("div", { class: "titles" }, [
        el("h1", { id: "headline", text: s.headline }),
        el("p", { class: "state", text: s.stateLabel }),
      ]),
      el("button", { class: "close", type: "button", "aria-label": "Close", "data-key": "close", text: "×", onclick: () => invoke("panel_close") }),
    ]);

    const parts = [header];
    // The status line: a polite live region, so a screen reader hears results and changes without losing its place.
    const announce = s.note || "";
    parts.push(el("p", { id: "status", class: "status" + (announce ? "" : " empty"), role: "status", "aria-live": "polite", text: announce }));

    if (model) {
      if (model.fix) {
        parts.push(el("div", { class: "fix" }, [
          el("button", {
            class: "primary", type: "button", "data-key": "fix", disabled: !!busy,
            "aria-busy": busy === model.fix.id ? "true" : null,
            text: busy === model.fix.id ? "Working…" : model.fix.label,
            onclick: () => run("action", model.fix.id),
          }),
        ]));
      }
      if (model.hint) parts.push(el("p", { class: "hint", text: model.hint }));
      if (model.rows && model.rows.length) {
        const dl = el("dl", { class: "rows" });
        for (const row of model.rows) {
          dl.appendChild(el("dt", { text: row.label }));
          dl.appendChild(el("dd", { text: row.value }));
        }
        parts.push(dl);
      }
      const others = (model.actions || []).filter((a) => !model.fix || a.id !== model.fix.id);
      if (others.length) {
        parts.push(el("div", { class: "actions", role: "group", "aria-label": "Actions" }, others.map((a) => el("button", {
          type: "button", "data-key": "action-" + a.id, disabled: !!busy, "aria-busy": busy === a.id ? "true" : null,
          text: busy === a.id ? "Working…" : a.label, onclick: () => run("action", a.id),
        }))));
      }
      const blocks = model.recent_blocks || [];
      if (blocks.length) {
        parts.push(el("section", { class: "blocks", "aria-labelledby": "blocks-title" }, [
          el("h2", { id: "blocks-title", text: "Recently blocked" }),
          el("ul", {}, blocks.map((b, i) => el("li", {}, [
            el("span", { class: "summary", text: b.summary }),
            el("span", { class: "when", text: time(b.at) + (b.rule ? " · " + b.rule : "") }),
            b.acted === "allowed" ? el("span", { class: "acted", text: "Allowed" })
              : b.acted === "asked" ? el("span", { class: "acted", text: "Asked an admin" })
              : b.can_act ? el("button", {
                type: "button", class: "link", "data-key": "block-" + i, disabled: !!busy,
                "aria-label": "Allow or ask about: " + b.summary, text: "Allow or ask…", onclick: () => run("block", b.action_id),
              }) : null,
          ]))),
        ]));
      }
    } else if (s.link === "not_answering" || s.link === "stopped") {
      parts.push(el("div", { class: "fix" }, [
        el("button", { class: "primary", type: "button", "data-key": "start", text: "Start the Scopebond Agent", onclick: () => run("command", "start_agent") }),
      ]));
    }

    parts.push(el("footer", {}, [
      el("button", { type: "button", class: "link", "data-key": "diagnostics", text: "Copy diagnostics", onclick: () => run("command", "copy_diagnostics") }),
      el("button", { type: "button", class: "link", "data-key": "logs", text: "Open logs folder", onclick: () => run("command", "open_logs") }),
      el("span", { class: "version", text: "Tray " + s.version }),
    ]));

    root.replaceChildren(...parts);
    root.setAttribute("aria-busy", busy ? "true" : "false");
    if (announce !== lastAnnounced) lastAnnounced = announce;
    const again = focused && root.querySelector('[data-key="' + focused + '"]');
    if (again && !again.disabled) again.focus();
  }

  async function refresh() {
    let s;
    try { s = await invoke("panel_state"); } catch (_) { return; }
    const json = JSON.stringify(s);
    if (json === lastJson) return;
    const first = lastJson === "";
    lastJson = json;
    render(s);
    if (first) {
      const start = root.querySelector(".primary") || root.querySelector("button:not(.close)") || root.querySelector("button");
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
