---
"@scopebond/policy-schema": minor
"@scopebond/hook": minor
---

A session's heartbeat can be sent every five minutes instead of every minute, where the workspace says it reads the
interval (`x-scopebond-heartbeat-interval-s` on the rules check). Each such heartbeat says so (`interval_s: 300`; the schema
allows 60–900), and the workspace waits three intervals before calling a computer lost. A workspace that does not say gets
heartbeats every minute without `interval_s`, as before. Heartbeats continue fifteen minutes after the last hook activity
(it was ten), so an idle session still sends at least two.
