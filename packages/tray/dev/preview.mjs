// Review the tray's status panel in a browser, with no Rust toolchain and no tray: this writes two pages into dev/dist/
// (ignored by git) and prints the address to open.
//
//   node packages/tray/dev/preview.mjs
//
// dist/panel-frame.html is the panel's own page exactly as build.rs writes it (read from build.rs), with the shipped
// ui/panel.css and ui/panel.js and one more script before them: fake-tauri.js, a stand-in for the tray's
// `window.__TAURI__.core.invoke` answering `panel_state` with made-up scenes. dist/preview.html shows every scene in a
// frame the panel's size, light and dark. Nothing under dev/ is built into the program (build.rs copies only the two
// files in ui/).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");

// The page the panel loads, from build.rs (a Rust string literal: only \n and \" escapes are used in it).
const build = readFileSync(join(here, "..", "build.rs"), "utf8");
const literal = /const PAGE: &str = "((?:[^"\\]|\\.)*)";/.exec(build);
if (!literal) throw new Error("build.rs has no PAGE constant");
const page = literal[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
const frame = page
  .replace('href="panel.css"', 'href="../../ui/panel.css"')
  .replace('<script src="panel.js" defer></script>', '<script src="../fake-tauri.js"></script>\n<script src="../../ui/panel.js" defer></script>');
if (!frame.includes("fake-tauri.js") || !frame.includes("../../ui/panel.css")) throw new Error("the panel's page in build.rs changed shape; update dev/preview.mjs");

const SCENES = [
  ["protected", "A normal day: blocked first"],
  ["protected&open=act-read-env-0000000001&reason=Integration%20tests%20need%20the%20prod%20API%20URL", "Unblock in the panel"],
  ["protected&open=act-read-env-0000000001&choice=fifteen&reason=Integration%20tests%20need%20the%20prod%20API%20URL&submit=1", "After Unblock"],
  ["protected&open=act-push-main-00000001", "Ask to unblock"],
  ["protected&toast=act-read-env-0000000001", "From a notification's Unblock…"],
  ["protected&mode=approval", "An admin decides (ask to unblock)"],
  ["protected&mode=approval&open=act-read-env-0000000001&reason=Integration%20tests%20need%20the%20prod%20API%20URL", "An admin decides: the request"],
  ["protected&mode=approval&open=act-read-env-0000000001&reason=Integration%20tests%20need%20the%20prod%20API%20URL&submit=1", "An admin decides: request sent"],
  ["protected&mode=automatic", "Unblocked at once, reviewed later"],
  ["protected&mode=automatic&open=act-read-env-0000000001&reason=Integration%20tests%20need%20the%20prod%20API%20URL", "Reviewed later: the form"],
  ["protected&mode=automatic&open=act-read-env-0000000001&reason=Integration%20tests%20need%20the%20prod%20API%20URL&submit=1", "Reviewed later: unblocked"],
  ["protected&mode=final", "Blocks are final"],
  ["protected&live=1", "A question waiting now (live)"],
  ["protected&live=1&open=act-live-000000000001&reason=Release%20hotfix%20needs%20the%20rewritten%20tag", "A question waiting now: the form"],
  ["protected&mode=approval&live=1&open=act-live-000000000001", "A question waiting now: ask to unblock"],
  ["protected&tab=allowed&stop=alw_staging00000000000001", "Stop allowing: confirm"],
  ["protected&tab=allowed&stop=alw_staging00000000000001&confirm=1", "Stop allowing: stopped"],
  ["quiet", "Nothing blocked today"],
  ["protected&blocks=0", "0 blocks"],
  ["protected&blocks=3", "3 blocks"],
  ["protected&blocks=40", "40 blocks"],
  ["protected&blocks=200", "200 blocks over the week"],
  ["protected&outcomes=1", "Every outcome"],
  ["protected&groups=1", "One action tried in several sessions: one row"],
  ["protected&groups=1&expand=1", "Each try of a group"],
  ["protected&groups=1&details=act-rep-read-00000000", "A block's details"],
  ["protected&groups=1&older=1", "An older agent: no groups"],
  ["attention", "Something needs fixing"],
  ["disconnected", "Not connected"],
  ["not_answering", "The agent is not answering"],
  ["protected&tab=allowed", "Allowed"],
  ["protected&view=settings", "Settings"],
  ["protected&view=settings&packs=1", "Settings: the packs in force"],
  ["protected&view=settings&notify=off", "Settings: notifications off"],
  ["protected&view=settings&older=1", "Settings from an older agent"],
];

const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const figures = ["light", "dark"].flatMap((theme) => SCENES.map(([hash, title]) => `  <figure><figcaption>${escape(title)} (${theme})</figcaption>
    <iframe class="${theme}" title="${escape(title)}, ${theme}" src="panel-frame.html#scene=${escape(hash)}"></iframe></figure>`)).join("\n");

const preview = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scopebond tray panel preview</title>
<style>
  :root { color-scheme: light dark; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  body { margin: 0; padding: 24px 16px 48px; background: #e9edf4; color: #1f2b42; }
  @media (prefers-color-scheme: dark) { body { background: #0f1622; color: #e7ecf4; } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 0 0 16px; max-width: 70ch; }
  .grid { display: flex; flex-wrap: wrap; gap: 24px; }
  figure { margin: 0; display: grid; gap: 6px; }
  figcaption { font-size: 13px; font-weight: 600; }
  iframe { width: 360px; height: 560px; border: 0; border-radius: 8px; box-shadow: 0 12px 36px rgba(15, 23, 42, .25); }
  iframe.dark { color-scheme: dark; }
  iframe.light { color-scheme: light; }
</style>
</head>
<body>
<h1>Scopebond tray: status panel</h1>
<p>The panel as the tray draws it, from made-up models (dev/fake-tauri.js). Every button works against the stand-in;
nothing leaves this page. Each frame follows the colour scheme set on it. One scene alone:
panel-frame.html#scene=protected (add &amp;view=settings, &amp;tab=allowed or &amp;open=&lt;action id&gt;).</p>
<div class="grid">
${figures}
</div>
</body>
</html>
`;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "panel-frame.html"), frame);
writeFileSync(join(out, "preview.html"), preview);
console.log(`Open ${pathToFileURL(join(out, "preview.html")).href}`);
