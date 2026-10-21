// The Scopebond window: asks the person at the computer whether to allow one action a workspace rule blocks, with a reason.
// It is shown by this resident agent with the operating system's own tools (Windows PowerShell with Windows Forms, macOS
// osascript, Linux zenity), never by the coding agent, and the answer comes only from the window. Text reaches each tool as
// data (base64 for PowerShell, arguments for osascript and zenity), never spliced into code.

import { spawn } from "node:child_process";
import { windowsSystemProgram } from "@scopebond/gateway/node";
import { userInfo } from "node:os";

export interface OverrideQuestion {
  action_id: string;
  rule: string;
  title: string;
  summary: string;
  reason_min: number;
  lasts: string;
  timeout_ms: number;
  /** Override = "Block, person may allow"; ask = "Block, person may ask" (only Ask an admin). */
  mode: "override" | "ask";
  /** Which choices the workspace allows: allow (once), fifteen (for 15 minutes, older terms), hour, tomorrow (24 hours),
   *  always (an allowance for `always_days`, 30 days), ask (Ask an admin), and quiet (keep it blocked without being asked
   *  again). The newer three only from a hook that sends them. */
  offers: { allow: boolean; always: boolean; ask: boolean; fifteen?: boolean; hour?: boolean; tomorrow?: boolean; quiet?: boolean };
  /** The coding tool that asked (the tray names it), when the hook says. */
  harness?: string;
  /** The project (the repository's name), when the hook says. */
  project?: string;
  /** Every unblock is reviewed by an admin later (the workspace's `review` term). */
  reviewed?: boolean;
  /** Days an "always" allowance lasts, and whether it waits for an admin. */
  always_days?: number;
  always_needs_admin?: boolean;
}
/** `later` (with "unavailable"): the agent runs but asked no one now (no tray listening, no window); the person acts on the
 *  block afterwards. `link`: this computer's page in the workspace, when known. */
export interface OverrideAnswer {
  /** `quiet`: keep it blocked and do not ask again (a newer hook only offers it). */
  decision: "allow" | "deny" | "unavailable" | "ask" | "quiet"; reason?: string; os_user?: string; lasts?: "once" | "15m" | "1h" | "tomorrow" | "always"; later?: true; link?: string;
}
export type Prompter = (question: OverrideQuestion) => Promise<OverrideAnswer>;

const ID = /^[A-Za-z0-9._:-]{16,200}$/;
// eslint-disable-next-line no-control-regex -- deliberately replaces control characters in text shown in the window
const clip = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "");

/** Check a request from the local channel. Anything malformed is refused before a window opens. */
export function parseQuestion(raw: unknown): OverrideQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.action_id !== "string" || !ID.test(r.action_id) || typeof r.rule !== "string" || !/^[a-z0-9-]{1,64}$/.test(r.rule)) return null;
  const reasonMin = Number(r.reason_min);
  const timeout = Number(r.timeout_ms);
  // 0: the workspace asks for no reason.
  if (!Number.isInteger(reasonMin) || reasonMin < 0 || reasonMin > 200) return null;
  const mode = r.mode === "ask" ? "ask" : "override";
  const o = (r.offers && typeof r.offers === "object" ? r.offers : {}) as Record<string, unknown>;
  // An older hook sends no offers: the window offers "Allow once", as it always did.
  const offers = r.offers === undefined ? { allow: true, always: false, ask: false }
    : { allow: mode === "override" && o.allow === true, always: mode === "override" && o.always === true, ask: o.ask === true,
        // A hook that does not say offers 15 minutes wherever it offers "always" (both came with allowances).
        fifteen: mode === "override" && (o.fifteen === true || (o.fifteen === undefined && o.always === true)),
        // A newer hook's lengths and quiet blocks, only when it sends them (an older one's question keeps its shape).
        ...(mode === "override" && o.hour === true ? { hour: true } : {}), ...(mode === "override" && o.tomorrow === true ? { tomorrow: true } : {}),
        ...(o.quiet === true ? { quiet: true } : {}) };
  const days = Number(r.always_days);
  return {
    action_id: r.action_id, rule: r.rule, title: clip(r.title, 120) || r.rule, summary: clip(r.summary, 200), reason_min: reasonMin,
    lasts: clip(r.lasts, 80) || "this action only", timeout_ms: Number.isFinite(timeout) ? Math.min(Math.max(timeout, 5_000), 55_000) : 45_000,
    mode, offers,
    ...(typeof r.harness === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(r.harness) ? { harness: r.harness } : {}),
    ...(typeof r.project === "string" && clip(r.project, 80) ? { project: clip(r.project, 80) } : {}),
    ...(r.reviewed === true ? { reviewed: true } : {}),
    ...(Number.isInteger(days) && days >= 1 && days <= 365 ? { always_days: days } : {}),
    ...(r.always_needs_admin === true ? { always_needs_admin: true } : {}),
  };
}

/** Whether the window lets the person allow it for any length (once, 15 minutes, 1 hour, until tomorrow, 30 days). */
const allowsAny = (q: OverrideQuestion): boolean => q.offers.allow || !!q.offers.fifteen || !!q.offers.hour || !!q.offers.tomorrow || q.offers.always;

export function questionText(q: OverrideQuestion): string {
  const why = q.reason_min > 0 ? `Say why, in at least ${q.reason_min} characters.` : "You may say why.";
  const head = `Scopebond blocked this. Your workspace's rule "${q.title}" blocked this action:\n\n${q.summary}\n\n`;
  if (!allowsAny(q)) return `${head}You may ask to unblock it; an admin decides. ${why} The action stays blocked until an admin answers; your name, the reason and the action are recorded in your workspace.`;
  return `${head}You may allow it. ${why} Your name, the reason and the action are recorded in your workspace.`;
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let child;
    try { child = spawn(command, args, { windowsHide: false, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve({ code: null, stdout: "" }); return; }
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, stdout }); }, timeoutMs + 3_000);
    child.stdout?.on("data", (d) => { stdout += d; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout: "" }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout }); });
  });
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The lengths the window offers, in the tray's words (Once · 15 minutes for older terms · 1 hour · Until tomorrow · 30 days;
 *  never "always"), each with the `lasts` the hook takes and the button that names the result. */
export function windowLengths(q: OverrideQuestion): Array<{ lasts: "once" | "15m" | "1h" | "tomorrow" | "always"; label: string; button: string; admin: boolean }> {
  const days = q.always_days ?? 30;
  const span = `${days} day${days === 1 ? "" : "s"}`;
  const admin = q.always_needs_admin === true;
  return [
    q.offers.allow ? { lasts: "once" as const, label: "Once", button: "Allow once", admin: false } : null,
    q.offers.fifteen ? { lasts: "15m" as const, label: "15 minutes", button: "Allow for 15 minutes", admin: false } : null,
    q.offers.hour ? { lasts: "1h" as const, label: "1 hour", button: "Allow for 1 hour", admin: false } : null,
    q.offers.tomorrow ? { lasts: "tomorrow" as const, label: "Until tomorrow", button: "Allow until tomorrow", admin: false } : null,
    q.offers.always ? { lasts: "always" as const, label: admin ? `${span} (needs admin approval)` : span, button: admin ? `Ask for ${span}` : `Allow for ${span}`, admin } : null,
  ].filter((l): l is NonNullable<typeof l> => l !== null);
}

/** Quick reasons, as in the tray's form; "Other…" is a note alone. */
const WINDOW_REASONS = ["My own files", "Test or build output", "Needed for this task", "Other…"];

/** Windows: a small topmost form from Windows' own signed PowerShell, with the tray's Unblock form in its layout: what to
 *  allow (just this command, as shown above), for how long, why (optional quick choices, a note for Other… or where the
 *  workspace asks for a reason), one button that names the result, Don't allow, and two links: Ask an admin instead and
 *  Keep blocking without asking me. Closes itself at the timeout. Every control that shows text has `UseMnemonic` off:
 *  Windows Forms otherwise reads "&" as a keyboard shortcut and hides it, so the person would read "2>1" for a command that
 *  runs "2>&1". */
export function windowsScript(q: OverrideQuestion): string {
  const lengths = windowLengths(q);
  const asking = lengths.length === 0;
  // Rows top to bottom: the question (with the command), what to allow, the lengths, the reasons, the note, the buttons and
  // the links. Each group of radio buttons sits in a panel of its own row, so the lengths and the reasons are two groups.
  let y = 132;
  const lines: string[] = [];
  if (!asking) {
    lines.push(`$lh = New-Object Windows.Forms.Label`, `$lh.UseMnemonic = $false`, `$lh.Text = (T '${b64("For how long")}')`, `$lh.SetBounds(12, ${y}, 616, 18)`, `$f.Controls.Add($lh)`);
    y += 20;
    lines.push(`$p = New-Object Windows.Forms.Panel`, `$p.SetBounds(12, ${y}, 616, 26)`, `$f.Controls.Add($p)`);
    let x = 0;
    lengths.forEach((l, i) => {
      const width = Math.min(280, 26 + l.label.length * 6);
      lines.push(`SbLen '${b64(l.label)}' '${l.lasts}' '${b64(l.button)}' ${x} ${width} $${i === 0}`);
      x += width + 6;
    });
    y += 32;
  }
  lines.push(`$wh = New-Object Windows.Forms.Label`, `$wh.UseMnemonic = $false`, `$wh.Text = (T '${b64(q.reason_min > 0 ? `Why (at least ${q.reason_min} characters)` : "Why (optional)")}')`,
    `$wh.SetBounds(12, ${y}, 616, 18)`, `$f.Controls.Add($wh)`);
  y += 20;
  lines.push(`$w = New-Object Windows.Forms.Panel`, `$w.SetBounds(12, ${y}, 616, 26)`, `$f.Controls.Add($w)`);
  let rx = 0;
  WINDOW_REASONS.forEach((r, i) => {
    const width = 26 + r.length * 6;
    lines.push(`SbWhy '${b64(r)}' $${i === WINDOW_REASONS.length - 1} ${rx} ${width}`);
    rx += width + 6;
  });
  y += 32;
  const noteY = y;
  y += 34;
  const buttonY = y;
  y += 40;
  const linkY = y;
  y += 28;
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function global:T($s) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
$global:min = ${q.reason_min}
# What the person chose so far; the controls' event handlers change it (a shared table, whatever scope a handler runs in).
$global:sb = @{ answer = 'deny'; mode = '${asking ? "ask" : "allow"}'; lasts = '${lengths[0]?.lasts ?? "once"}'; button = (T '${b64(lengths[0]?.button ?? "Send request")}'); why = ''; lens = @() }
$f = New-Object Windows.Forms.Form
$f.Text = 'Scopebond'
$f.TopMost = $true
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.ClientSize = New-Object Drawing.Size(640, ${y})
$l = New-Object Windows.Forms.Label
$l.UseMnemonic = $false
$l.Text = (T '${b64(questionText(q))}')
$l.SetBounds(12, 10, 616, 96)
$wa = New-Object Windows.Forms.Label
$wa.UseMnemonic = $false
$wa.Text = (T '${b64(asking ? "What to ask for: just this command" : "What to allow: just this command")}')
$wa.SetBounds(12, 108, 616, 18)
$r = New-Object Windows.Forms.TextBox
$r.SetBounds(12, ${noteY}, 616, 24)
$r.Enabled = ($global:min -gt 0)
$go = New-Object Windows.Forms.Button
$go.UseMnemonic = $false
$go.SetBounds(12, ${buttonY}, 240, 30)
$go.Add_Click({ $global:sb.answer = $global:sb.mode; $f.Close() })
$d = New-Object Windows.Forms.Button
$d.UseMnemonic = $false
$d.Text = (T '${b64("Don't allow")}')
$d.SetBounds(260, ${buttonY}, 120, 30)
$d.Add_Click({ $global:sb.answer = 'deny'; $f.Close() })
# The reason sent: the quick choice in words, with the note when there is one ("Other…" is the note alone).
function global:SbReason() {
  $note = $r.Text.Trim()
  if ($global:sb.why -and $note) { return $global:sb.why + ': ' + $note }
  if ($global:sb.why) { return $global:sb.why }
  return $note
}
# The one button names the result, and waits for a reason long enough where the workspace asks for one.
function global:SbUpdate() {
  $go.Text = $(if ($global:sb.mode -eq 'ask') { (T '${b64("Send request")}') } else { $global:sb.button })
  $go.Enabled = ((SbReason).Length -ge $global:min)
}
function global:SbLen($label, $lasts, $button, $x, $width, $first) {
  $b = New-Object Windows.Forms.RadioButton
  $b.UseMnemonic = $false
  $b.Text = (T $label)
  $b.Tag = @($lasts, (T $button))
  $b.SetBounds($x, 0, $width, 24)
  $b.Checked = $first
  $b.Add_CheckedChanged({ if ($this.Checked) { $global:sb.lasts = $this.Tag[0]; $global:sb.button = $this.Tag[1]; SbUpdate } })
  $p.Controls.Add($b)
  $global:sb.lens += $b
}
function global:SbWhy($label, $other, $x, $width) {
  $b = New-Object Windows.Forms.RadioButton
  $b.UseMnemonic = $false
  $b.Text = (T $label)
  $b.Tag = @($b.Text, $other)
  $b.SetBounds($x, 0, $width, 24)
  $b.Add_CheckedChanged({ if ($this.Checked) { $global:sb.why = $(if ($this.Tag[1]) { '' } else { $this.Tag[0] }); $r.Enabled = ($this.Tag[1] -or $global:min -gt 0); SbUpdate } })
  $w.Controls.Add($b)
}
${lines.join("\n")}
${q.offers.ask && !asking ? `$ask = New-Object Windows.Forms.LinkLabel
$ask.UseMnemonic = $false
$ask.Text = (T '${b64("Ask an admin instead")}')
$ask.SetBounds(12, ${linkY}, 240, 20)
$ask.Add_LinkClicked({
  $global:sb.mode = $(if ($global:sb.mode -eq 'ask') { 'allow' } else { 'ask' })
  $p.Visible = ($global:sb.mode -ne 'ask')
  $lh.Visible = $p.Visible
  $ask.Text = $(if ($global:sb.mode -eq 'ask') { (T '${b64("Unblock it myself instead")}') } else { (T '${b64("Ask an admin instead")}') })
  SbUpdate
})
$f.Controls.Add($ask)` : ""}
${q.offers.quiet ? `$quiet = New-Object Windows.Forms.LinkLabel
$quiet.UseMnemonic = $false
$quiet.Text = (T '${b64("Keep blocking without asking me")}')
$quiet.SetBounds(260, ${linkY}, 360, 20)
$quiet.Add_LinkClicked({ $global:sb.answer = 'quiet'; $f.Close() })
$f.Controls.Add($quiet)` : ""}
$r.Add_TextChanged({ SbUpdate })
$f.AcceptButton = $d
$f.CancelButton = $d
$f.Controls.AddRange(@($l, $wa, $r, $go, $d))
SbUpdate
$t = New-Object Windows.Forms.Timer
$t.Interval = ${q.timeout_ms}
$t.Add_Tick({ $t.Stop(); $global:sb.answer = 'deny'; $f.Close() })
$t.Start()
$f.Add_Shown({ $f.Activate(); $d.Focus() })
[void]$f.ShowDialog()
$answer = $global:sb.answer
$out = @{ decision = $answer; lasts = $global:sb.lasts; reason = $(if ($answer -eq 'allow' -or $answer -eq 'ask') { SbReason } else { '' }) }
[Console]::Out.Write((ConvertTo-Json $out -Compress))
`;
}

async function promptWindows(q: OverrideQuestion): Promise<OverrideAnswer> {
  const encoded = Buffer.from(windowsScript(q), "utf16le").toString("base64");
  const { code, stdout } = await run(windowsSystemProgram("powershell"), ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], q.timeout_ms);
  if (code !== 0) return { decision: "unavailable" };
  try {
    const parsed = JSON.parse(stdout.trim()) as { decision?: string; reason?: string; lasts?: string };
    // Only a length the window offered: anything else is no answer to allow.
    const length = windowLengths(q).find((l) => l.lasts === parsed.lasts);
    if (parsed.decision === "allow" && length) return { decision: "allow", reason: String(parsed.reason ?? ""), lasts: length.lasts };
    if (parsed.decision === "ask" && q.offers.ask) return { decision: "ask", reason: String(parsed.reason ?? "") };
    if (parsed.decision === "quiet" && q.offers.quiet) return { decision: "quiet" };
    return { decision: "deny" };
  } catch { return { decision: "unavailable" }; }
}

/** The one button a dialog with room for a single choice shows (macOS and Linux): allow once where that is offered, else
 *  the one length the workspace set, else ask to unblock. Null when nothing may be done. */
export function singleChoice(q: OverrideQuestion): { label: string; decision: "allow" | "ask"; lasts?: "once" | "15m" | "1h" | "tomorrow" | "always" } | null {
  const first = windowLengths(q)[0];
  if (first && !first.admin) return { label: first.button, decision: "allow", lasts: first.lasts };
  if (q.offers.ask) return { label: "Ask to unblock", decision: "ask" };
  if (first) return { label: first.button, decision: "allow", lasts: first.lasts };
  return null;
}

const MAC_SCRIPT = [
  "on run argv",
  "set q to item 1 of argv",
  "set secs to (item 2 of argv) as integer",
  "set r to display dialog q default answer \"\" with title \"Scopebond\" buttons {\"Don't allow\", \"Allow once\"} default button \"Don't allow\" cancel button \"Don't allow\" giving up after secs",
  "if gave up of r then return \"timeout\"",
  "return \"allow\" & linefeed & (text returned of r)",
  "end run",
];

async function promptMac(q: OverrideQuestion): Promise<OverrideAnswer> {
  // A macOS dialog here has one choice besides "Don't allow" (singleChoice).
  const one = singleChoice(q);
  if (!one) return { decision: "unavailable" };
  const label = one.label.replace(/"/g, "");
  const script = MAC_SCRIPT.map((line) => line.replace(/Allow once/g, label).replace('return "allow"', `return "${one.decision}"`));
  const args = script.flatMap((line) => ["-e", line]);
  const { code, stdout } = await run("osascript", [...args, questionText(q), String(Math.round(q.timeout_ms / 1000))], q.timeout_ms);
  if (code === null) return { decision: "unavailable" };
  if (code !== 0) return { decision: "deny" }; // "Don't allow" is the cancel button
  const [first, ...rest] = stdout.replace(/\r?\n$/, "").split("\n");
  if (first === "ask" && one.decision === "ask") return { decision: "ask", reason: rest.join("\n") };
  return first === "allow" && one.decision === "allow" ? { decision: "allow", reason: rest.join("\n"), lasts: one.lasts } : { decision: "deny" };
}

async function promptLinux(q: OverrideQuestion): Promise<OverrideAnswer> {
  const one = singleChoice(q);
  if (!one) return { decision: "unavailable" };
  const { code, stdout } = await run("zenity", [
    "--entry", "--title=Scopebond", `--text=${questionText(q)}`, `--ok-label=${one.label}`, "--cancel-label=Don't allow",
    `--timeout=${Math.round(q.timeout_ms / 1000)}`,
  ], q.timeout_ms);
  if (code === null) return { decision: "unavailable" };
  if (code === 0) return one.decision === "ask" ? { decision: "ask", reason: stdout.replace(/\r?\n$/, "") } : { decision: "allow", reason: stdout.replace(/\r?\n$/, ""), lasts: one.lasts };
  // 1: Don't allow; 5: timed out; anything else (no display, not installed): no window.
  return code === 1 || code === 5 ? { decision: "deny" } : { decision: "unavailable" };
}

/** The window for this operating system. A reason shorter than the workspace accepts is refused here as well. */
export const systemPrompter: Prompter = async (q) => {
  const answer = process.platform === "win32" ? await promptWindows(q) : process.platform === "darwin" ? await promptMac(q) : await promptLinux(q);
  if (answer.decision !== "allow" && answer.decision !== "ask" && answer.decision !== "quiet") return answer;
  const reason = answer.decision === "quiet" ? "" : (answer.reason ?? "").trim();
  if (answer.decision !== "quiet" && reason.length < q.reason_min) return { decision: "deny" };
  let os_user: string | undefined;
  try { os_user = userInfo().username; } catch { /* not known */ }
  return answer.decision === "quiet" ? { decision: "quiet", ...(os_user ? { os_user } : {}) } : { ...answer, reason: reason.slice(0, 500), ...(os_user ? { os_user } : {}) };
};

/** One window at a time: a second request waits for the first, and gives up as no answer if it would wait too long. */
export function serialized(prompter: Prompter): Prompter {
  let chain: Promise<unknown> = Promise.resolve();
  return (q) => {
    const queuedAt = Date.now();
    const next = chain.then(() => (Date.now() - queuedAt > q.timeout_ms ? { decision: "unavailable" as const } : prompter(q)));
    chain = next.catch(() => undefined);
    return next;
  };
}
