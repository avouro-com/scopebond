---
"@scopebond/gateway": minor
"@scopebond/hook": minor
"@scopebond/agent": minor
---

Send summaries instead of every routine receipt when the workspace asks for it. The workspace names its evidence detail on
each rules check (`x-scopebond-evidence-detail: full | standard`); the hook keeps it beside the local retention. With
*standard*, the exporter sends notable receipts in full at once and the routine ones of each closed five-minute window as one
signed summary (`POST /v1/summaries`, with the queue's record numbers it stands for beside it, so the workspace's gap check
stays exact). Each window is summarised once per queue (a claim in the outbox), so a window's summary covers exactly its
routine receipts that were not sent in full; a record that turns up for a window already summarised is sent in full. A
workspace without summaries (404, 405) or that refuses one (400, 413, 422) is sent every receipt, as before.

Also: enqueueing never starts a flush while summaries are on, and a hook call's flush runs only when the call recorded
something notable (`flush({ routine: false })`); the agent's cycle and `scopebond-hook flush` send the summaries. New:
`CloudSummaryOptions`, `seqRanges`, outbox `claimWindow`/`releaseWindow`; hook `evidenceDetail`, `evidenceDetailFrom`,
`summaryOptions`. A 1,000-action session over 20 minutes ships 4 summaries and its 5 pushes.

Review fixes before release: a window's claim is a lease, so a window another process is sending waits instead of also going
in full, and a claim a process abandoned is taken over under the same summary id; records leave the queue only for the
summaries the workspace says it has (a summary it refused sends its records in full; a short answer is retried under the
same ids); a summary's `notable_count` counts the window's records sent in full, kept in the outbox; notable records go
before summaries; a computer without the agent sends summaries from a hook call once routine records have waited 30 minutes.
