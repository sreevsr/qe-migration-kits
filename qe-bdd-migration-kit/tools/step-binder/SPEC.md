# step-binder — SPEC (NEW, THE novel front-end, deterministic)
Input: the feature model + the suite's step-definition .java files.
Output: each Gherkin step annotated with its bound method + params, plus a list of UNBOUND steps.
How: parse every @Given/@When/@Then/@And/@But annotation -> its regex or cucumber-expression;
compile each to a matcher; for each Gherkin step, find the matching definition; extract capture
groups -> params. Resolve And/But by the surrounding Given/When/Then context.
Fail-safe: a step matching 0 defs -> UNBOUND (REVIEW). A step matching >1 -> AMBIGUOUS (flag, don't
guess). Never silently pick.
No LLM. The core deterministic piece everything hangs on. Tested standalone on saipradeepcs.

## Scenario Outline placeholder handling (fixed after first real-repo validation)
Cucumber substitutes the Examples row BEFORE matching a step to a definition. The binder does the
same: if the raw step text matches nothing AND the scenario is an outline, it retries with the first
Examples row substituted (matching only — the .feature text is never rewritten). Without this, a
typed pattern like ^he waits (\d+) seconds$ would never match "he waits <delay> seconds" and we'd
emit a FALSE UNBOUND — costly, since unbound steps are a hard-stop. Bound-via-substitution steps
record `matched_via: "example-substituted"` + `resolved_text`; steps with placeholders record
`placeholders: [...]` so the agent knows which params come from Examples columns.

## Background steps (fixed after testing on a real working suite)
Cucumber runs `Background:` steps before EVERY scenario in a feature, so they carry real setup (the
step that opens the page, logs in, etc.). The first version bound only `scenarios[]` and SILENTLY
dropped background steps — a clean-looking `BOUND n / UNBOUND 0` while the setup step vanished.
Now: background steps are bound ONCE per feature (the same step-def serves every scenario, so counts
aren't inflated) and reported under `backgrounds[]`; each scenario carries `has_background: true`.

## Unused (dead) step definitions
The binder reports `unused_definitions[]`: definitions no feature references. This is the REVERSE of
an UNBOUND step and must not be confused with it:
  - UNBOUND step      = a Gherkin step with no definition -> a real gap -> HARD-STOP.
  - unused definition = a definition no Gherkin step uses -> dead glue -> report, don't stop.
On the colleague's suite: 27 definitions, 18 used, 9 dead (all of FrameSteps + 3 orphans in
FrameWindowSteps). At enterprise scale this is real value: don't migrate glue nothing calls.

## Module hygiene
The CLI is guarded (`import.meta.url` check) so the tool can be imported programmatically for
composition and tests without executing the CLI or calling process.exit.
