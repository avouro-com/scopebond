---
"@scopebond/policy-schema": patch
"@scopebond/verify": patch
"@scopebond/hook": patch
---

Bound the time pattern checks and the hook's deadline can take, whatever value an agent chooses.

- One pattern check for policies and rule packs (`@scopebond/policy-schema/pattern`). A pattern is refused when its shape
  can backtrack catastrophically: a repeat that holds a repeat (unless each inner repeat is closed by a separator it cannot
  match, as in `(?:[a-z0-9-]+\.)*` or `(?:[^/]+/)*`, which splits an input one way only), a repeat whose body can match
  nothing, alternatives under a repeat that can begin with the same character (`(a|ab)*`), unbounded repeats next to each other that share characters
  (`.*.*`), three or more overlapping unbounded repeats in a row (`.*a.*a.*a`), more than eight places that can match the
  same input two ways (`a?a?a?…aaa`), back-references and look-behind. Rule packs already refused nested repeats and
  back-references; they now get the rest too.
- Policies: `validatePolicy()` now applies that check to every `param_bounds` and `exceptions` pattern (up to 16 KiB each), so
  a policy with such a pattern is invalid and `violates()` fails closed on it, exactly as for a pattern that does not parse.
  Every pattern the starter protections and the shipped rule packs use is accepted unchanged. A param value longer than
  4,096 characters fails a pattern without being tested (a bound is not met; an exception does not apply).
- Endpoint `paths` and `protected_refs` globs are matched in time linear in the value, without a regular expression, with
  the same meaning as before (`*` within a segment, `**` across segments).
- The hook's decision deadline now also holds when the hook's main thread is stuck in synchronous work (a runaway loop or a
  backtracking regular expression), where a timer cannot fire: a watchdog thread interrupts it through Node's in-process
  inspector and the hook denies in the coding tool's own format at the deadline, instead of being left to time out and run
  the action unchecked.
- A workspace's rules that would compile to a pattern the check refuses are refused as a whole before anything is written
  (the rules in force stay), and `status` names the rule, the field and the reason. Every pattern the hook builds itself
  (starter and always-on rules, your own lists, a workspace's lists, exclusions, exceptions, allowed sites with wildcards,
  blocked services and rule-pack clauses) passes the check; a name exception written with stars next to each other
  (`a**`) is now compiled as one wildcard.

Upgrading: a policy file you wrote by hand that contains a pattern of one of these shapes is now invalid, and the hook
denies every call until it is rewritten (the error names the clause, the field and the reason). Patterns of the shapes the
hook builds itself, and every shipped rule, are unaffected. Run `scopebond-hook test "git status"` after upgrading: it reports an invalid policy file and why.
