// Loaded with `node --import` ahead of the hook (hook-watchdog.test.mjs): when the hook reads an event that carries the
// marker below, the main thread stalls in synchronous work and never returns, as a catastrophic regular expression or a
// runaway loop would. `SCOPEBOND_TEST_STALL` picks the stall: `loop` (a loop that never ends) or `regex` (exponential
// backtracking, longer than any test runs).
const MARKER = "scopebond-test-stall-main-thread";
const parse = JSON.parse;
JSON.parse = function stallingParse(text, ...rest) {
  if (typeof text === "string" && text.includes(MARKER)) {
    if (process.env.SCOPEBOND_TEST_STALL === "regex") {
      // Deliberately catastrophic: this is the stall under test.
      /^(a|a)*$/.test("a".repeat(60) + "b");
    }
    for (;;) { /* never returns */ }
  }
  return parse.call(this, text, ...rest);
};
