---
"@scopebond/policy-schema": minor
"@scopebond/gateway": minor
"@scopebond/hook": minor
"@scopebond/agent": minor
---

People may allow blocked actions for a while, or ask an admin. In the Scopebond window a person may choose **Allow once**,
**Allow for 15 min**, **Always allow this here…** or **Ask an admin**, as the workspace allows. "For 15 min" and "always"
leave a standing *allowance* for the same action (the same type and parameters, whatever tool call it comes from): it is
bound to one rule, expires (30 days by default), and never applies to Scopebond's own protection. A new rule mode, *Block,
person may ask*, offers only **Ask an admin**: the action stays blocked and the request goes to the workspace, which answers
with an allowance on the next rules check. The agent sends a person's allowances and requests to the workspace once, signed
by the computer's enrolled key.

The receipt of an action an allowance lets through carries `override.method: "allowance"`, with `repeat_of` naming the
allowance and `reason_digest` the reason it was made with (receipt schema and `validateOverrideRecord`). The hook reports
`x-scopebond-hook-capabilities: allowances` on its rules check, so a workspace sends the new mode and terms only to hooks that
understand them.

Also: the action key that recognises "the same action" leaves out the tool call's group size and position, so an earlier
override's repeat window applies to the same command in any call.
