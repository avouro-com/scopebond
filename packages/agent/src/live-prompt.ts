// The live prompt in the tray. When the hook asks the agent during a coding session (`POST /override`) and a tray is
// listening, the agent publishes the question to it and never opens the Scopebond window for it: the tray shows a
// notification and its panel's form, and the person answers there for the hook's whole wait. One block is one question, in
// one place. With no tray listening (an npm install, a tray not running) the Scopebond window opens at once only where it
// may: on macOS and Linux, and on Windows only with SCOPEBOND_PROMPT_WINDOW=1 (the Windows Forms window is retired there and
// kept behind that setting for one release). Otherwise no one is asked now: the hook hears `later`, and its denial tells the
// person where to allow the block, or ask an admin, afterwards. The answer comes only from the person: the tray's form or
// the window.

import { toolName } from "./tray-model.js";
import type { OverrideAnswer, OverrideQuestion, Prompter } from "./prompt.js";

/** What the tray shows for a question waiting now. `offers` reads like a recent block's (once, fifteen, hour, tomorrow, always,
 *  ask). */
export interface LiveQuestion {
  action_id: string;
  what: string;
  action_text: string;
  rule: string;
  rule_title: string;
  tool: string | null;
  project: string | null;
  reason_min: number;
  offers: { once: boolean; fifteen: boolean; hour: boolean; tomorrow: boolean; quiet: boolean; always: boolean; always_days: number | null; always_needs_admin: boolean; ask: boolean; reviewed: boolean };
  /** When the hook stops waiting (RFC 3339). */
  deadline: string;
  /** The person opened it in the tray. */
  opened: boolean;
}

/** quiet: keep it blocked without asking again (a quiet block); always offered, and needs no reason. */
type LiveChoice = "once" | "fifteen" | "hour" | "tomorrow" | "always" | "ask" | "quiet";

export interface LivePrompt {
  /** Ask the person: in the tray when one is listening (only there), else in the window where it may open, else no one now. */
  prompter: Prompter;
  /** The tray's long wait: the question waiting now, at once if it is not the one the tray last saw (`seen`), else when it
   *  changes or `ms` pass. */
  wait(seen: string | null, ms: number): Promise<LiveQuestion | null>;
  /** The person opened the question in the tray. */
  open(actionId: string): boolean;
  /** The person's answer from the tray's form, checked against the question. */
  answer(body: unknown, osUser?: string): { ok: true; choice: LiveChoice; reviewed: boolean; always_days: number } | { ok: false; outcome: "gone" | "invalid" | "not_offered" | "reason_short"; text: string };
  current(): LiveQuestion | null;
  close(): void;
}

/** A tray counts as listening while it waits, and for this long after its last wait returned (it waits again at once). */
const LISTENING_GRACE_MS = 5_000;

/** Where the hook's question goes: `tray` when a tray is listening (for the hook's whole wait; no window ever opens beside
 *  it, so one block never asks twice), else `window` when the Scopebond window may open, else `none`: no one is asked now
 *  and the person acts on the block afterwards. */
export type PromptRoute = "tray" | "window" | "none";

/** Decide where to ask the person about one block. A listening tray always wins. */
export function promptRoute(input: { trayListening: boolean; windowAllowed: boolean }): PromptRoute {
  if (input.trayListening) return "tray";
  return input.windowAllowed ? "window" : "none";
}

/** Whether the Scopebond window may open when no tray listens. On Windows the Windows Forms window is retired (the signed
 *  install asks in its tray; a block is acted on afterwards from the Scopebond icon) unless `SCOPEBOND_PROMPT_WINDOW=1`
 *  opts back in, for one release. On macOS the menu-bar app asks while it runs (a listening tray always wins); the
 *  dialog is for when it does not, and Linux has no tray, so the dialog stays there. */
export function windowAllowed(platform: string = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  if (platform !== "win32") return true;
  return env.SCOPEBOND_PROMPT_WINDOW === "1";
}

interface Pending {
  question: OverrideQuestion;
  published: LiveQuestion;
  resolve: (answer: OverrideAnswer) => void;
  timers: Array<ReturnType<typeof setTimeout>>;
}

/** `window`: whether the Scopebond window may open now (default `windowAllowed()`). `link`: this computer's page in the
 *  workspace, for the hook's denial when no one is asked now. */
export function livePrompt(options: { fallback: Prompter; now?: () => number; window?: () => boolean; link?: () => string | null }): LivePrompt {
  const mayOpenWindow = options.window ?? (() => windowAllowed());
  const now = options.now ?? Date.now;
  let pending: Pending | null = null;
  let waiting = 0;
  let lastWaitAt = 0;
  let closed = false;
  const waiters = new Set<() => void>();
  const changed = () => { for (const wake of [...waiters]) wake(); };
  const listening = () => !closed && (waiting > 0 || now() - lastWaitAt < LISTENING_GRACE_MS);
  const finish = (p: Pending, answer: OverrideAnswer) => {
    for (const t of p.timers) clearTimeout(t);
    if (pending === p) { pending = null; changed(); }
    p.resolve(answer);
  };

  const publish = (q: OverrideQuestion, deadline: number): LiveQuestion => {
    const allowing = q.offers.allow || !!q.offers.fifteen || !!q.offers.hour || !!q.offers.tomorrow || q.offers.always;
    return {
      action_id: q.action_id, what: q.summary, action_text: q.summary, rule: q.rule, rule_title: q.title,
      tool: toolName(q.harness ?? null), project: q.project ?? null, reason_min: q.reason_min,
      offers: {
        once: q.offers.allow, fifteen: !!q.offers.fifteen, hour: !!q.offers.hour, tomorrow: !!q.offers.tomorrow, quiet: true, always: q.offers.always,
        always_days: q.offers.always ? q.always_days ?? 30 : null, always_needs_admin: q.offers.always && !!q.always_needs_admin,
        ask: q.offers.ask, reviewed: allowing && !!q.reviewed,
      },
      deadline: new Date(deadline).toISOString(), opened: false,
    };
  };

  const prompter: Prompter = async (q) => {
    const route = promptRoute({ trayListening: listening(), windowAllowed: mayOpenWindow() });
    if (route === "window") return options.fallback(q);
    if (route === "none") {
      let link: string | null = null;
      try { link = options.link?.() ?? null; } catch { /* no link */ }
      return { decision: "unavailable", later: true, ...(link ? { link } : {}) };
    }
    const start = now();
    const deadline = start + q.timeout_ms;
    return new Promise<OverrideAnswer>((resolve) => {
      const p: Pending = { question: q, published: publish(q, deadline), resolve, timers: [] };
      pending = p;
      changed();
      // Not answered in the tray by the hook's deadline: as the window does at its timeout, nothing is allowed.
      p.timers.push(setTimeout(() => { if (pending === p) finish(p, { decision: "deny" }); }, q.timeout_ms));
    });
  };

  return {
    prompter,
    current: () => (pending ? { ...pending.published } : null),
    async wait(seen, ms) {
      waiting += 1;
      try {
        const id = () => pending?.published.action_id ?? null;
        if (closed || id() !== seen) return pending ? { ...pending.published } : null;
        await new Promise<void>((resolve) => {
          const wake = () => { waiters.delete(wake); clearTimeout(timer); resolve(); };
          const timer = setTimeout(wake, Math.max(0, Math.min(ms, 25_000)));
          waiters.add(wake);
        });
        return pending ? { ...pending.published } : null;
      } finally { waiting -= 1; lastWaitAt = now(); }
    },
    open(actionId) {
      if (!pending || pending.published.action_id !== actionId) return false;
      pending.published.opened = true;
      return true;
    },
    answer(body, osUser) {
      const r = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const p = pending;
      if (!p || r.action_id !== p.published.action_id) return { ok: false, outcome: "gone", text: "This question was answered or is no longer waiting." };
      // Keeping it blocked may come as the choice or as the decision.
      const choice = r.choice ?? (r.decision === "quiet" ? "quiet" : undefined);
      const user = osUser ? { os_user: osUser } : {};
      if (choice === "quiet") {
        finish(p, { decision: "quiet", ...user });
        return { ok: true, choice, reviewed: p.published.offers.reviewed, always_days: p.published.offers.always_days ?? 30 };
      }
      if (choice !== "once" && choice !== "fifteen" && choice !== "hour" && choice !== "tomorrow" && choice !== "always" && choice !== "ask") return { ok: false, outcome: "invalid", text: "That answer could not be read." };
      if (!p.published.offers[choice]) return { ok: false, outcome: "not_offered", text: "Your workspace does not offer that choice for this action." };
      const reason = typeof r.reason === "string" ? r.reason.trim() : "";
      if (reason.length > 500 || [...reason].some((c) => { const n = c.charCodeAt(0); return (n < 32 && n !== 10 && n !== 13) || n === 127; })) return { ok: false, outcome: "invalid", text: "That answer could not be read." };
      if (reason.length < p.question.reason_min) return { ok: false, outcome: "reason_short", text: `Say why in at least ${p.question.reason_min} characters.` };
      finish(p, choice === "ask" ? { decision: "ask", reason, ...user }
        : { decision: "allow", reason, lasts: choice === "fifteen" ? "15m" : choice === "hour" ? "1h" : choice === "tomorrow" ? "tomorrow" : choice === "always" ? "always" : "once", ...user });
      return { ok: true, choice, reviewed: p.published.offers.reviewed, always_days: p.published.offers.always_days ?? 30 };
    },
    close() {
      closed = true;
      if (pending) finish(pending, { decision: "unavailable" });
      changed();
    },
  };
}
