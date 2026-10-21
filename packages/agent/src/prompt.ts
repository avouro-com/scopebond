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
  /** Which choices the workspace allows: allow (once), fifteen (for 15 minutes), always (an allowance), ask (Ask an admin). */
  offers: { allow: boolean; always: boolean; ask: boolean; fifteen?: boolean };
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
export interface OverrideAnswer { decision: "allow" | "deny" | "unavailable" | "ask"; reason?: string; os_user?: string; lasts?: "once" | "15m" | "always"; later?: true; link?: string }
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
  if (!Number.isInteger(reasonMin) || reasonMin < 10 || reasonMin > 200) return null;
  const mode = r.mode === "ask" ? "ask" : "override";
  const o = (r.offers && typeof r.offers === "object" ? r.offers : {}) as Record<string, unknown>;
  // An older hook sends no offers: the window offers "Allow once", as it always did.
  const offers = r.offers === undefined ? { allow: true, always: false, ask: false }
    : { allow: mode === "override" && o.allow === true, always: mode === "override" && o.always === true, ask: o.ask === true,
        // A hook that does not say offers 15 minutes wherever it offers "always" (both came with allowances).
        fifteen: mode === "override" && (o.fifteen === true || (o.fifteen === undefined && o.always === true)) };
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

/** Whether the window lets the person allow it for any length (once, 15 minutes, always). */
const allowsAny = (q: OverrideQuestion): boolean => q.offers.allow || !!q.offers.fifteen || q.offers.always;

export function questionText(q: OverrideQuestion): string {
  const head = `Scopebond blocked this. Your workspace's rule "${q.title}" blocked this action:\n\n${q.summary}\n\n`;
  if (!allowsAny(q)) return `${head}You may ask to unblock it; an admin decides. Say why, in at least ${q.reason_min} characters. The action stays blocked until an admin answers; your name, the reason and the action are recorded in your workspace.`;
  return `${head}You may allow it. Say why, in at least ${q.reason_min} characters. Your name, the reason and the action are recorded in your workspace.`;
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

/** Windows: a small topmost form from Windows' own signed PowerShell. Closes itself at the timeout. Every control that shows
 *  text has `UseMnemonic` off: Windows Forms otherwise reads "&" as a keyboard shortcut and hides it, so the person would
 *  read "2>1" for a command that runs "2>&1". */
export function windowsScript(q: OverrideQuestion): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function T($s) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
$min = ${q.reason_min}
$f = New-Object Windows.Forms.Form
$f.Text = 'Scopebond'
$f.TopMost = $true
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.ClientSize = New-Object Drawing.Size(640, 250)
$l = New-Object Windows.Forms.Label
$l.UseMnemonic = $false
$l.Text = (T '${b64(questionText(q))}')
$l.SetBounds(12, 10, 616, 130)
$r = New-Object Windows.Forms.TextBox
$r.SetBounds(12, 145, 616, 24)
$script:answer = 'deny'
$script:lasts = 'once'
$needReason = @()
$x = 628
function Btn($label, $width, $decision, $lasts, $needs) {
  $b = New-Object Windows.Forms.Button
  $b.UseMnemonic = $false
  $b.Text = (T $label)
  $script:x0 = $x - $width
  $b.SetBounds($x - $width, 200, $width, 30)
  $b.Add_Click({ $script:answer = $decision; $script:lasts = $lasts; $f.Close() }.GetNewClosure())
  if ($needs) { $b.Enabled = $false; $script:needReason += $b }
  $f.Controls.Add($b)
  $b
}
$d = Btn '${b64("Don't allow")}' 100 'deny' 'once' $false; $x -= 108
${q.offers.ask ? `[void](Btn '${b64("Ask to unblock")}' 110 'ask' 'once' $true); $x -= 118` : ""}
${q.offers.always ? `[void](Btn '${b64("Always allow this here…")}' 150 'allow' 'always' $true); $x -= 158` : ""}
${q.offers.fifteen ? `[void](Btn '${b64("Allow for 15 min")}' 120 'allow' '15m' $true); $x -= 128; ` : ""}${q.offers.allow ? `[void](Btn '${b64("Allow once")}' 92 'allow' 'once' $true)` : ""}
$r.Add_TextChanged({ foreach ($b in $script:needReason) { $b.Enabled = ($r.Text.Trim().Length -ge $min) } })
$f.AcceptButton = $d
$f.CancelButton = $d
$f.Controls.AddRange(@($l, $r))
$t = New-Object Windows.Forms.Timer
$t.Interval = ${q.timeout_ms}
$t.Add_Tick({ $t.Stop(); $f.Close() })
$t.Start()
$f.Add_Shown({ $f.Activate(); $r.Focus() })
[void]$f.ShowDialog()
$out = @{ decision = $script:answer; lasts = $script:lasts; reason = $(if ($script:answer -ne 'deny') { $r.Text.Trim() } else { '' }) }
[Console]::Out.Write((ConvertTo-Json $out -Compress))
`;
}

async function promptWindows(q: OverrideQuestion): Promise<OverrideAnswer> {
  const encoded = Buffer.from(windowsScript(q), "utf16le").toString("base64");
  const { code, stdout } = await run(windowsSystemProgram("powershell"), ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], q.timeout_ms);
  if (code !== 0) return { decision: "unavailable" };
  try {
    const parsed = JSON.parse(stdout.trim()) as { decision?: string; reason?: string; lasts?: string };
    const lasts = parsed.lasts === "15m" || parsed.lasts === "always" ? parsed.lasts : "once";
    if (parsed.decision === "allow" && (lasts === "once" ? q.offers.allow : lasts === "15m" ? q.offers.fifteen : q.offers.always)) return { decision: "allow", reason: String(parsed.reason ?? ""), lasts };
    if (parsed.decision === "ask" && q.offers.ask) return { decision: "ask", reason: String(parsed.reason ?? "") };
    return { decision: "deny" };
  } catch { return { decision: "unavailable" }; }
}

/** The one button a dialog with room for a single choice shows (macOS and Linux): allow once where that is offered, else
 *  the one length the workspace set, else ask to unblock. Null when nothing may be done. */
export function singleChoice(q: OverrideQuestion): { label: string; decision: "allow" | "ask"; lasts?: "once" | "15m" | "always" } | null {
  if (q.offers.allow) return { label: "Allow once", decision: "allow", lasts: "once" };
  if (q.offers.fifteen) return { label: "Allow for 15 min", decision: "allow", lasts: "15m" };
  if (q.offers.always) return { label: "Always allow", decision: "allow", lasts: "always" };
  if (q.offers.ask) return { label: "Ask to unblock", decision: "ask" };
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
  if (answer.decision !== "allow" && answer.decision !== "ask") return answer;
  const reason = (answer.reason ?? "").trim();
  if (reason.length < q.reason_min) return { decision: "deny" };
  let os_user: string | undefined;
  try { os_user = userInfo().username; } catch { /* not known */ }
  return { ...answer, reason: reason.slice(0, 500), ...(os_user ? { os_user } : {}) };
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
