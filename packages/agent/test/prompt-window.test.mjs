// The Scopebond window shows the action exactly as it will run. Windows Forms reads "&" in a label or a button as the mark of
// a keyboard shortcut and hides it, so "2>&1" read "2>1": every control that shows text turns that off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuestion, windowsScript } from "../dist/prompt.js";

const COMMAND = "rm -rf build 2>&1 | tee clean.log && echo a && b";
const question = (extra = {}) => parseQuestion({
  action_id: "act-0123456789abcdef", rule: "destructive-shell", title: "Delete & clean", summary: COMMAND, reason_min: 10,
  lasts: "this action only", timeout_ms: 45_000, mode: "override", offers: { allow: true, always: true, ask: true, fifteen: true }, ...extra,
});
/** Every text the script decodes from base64 (the T '…' calls). */
const texts = (script) => [...script.matchAll(/\(T '([A-Za-z0-9+/=]+)'\)|Btn '([A-Za-z0-9+/=]+)'/g)].map((m) => Buffer.from(m[1] ?? m[2], "base64").toString("utf8"));

test("the window shows a command with & exactly: 2>&1 and a && b, never 2>1", () => {
  const script = windowsScript(question());
  const shown = texts(script);
  const label = shown.find((t) => t.includes("rm -rf build"));
  assert.ok(label, "the question text is in the script");
  assert.ok(label.includes(COMMAND), "the command as it runs, not escaped or shortened");
  assert.ok(label.includes("2>&1") && label.includes("a && b"));
  assert.ok(label.includes('"Delete & clean"'), "the rule's title too");
  assert.ok(!label.includes("&&1"), "not doubled: the controls do not read & at all");
});

test("every label, button, check box and radio button in the window has UseMnemonic off", () => {
  for (const q of [question(), question({ mode: "ask", offers: { allow: false, always: false, ask: true } })]) {
    const script = windowsScript(q);
    const controls = [...script.matchAll(/\$(\w+) = New-Object Windows\.Forms\.(Label|Button|CheckBox|RadioButton)\b/g)];
    assert.ok(controls.some((m) => m[2] === "Label") && controls.some((m) => m[2] === "Button"), "the window has a label and buttons");
    for (const [, name, kind] of controls) {
      assert.ok(script.includes(`$${name}.UseMnemonic = $false`), `${kind} $${name} turns off "&" shortcuts`);
    }
  }
});
