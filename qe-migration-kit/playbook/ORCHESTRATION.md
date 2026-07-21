# Orchestration Runbook — how the agent drives the migration

The **orchestrator** (`tools/orchestrator/orchestrate.mjs`) runs every mechanical step for zero
tokens and STOPS at judgment gates. The **agent** (Claude Code / Copilot / Cursor) drives it: it
runs the orchestrator, does the translation the orchestrator can't, and — crucially — **halts at
the gates instead of pushing through.** This is the "runner", split so the deterministic 90% is
free and repeatable and the LLM is used only where judgment/translation is genuinely required.

## Roles
- **orchestrate.mjs** — classpath, extract, slice, gate, tsc, playwright, report. No LLM. Stops
  at: baseline-not-green, gate BLOCK, tsc failure, playwright failure.
- **agent (you)** — translate packs; at each STOP, involve the human / decide, do NOT auto-push.

## Exit codes to branch on
`0` proceed · `10` baseline not green · `20` gate BLOCK · `30` tsc failed · `40` playwright failed · `2` usage error.

## The loop

### 1. Prepare (deterministic; baseline = intake attestation, not a per-run gate)
```
node tools/orchestrator/orchestrate.mjs prepare --kit <KIT> --suite <SUITE> --out <WORK>
```
- Produces `<WORK>/records.json` and `<WORK>/migration-packs/`. Self-provisions first (setup).
- **Baseline is an INTAKE attestation.** By default the orchestrator does NOT run the source
  suite \u2014 running 100s of tests every prepare is impractical, and source-runtime greenness is a
  weak signal (aging Selenium is often flaky). The suite owner attests the tests are VALID at
  intake; the orchestrator migrates the test INTENT, which is intact even if the Selenium runtime
  is red. (A red Selenium suite frequently migrates to a GREEN Playwright suite \u2014 auto-waiting
  fixes the flakiness that made it red.)
- Options: `--baseline-report <surefire.xml>` records existing results as evidence (recommended
  at customer scale); `--run-baseline` runs it as a SOFT check (reports pass/fail, only stops if
  it literally couldn't execute \u2014 exit 10 = "couldn't run", distinct from "N failed").

### 2. Translate the abstraction layer ONCE (agent)
Read `<WORK>/migration-packs/00_page_objects.md` + `contracts/helper_contract.md`. Create the
Playwright page objects, keeping class/method names. Do NOT write specs yet. (Token cost: once.)

### 3. Translate each test pack (agent, one at a time)
Use `status` to see what's pending:
```
node tools/orchestrator/orchestrate.mjs status --out <WORK> --generated <PW>/tests
```
For each pending pack: read that ONE pack + the contract, write the spec into `<PW>/tests`,
assert every MUST-PIN oracle, tag `// @source:`. Never paste the whole repo. (Token cost: one
small pack each.)

### 4. Validate (deterministic; stops on real problems)
```
node tools/orchestrator/orchestrate.mjs validate --kit <KIT> --out <WORK> --generated <PW>/tests --pw <PW>
```
- **Exit 20 = STOP (gate BLOCK).** A must-pin was lost. Open the flagged spec; re-prompt the
  agent with the SPECIFIC gate line only. Never blind-regenerate. (NEEDS-HUMAN is not a stop —
  it's "look here"; often a cross-language matcher gap on correct code. Review, don't auto-fix.)
- **Exit 30 = STOP (tsc).** Fix the compile error (usually a small type/import) and re-run validate.
- **Exit 40 = STOP (playwright).** Read WHERE it failed: API-setup → API-migration issue; UI
  assertion → selector/timing. Fix that, don't regenerate everything.

### 5. Report
```
node tools/orchestrator/orchestrate.mjs report --out <WORK>
```
Writes `migration-run-report.md`: gate verdicts, playwright pass/fail, steps, and a **token**
line (see below).

## Token accounting (make the cost story measurable)
The orchestrator doesn't call the LLM, so it can't meter the agent. Two cases:
- **Claude Max / agent runtime:** not per-token metered; the report says so honestly.
- **Metered path (API / Cursor / Copilot with usage):** have the translation wrapper append one
  line per call to `<WORK>/tokens.json` — `{"step":"SearchTest","input_tokens":N,"output_tokens":M}`.
  `report` then sums them. This is how you turn "designed to be cheap" into a measured
  per-test number for a customer.

## Why this is safe to hand a customer
- Deterministic steps are identical every run; nothing depends on the agent's mood.
- The agent cannot silently ship a lost must-pin (gate BLOCK stops it) or un-green code
  (baseline stops it) or a non-compiling/ non-running spec (tsc/playwright stop it).
- Code never leaves the environment; the agent works in-repo.
