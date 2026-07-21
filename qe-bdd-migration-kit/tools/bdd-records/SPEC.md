# bdd-records — SPEC (NEW, deterministic) — THE JOIN
Input:  step-binder bound.json  +  the SHARED extractor's method-keyed oracles (--entry-points mode).
Output: the BDD intent model — records keyed by FEATURE + SCENARIO (DESIGN.md §5).

Why a join: the extractor knows what a step-def method asserts but nothing about Gherkin; the binder
knows which scenario's step calls that method. Neither alone is the intent model.

Rules:
- Background steps are attached to EVERY scenario in their feature (flagged from_background:true) —
  they run before each scenario, so they are part of that scenario's intent.
- Each step carries bound_method, params, and its oracles (looked up by Class.method).
- unbound_steps[] per scenario = the fail-safe (a scenario that cannot be fully bound is a gap).
- A bound step with NO extractor record -> oracle_lookup: "NOT_IN_EXTRACTOR_OUTPUT" + WARN. Means the
  entry-point list and the extraction disagree; never silently reported as zero oracles.

Counting discipline (this bites):
One step-def can serve many scenarios (verifyMessage serves 2; openAnyPage serves 4 backgrounds).
Its oracles genuinely run for each scenario, so per-scenario counts include them — but summing those
for a suite total DOUBLE-COUNTS. So the summary emits both:
  - distinct_oracles / distinct_must_pin              -> what EXISTS in the codebase
  - oracle_instances_across_scenarios / must_pin_...  -> what RUNS
Validated on the colleague's suite: 6 distinct oracles (3 MUST-PIN) but 7 instances (4 must-pin),
because SubmitButtonSteps.verifyMessage serves both submit scenarios.

CLI is guarded (import.meta.url) so the module can be imported for composition/tests.
