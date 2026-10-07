---
"@scopebond/policy-schema": minor
"@scopebond/hook": minor
---

A session's heartbeat is sent every five minutes instead of every minute, and says so (`interval_s: 300` in the heartbeat
observation; the schema allows 60–900). A workspace waits three intervals before calling a computer lost, so the five-minute
beat is not mistaken for a loss, and a busy workspace's computers send a fifth of the heartbeats they did. Heartbeats now
continue fifteen minutes after the last hook activity (it was ten), so an idle session still sends at least two.
