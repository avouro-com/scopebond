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

test("removing an install for every user leaves the removal for each person's next sign-in, as the system account", () => {
  const value = element(/<SetProperty Id="RegisterAllUsersCleanup"[^>]*\/>/);
  assert.match(value, /Value="&quot;\[INSTALLFOLDER\]scopebond-agent\.exe&quot; allusers-cleanup register &quot;\[ProgramFiles64Folder\]Scopebond Cleanup&quot;"/);
  const action = element(/<CustomAction Id="RegisterAllUsersCleanup"[^>]*\/>/);
  assert.match(action, /DllEntry="WixQuietExec"/);
  assert.match(action, /Execute="deferred"/);
  assert.match(action, /Impersonate="no"/, "the system account writes HKLM and Program Files");
  assert.match(action, /Return="ignore"/);
  const scheduled = element(/<Custom Action="RegisterAllUsersCleanup"[^>]*\/>/);
  assert.match(scheduled, /After="ReportUninstall"/, "after this account's own removal, and so before the files go");
  assert.match(scheduled, /Condition="REMOVE~=&quot;ALL&quot; AND NOT UPGRADINGPRODUCTCODE AND ROLLBACK &lt;&gt; &quot;1&quot; AND \?MachinePath = 3"/,
    "a removal of an install for every user, not an upgrade or the update helper's take-back");
});

test("installing for every user takes a waiting removal for each person away first", () => {
  const value = element(/<SetProperty Id="UnregisterAllUsersCleanup"[^>]*\/>/);
  assert.match(value, /allusers-cleanup unregister &quot;\[ProgramFiles64Folder\]Scopebond Cleanup&quot;"/);
  const action = element(/<CustomAction Id="UnregisterAllUsersCleanup"[^>]*\/>/);
  assert.match(action, /Impersonate="no"/);
  assert.match(action, /Return="ignore"/);
  const scheduled = element(/<Custom Action="UnregisterAllUsersCleanup"[^>]*\/>/);
  assert.match(scheduled, /After="InstallFiles"/, "the new agent is there to run");
  assert.match(scheduled, /Condition="NOT REMOVE AND ALLUSERS = &quot;1&quot;"/);
});
