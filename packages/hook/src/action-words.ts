// The action in words a person reads: the line the Scopebond window, the tray and the coding agent's denial show for an
// action. Built from the minimized intent only (never file contents or command output), with arguments the hook keeps only
// as a keyed digest left out and hidden characters written out, so what a person reads is what runs.

/** Control, bidi and zero-width characters: shown to a person, they can make a command read as a different one. */
// eslint-disable-next-line no-control-regex -- deliberate: these are the characters being found and written out
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

/** The text with each such character written out as ⟨U+XXXX⟩, so the summary a person (and an admin) reads is what runs. */
export function revealHidden(text: string): string {
  return text.replace(HIDDEN, (ch) => `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

/** One line a person can judge at a glance, from the minimized intent: never file contents or command output. */
export function actionSummary(intent: { action_type?: string; params?: Record<string, unknown> }): string {
  const p = intent.params ?? {};
  const pick = (k: string) => (typeof p[k] === "string" ? String(p[k]) : "");
  const text = intent.action_type === "shell.exec" ? pick("command") || pick("program")
    : intent.action_type === "git.push" ? `git push ${pick("remote")} ${pick("ref")}`.trim()
    : intent.action_type === "net.fetch" ? pick("url") || pick("host")
    : pick("path") || intent.action_type || "an action";
  // Arguments the hook keeps only as a keyed digest stay out of the window.
  const shown = revealHidden(text.slice(0, 2000).replace(/ ?\(hmac-sha256:[0-9a-f]{64}\)/g, "").trim());
  return shown.length > 200 ? `${shown.slice(0, 197)}...` : shown;
}

/** The action in plain words for the tray: the same masked text the Scopebond window shows (`actionSummary`), with a verb
 *  where the text alone is a path or an address ("Read .env.production", "Edit .github/workflows/release.yml", "git push
 *  --force origin main"). A command stays the command. Never file contents, command output or arguments the hook keeps
 *  only as a digest. */
export function plainAction(intent: { action_type?: string; params?: Record<string, unknown> }): string {
  const p = intent.params ?? {};
  const pick = (k: string) => (typeof p[k] === "string" ? String(p[k]).trim() : "");
  const type = intent.action_type ?? "";
  const verb = (word: string, text: string) => (text ? `${word} ${text}` : "");
  const text = type === "file.read" ? verb("Read", pick("path"))
    : type === "file.write" ? verb("Edit", pick("path"))
    : type === "git.push" ? `git push${p.force === true ? " --force" : ""} ${pick("remote")} ${pick("ref")}`.replace(/\s+/g, " ").trim()
    : type === "net.fetch" ? verb("Reach", pick("url") || pick("host"))
    : type === "mcp.tool.call" ? verb("Use", [pick("server"), pick("tool")].filter(Boolean).join(": "))
    : type === "package.install" ? verb("Install", pick("package_key") || `${pick("manager")} ${pick("name")}`.trim())
    : type === "software.install" ? verb("Install", [pick("name") || pick("source_url") || pick("source_domain"), pick("source_domain") && pick("name") ? `from ${pick("source_domain")}` : ""].filter(Boolean).join(" "))
    : "";
  if (!text) return actionSummary(intent);
  // As the window shows it: digests left out, hidden characters written out, at most 200 characters.
  const shown = revealHidden(text.slice(0, 2000).replace(/ ?\(hmac-sha256:[0-9a-f]{64}\)/g, "").replace(/\s+/g, " ").trim());
  return shown.length > 200 ? `${shown.slice(0, 197)}...` : shown;
}
