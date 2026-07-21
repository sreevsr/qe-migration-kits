# extractor — REUSE from TestNG kit + EXTEND
The origin-tracing oracle classifier is REUSED unchanged: once the step-binder points at a step-def
method, follow calls into page objects and classify each assertion by origin (must-pin vs derive),
exactly as in the TestNG kit. TWO changes for BDD:
1. Entry points come from the step-binder (bound methods), not from @Test scanning.
2. Add an assertThat(...) (Hamcrest/AssertJ) recognizer alongside TestNG Assert.* (the existing
   AssertJ loose-thread — required here).
Emits the BDD records.json schema (keyed by feature+scenario; see DESIGN.md §5).
