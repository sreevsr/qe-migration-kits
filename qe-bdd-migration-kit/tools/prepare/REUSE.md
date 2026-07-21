# prepare (slicer) — BUILT as tools/prepare/prepare_bdd.mjs (adapted from the TestNG slicer)
Slice by USED STEP-DEF CLASS, not by feature (see DESIGN.md §7 for why the original per-feature plan
was revised). Emits:
- 00_page_objects.md : abstraction layer + the DI->fixture plan + hook actions (migrate ONCE)
- <StepClass>.md     : steps bound (with feature-supplied params), oracles to preserve, dependent
                       scenarios, Java source
- INDEX.md           : run order, the dead glue skipped, token discipline
- copies .feature files verbatim into <pw>/features  (0 tokens — Gherkin needs no agent)
Validated on the colleague's suite: 4 step-class packs + 1 abstraction pack, FrameSteps skipped as
dead glue, 4 features copied.

## Dead glue has THREE states (found by reviewing real pack output, not the summary line)
1. **Whole class dead** (FrameSteps: 6/6 unused) -> not packed at all; listed in INDEX.
2. **Dead methods inside a LIVE class** (FrameWindowSteps: 3 of 6 unused) -> the pack must NAME them.
   The pack's step table lists only bound methods, but the Source block is the WHOLE class — without
   an explicit "DO NOT translate" list the agent reconciles the gap itself and translates dead glue.
3. **Used** -> packed with its oracles.
Validated: 27 defs = 18 used + 6 (FrameSteps, skipped) + 3 (FrameWindowSteps, called out).
