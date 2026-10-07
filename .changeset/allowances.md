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

Review fixes before release: the floor check keeps a rule a person may only ask about blocking when another rule on the same
action lets a person allow; the agent re-reads its files before writing, so an allowance or request the hook wrote during a
send is kept; allowances and requests are signed over `scopebond:allowance/v1` and `scopebond:request/v1` domain lines;
"Allow for 15 min" is offered only where the workspace sends the allowance terms; an older agent's "Allow once" on an
ask-only rule becomes a request to an admin.
