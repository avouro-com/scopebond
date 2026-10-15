// The live prompt in the tray. When the hook asks the agent during a coding session (`POST /override`) and a tray is
// listening, the agent publishes the question to it instead of opening the Scopebond window at once: the tray shows a
// notification and its panel's form, and the person answers there. If the person has not opened the question in the tray
// soon (a third of the hook's wait, ten seconds at most), the agent withdraws it and opens the Scopebond window for the time
// that is left, as it always did. With no tray listening (an npm install, a tray not running) nothing changes: the window
// opens at once. Either way the answer comes only from the person: the tray's form or the window.

import { toolName } from "./tray-model.js";
import type { OverrideAnswer, OverrideQuestion, Prompter } from "./prompt.js";

/** What the tray shows for a question waiting now. `offers` reads like a recent block's (once, fifteen, always, ask). */
export interface LiveQuestion {
  action_id: string;
  what: string;
  action_text: string;
  rule: string;
  rule_title: string;
  tool: string | null;
  project: string | null;
  reason_min: number;
  offers: { once: boolean; fifteen: boolean; always: boolean; always_days: number | null; always_needs_admin: boolean; ask: boolean; reviewed: boolean };
  /** When the hook stops waiting (RFC 3339). */
  deadline: string;
  /** The person opened it in the tray (so the window does not open). */
  opened: boolean;
}

export type LiveChoice = "once" | "fifteen" | "always" | "ask";

export interface LivePrompt {
  /** Ask the person: in the tray when one is listening, else (or when they do not open it in time) in the window. */
  prompter: Prompter;
  /** The tray's long wait: the question waiting now, at once if it is not the one the tray last saw (`seen`), else when it
   *  changes or `ms` pass. */
  wait(seen: string | null, ms: number): Promise<LiveQuestion | null>;
  /** The person opened the question in the tray: no window for it. */
  open(actionId: string): boolean;
  /** The person's answer from the tray's form, checked against the question. */
  answer(body: unknown, osUser?: string): { ok: true; choice: LiveChoice; reviewed: boolean; always_days: number } | { ok: false; outcome: "gone" | "invalid" | "not_offered" | "reason_short"; text: string };
  current(): LiveQuestion | null;
  close(): void;
}

/** How long the tray has to show that the person opened the question before the window opens instead. */
export const openWithinMs = (timeoutMs: number): number => Math.min(10_000, Math.round(timeoutMs / 3));
/** A tray counts as listening while it waits, and for this long after its last wait returned (it waits again at once). */
export const LISTENING_GRACE_MS = 5_000;

interface Pending {
  question: OverrideQuestion;
  published: LiveQuestion;
  resolve: (answer: OverrideAnswer) => void;
  timers: Array<ReturnType<typeof setTimeout>>;
}

export function livePrompt(options: { fallback: Prompter; now?: () => number; openWithin?: (timeoutMs: number) => number; minWindowMs?: number }): LivePrompt {
  const openBy = options.openWithin ?? openWithinMs;
  const minWindow = options.minWindowMs ?? 5_000;
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
    const allowing = q.offers.allow || !!q.offers.fifteen || q.offers.always;
    return {
      action_id: q.action_id, what: q.summary, action_text: q.summary, rule: q.rule, rule_title: q.title,
      tool: toolName(q.harness ?? null), project: q.project ?? null, reason_min: q.reason_min,
      offers: {
        once: q.offers.allow, fifteen: !!q.offers.fifteen, always: q.offers.always,
        always_days: q.offers.always ? q.always_days ?? 30 : null, always_needs_admin: q.offers.always && !!q.always_needs_admin,
        ask: q.offers.ask, reviewed: allowing && !!q.reviewed,
      },
      deadline: new Date(deadline).toISOString(), opened: false,
    };
  };

  const prompter: Prompter = async (q) => {
    if (!listening()) return options.fallback(q);
    const start = now();
    const deadline = start + q.timeout_ms;
    return new Promise<OverrideAnswer>((resolve) => {
      const p: Pending = { question: q, published: publish(q, deadline), resolve, timers: [] };
      pending = p;
      changed();
      // Not opened in the tray in time: the window, for the time that is left.
      p.timers.push(setTimeout(() => {
        if (pending !== p || p.published.opened) return;
        pending = null;
        changed();
        const left = deadline - now();
        if (left < minWindow) { finish(p, { decision: "deny" }); return; }
        options.fallback({ ...q, timeout_ms: left }).then((answer) => finish(p, answer), () => finish(p, { decision: "unavailable" }));
      }, openBy(q.timeout_ms)));
      // Opened but not answered: as the window does at its timeout, nothing is allowed.
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
      const choice = r.choice;
      if (choice !== "once" && choice !== "fifteen" && choice !== "always" && choice !== "ask") return { ok: false, outcome: "invalid", text: "That answer could not be read." };
      if (!p.published.offers[choice]) return { ok: false, outcome: "not_offered", text: "Your workspace does not offer that choice for this action." };
      const reason = typeof r.reason === "string" ? r.reason.trim() : "";
      if (reason.length > 500 || [...reason].some((c) => { const n = c.charCodeAt(0); return (n < 32 && n !== 10 && n !== 13) || n === 127; })) return { ok: false, outcome: "invalid", text: "That answer could not be read." };
      if (reason.length < p.question.reason_min) return { ok: false, outcome: "reason_short", text: `Say why in at least ${p.question.reason_min} characters.` };
      const user = osUser ? { os_user: osUser } : {};
      finish(p, choice === "ask" ? { decision: "ask", reason, ...user }
        : { decision: "allow", reason, lasts: choice === "fifteen" ? "15m" : choice === "always" ? "always" : "once", ...user });
      return { ok: true, choice, reviewed: p.published.offers.reviewed, always_days: p.published.offers.always_days ?? 30 };
    },
    close() {
      closed = true;
      if (pending) finish(pending, { decision: "unavailable" });
      changed();
    },
  };
}
