// The installer's removal runs the agent's own `uninstall` (which tells the workspace and ends with the sentence about the
// Scopebond folder), as the person removing Scopebond, with its output in the installer's log, and never fails the removal
// on its exit code (75 when the workspace could not be told). Read from Package.wxs: building the MSI needs WiX, which runs
// only in CI (msi.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const wxs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "wix", "Package.wxs"), "utf8");
const element = (pattern) => { const found = wxs.match(pattern); assert.ok(found, `Package.wxs has ${pattern}`); return found[0]; };

test("removal runs `scopebond-agent.exe uninstall`, and `uninstall --purge` with PURGE=1", () => {
  const plain = element(/<SetProperty Id="ReportUninstall"[^>]*\/>/);
  assert.match(plain, /Value="&quot;\[INSTALLFOLDER\]scopebond-agent\.exe&quot; uninstall"/);
  assert.match(plain, /Condition="PURGE &lt;&gt; &quot;1&quot;"/);
  const purge = element(/<SetProperty Action="SetReportUninstallPurge"[^>]*\/>/);
  assert.match(purge, /Value="&quot;\[INSTALLFOLDER\]scopebond-agent\.exe&quot; uninstall --purge"/);
  assert.match(purge, /Condition="PURGE = &quot;1&quot;"/);
});

test("it runs as the person removing Scopebond, logs what it says, and its exit code never stops the removal", () => {
  const action = element(/<CustomAction Id="ReportUninstall"[^>]*\/>/);
  // WixQuietExec writes the command's output and exit code to the installer's log, with no window.
  assert.match(action, /DllEntry="WixQuietExec"/);
  assert.match(action, /Execute="deferred"/);
  assert.match(action, /Impersonate="yes"/);
  assert.match(action, /Return="ignore"/);
  const scheduled = element(/<Custom Action="ReportUninstall"[^>]*\/>/);
  assert.match(scheduled, /Before="RemoveFiles"/, "before the agent's files go");
  assert.match(scheduled, /Condition="REMOVE~=&quot;ALL&quot; AND NOT UPGRADINGPRODUCTCODE AND ROLLBACK &lt;&gt; &quot;1&quot;"/, "a removal, not an upgrade, and not the update helper taking back a version that did not start");
});
