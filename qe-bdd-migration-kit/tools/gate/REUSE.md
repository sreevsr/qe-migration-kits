# gate — REUSED from the TestNG kit via an additive --bdd flag (NOT forked)
Run the SAME gate, from the TestNG kit:

    node <qe-migration-kit>/tools/gate/parity_check_ast.mjs \
         --oracles <cuke-oracles.json> --generated <pw-project> --bdd

Why one gate: the only real difference is the UNIT in the generated TS —
  TestNG: test("...", async ({page}) => {...})
  BDD:    Then("...", async ({demoPage}, arg) => {...})
That is a one-line discovery change. Call following, assertion collection, must-pin scoring, shared
attribution and verdicts are identical. The oracles file is the SAME SCHEMA in both modes (the same
extractor emits it, via --entry-points). Forking would have duplicated the second-most-tuned
component in the kit.

## @source is REQUIRED and its format is exact
    // @source: FrameWindowSteps.validateNewTabUrl
    Then("New tab should open with URL {string}", async ({ demoPage }, expectedUrl: string) => {...});
It must equal the `id` in the oracles file. The gate matches `[\w.]+` — colons/spaces break it and
the step reports "no generated step definition (check @source tag)".

## Matcher hardening (done here because BDD forced it)
Java embeds the operation in the SUBJECT (`actualUrl.contains(x)`); TypeScript puts it in the
MATCHER (`expect(actualUrl).toContain(x)`). The original matcher compared subject/expected only, so
it dropped the operation on the TS side and reported a CORRECT translation as a lost must-pin —
a false BLOCK. Fix: fold the matcher name into the generated tokens, strip its "to" prefix, stem
trailing plurals (contains<->toContain, equals<->toEqual), plus a small explicit synonym map
(toHaveLength<->isEmpty/size, toHaveURL<->url, toBeVisible<->isDisplayed, ...).
Deliberately conservative: it only ADDS tokens. Regression-tested BOTH ways —
  correct translation      -> PASS 1/1
  oracle deliberately dropped -> still BLOCK "1 must-pin LOST"
A matcher permissive enough to pass everything would be worse than none.

## Unscoreable oracles (found by the agent on the FIRST real BDD agent run)
`Assert.assertEquals(actual, expected, "msg")` — Java's most common idiom — records the oracle as
subject="actual", expected="expected": the method's LOCAL VARIABLE NAMES. Both are stopwords, so the
signature set is EMPTY, the required overlap is >=1, and NO assertion can ever match. The gate
reported "must-pin LOST" against correct, live code AND flagged that same code as an
"over-assertion" — that double-count is the tell.

Fix: detect sig+literals both empty -> the oracle is UNSCOREABLE. Report it (NEEDS-HUMAN, "verify by
eye"), never count it as lost, and keep it out of the must-pin denominator. Rejected alternative:
un-stopping actual/expected, which would loosen matching in EVERY suite and risk masking real losses.

Why this mattered more than the BLOCK itself: an agent facing an unsatisfiable gate CONTORTS correct
code to appease it. SauceDemo's run did exactly that (it inlined `expectedItemTotal + tax` to dodge
this same stopword behaviour). A broken gate corrupts the deliverable, not just the report.

Regression-tested both ways after the fix: correct translation PASS 2/2; oracle deliberately dropped
-> still BLOCK "1 must-pin LOST"; the unscoreable one reported separately in both.
