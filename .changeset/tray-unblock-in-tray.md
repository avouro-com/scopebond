---
"@scopebond/hook": minor
"@scopebond/agent": minor
---

The tray answers earlier blocks itself and lists what was allowed and asked.

- `POST /blocked/answer` (`{ action_id, choice, reason }`, `choice` one of `once`, `fifteen`, `always`, `ask`) answers an earlier block from the tray's own form. The agent checks it as the Scopebond window would (the block is still offered, the workspace offers that choice now, the reason is long enough and at most 500 characters) and applies it exactly as the window's answer: the allowance or the request on this computer, sent to the workspace signed by this computer's key. It answers with the outcome and the words the tray shows ("Allowed once · Recorded and sent to Acme"; for a request, "Request sent · you'll see the answer under Requests").
- `GET /allowances` lists the allowances that still apply and those waiting for an admin (what, the rule's name, once / fifteen / always, who made it, when it ends); `GET /requests` lists the requests to an admin (waiting, approved or declined, who answered and their note when the workspace sends them). `GET /tray` carries both as `allowed` and `asked`.
- Notifications: a new setting value, `blocks` (blocks and problems), is the default on an agent's first start in a new Scopebond folder; an install whose person never chose keeps `problems`, and an older `all` reads as `blocks`. The PowerShell tray offers *Blocks and problems*, *Problems only* and *Off*.
- A workspace may set the one length a person's unblock lasts (the rule's `lasts`: `once`, `15m` or `always`) and say that every unblock is reviewed by an admin later (`review`). The window and the tray then offer only that length; an answer for another length allows nothing. The hook reports the `unblock_terms` capability, and a workspace sends these terms only then. The hook exports `offersFor`, `allowsAny` and `offeredLength`; `blockedQuestion` adds `reviewed`, and the tray model's `offers` add `reviewed` ("Unblocked until 4:07 PM · an admin will review it").
- The hook remembers, on this computer only, the text the Scopebond window showed for each action a person allows (`action-text.json`, the newest 500; `readActionText`, `rememberActionText`), so the tray can say what an allowance lets through. It is never sent.
