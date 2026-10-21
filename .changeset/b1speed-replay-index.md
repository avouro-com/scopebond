---
"@scopebond/gateway": patch
"@scopebond/hook": patch
---

The replay check on each decision is now one indexed lookup, so deciding an action takes the same few milliseconds however many receipts the local log holds.

- gateway: the SQLite receipt store keeps an index of the request and approval ids its receipts name, written with each receipt in the same transaction (also by an older version sharing the file). A store made before the index still reads its recent receipts for the replay check until the index covers the replay window, and upkeep removes index rows after the seven days finished authority records are kept. An id the index holds is always refused.
- hook: a new test decides 200 tool calls against a log of 20,000 receipts (50,000 with `SCOPEBOND_BENCH=1`) and requires a 95th-percentile decision time under 10 ms.
