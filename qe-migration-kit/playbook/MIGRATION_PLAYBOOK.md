# Migration Playbook — how the runner works

This is the "runner". It is not a script that calls an LLM API — it is a sequence a coding
**agent** executes (Claude Code on a Max plan; GitHub Copilot or Cursor at a customer). The
deterministic tools do the heavy lifting for zero tokens; the agent is used only for the
irreducible translation step, one small slice at a time.

```
  ┌────────── deterministic (0 tokens) ──────────┐        ┌─ agent (tokens) ─┐
  extractor → records.json → prepare → packs  ──────▶  translate one pack   ──┐
                                                                               │
  ┌──────────── deterministic (0 tokens) ────────────────────────────────────┘
  gate (parity) → tsc --noEmit → playwright test → report
                    │
                    └─ only a real BLOCK/fail re-enters the agent, with the exact message
```

## Prerequisites
- JDK 21 + Maven (to build/run the extractor and to build the source suite's classpath)
- Node 22.15+ (for the gate, the prepare tool, and Playwright; 22.15 is the floor for the corporate-CA retry)
- A coding agent: Claude Code (Max), or Copilot/Cursor
- The source suite must have a **green baseline** first (see Step 0). Never migrate un-green code.

## Step 0 — establish the green baseline (do NOT skip)
Run the source Selenium suite and confirm it passes in your environment. Inherited suites often
need a run parameter (e.g. `-Dbrowser=CHROME`) or a specific `testng.xml`. If it will not go
green, fix the run contract or pick another suite — you migrate FROM green, never TOWARD it.

## Step 1 — extract intent (deterministic, 0 tokens)
```
# build the dependency classpath of the SOURCE suite
mvn -q -f <suite>/pom.xml dependency:build-classpath -Dmdep.outputFile=cp.txt
# run the extractor
java -jar tools/extractor/qe-extractor.jar "<suite>" "<suite>/cp.txt" "records.json"
```
Output: `records.json` — the pinned intent (oracles per test, must-pin vs derive).

## Step 2 — slice into packs (deterministic, 0 tokens)
```
node tools/prepare/prepare_migration.mjs --records records.json --repo <suite> --out migration-packs
```
Output: `migration-packs/` with `INDEX.md`, `00_page_objects.md`, and one pack per test class.

## Step 3 — translate the abstraction layer ONCE (agent, tokens)
Hand the agent `migration-packs/00_page_objects.md` and `contracts/helper_contract.md`. Instruct:
> "Translate these Java page objects to Playwright + TypeScript page objects, following the
> helper contract. Keep the same class and method names. Output one .ts file per class."
This is one-time. Everything else reuses these.

## Step 4 — translate one test pack at a time (agent, tokens)
For each test pack in INDEX order, hand the agent ONLY that pack + the contract. Instruct:
> "Translate this test class to a Playwright spec following the helper contract and reusing the
> page objects. Assert every MUST-PIN oracle listed. Tag each test with `// @source: Class.method`.
> Do not invent assertions or freeze computed values."
Write the spec into the generated project's `tests/` (or `generated/`) folder.

## Step 5 — validate (deterministic, 0 tokens)
```
# static intent check against the extracted oracles
node tools/gate/parity_check_ast.mjs --oracles records.json --generated <generated>/tests
# compile + run
npx tsc --noEmit
npx playwright test
```
- The **gate** reports must-pin recovery + PASS/NEEDS-HUMAN/BLOCK per spec.
- `tsc` proves it compiles; `playwright test` proves it runs green against the app.

## Step 6 — fix only real failures (agent, minimal tokens)
For each **BLOCK** (a lost must-pin) or failing test, re-prompt the agent with the SPECIFIC gate
line or Playwright error — never a blind "try again". NEEDS-HUMAN rows are "look here", not
auto-fix: review them (they are often cross-language matcher gaps on correct code, not defects).

## Token budget — why this stays cheap
- Steps 1, 2, 5 are deterministic: **0 tokens**.
- Step 3 reads the abstraction layer **once**.
- Step 4 reads **one small test class at a time** — not the repo.
- The gate kills the "did it work? regenerate everything" loop that dominates naive migration
  cost. Tokens are spent on translation and on targeted fixes only.
- Rough order of magnitude: input ≈ (abstraction layer once) + (Σ test sources); output ≈ the
  generated code. You pay for the code you must produce, and little else.

## What each tool is (and is not)
- **extractor** — reads Java, pins intent. Deterministic. The "answer key".
- **prepare** — slices minimal context. Deterministic. The token-frugality lever.
- **gate** — scores generated Playwright against the answer key. Deterministic. Catches lost or
  invented intent, frozen computeds, and data-row isolation smells. Static only — `playwright
  test` remains the runtime source of truth.
- **the agent** — the translation engine. Interchangeable (Claude Code / Copilot / Cursor).
