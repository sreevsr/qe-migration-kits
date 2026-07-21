# QE BDD Migration Kit — Cucumber + Selenium/Java → Playwright-BDD/TypeScript

Turn a Cucumber + Java + Selenium suite into a working **playwright-bdd** + TypeScript
one — and **prove, mechanically, that no scenario quietly lost what it was checking.**

This is the sibling of the TestNG migration kit. It shares that kit's engine — the same
reader, the same checker, the same definition of "nothing lost" — and adds the few pieces
Cucumber needs on top. **Proven end to end** on real suites (see §Validated).

## Why this exists

The problem is the same one the TestNG kit solves. Migrating a test suite by hand is slow
and unprovable; handing it wholesale to an AI is fast but silently drops assertions, so you
get green scenarios that check less than they used to and can't tell by looking. The real
problem is **proof**, not speed.

So the split is the same: deterministic tools do ~90% of the work for zero AI cost and pin
exactly what each scenario checks; the AI only translates the glue, one small pack at a
time, against a fixed rulebook; and a deterministic checker confirms every check survived.

What's *different* is the unit. In the TestNG kit a test is a `@Test` method. Here a test is
a **Gherkin scenario**, and that changes three things — which is all the extra machinery is
for:

1. **The `.feature` files carry over almost untouched.** They're the business-readable
   spec; the kit copies them into playwright-bdd rather than translating them. Rewriting
   them would mean re-deriving intent — the one thing the AI must never do.
2. **Steps bind to methods by pattern, at runtime.** Something has to work out *which*
   Java method runs each Gherkin step before anything can be migrated. That's the
   step-binder, and it's the one genuinely new piece.
3. **Cucumber wires up its page objects with dependency injection; Playwright has no
   constructors.** So the injection has to be *reshaped* into Playwright fixtures, not
   ported line-for-line.

## The words this document uses

These are on top of the shared vocabulary (**oracle, must-pin, derive, gate, pack,
orchestrator, hard-stop, agent**) — see the TestNG kit's README for those. BDD adds:

| term | what it means |
|---|---|
| **feature-parser** | Reads the `.feature` files into a model — scenarios, examples, data tables. |
| **step-binder** | Works out which Java method runs each Gherkin step. **UNBOUND** (no method matches) or **AMBIGUOUS** (several do) both stop the run — a wrong guess would corrupt everything after it. |
| **di-resolver** | Reads *how* the suite injects its page objects, so the AI reshapes rather than guesses. |
| **fixtures** | Playwright's replacement for dependency injection — a step asks for what it needs by name. |
| **dead glue** | Step methods no feature actually calls. Real code, never run. Found, reported, skipped. |
| **bdd-records** | The join: the step-binder's results + the shared reader's oracles → one intent model keyed by feature + scenario. |
| **EXTEND pack** | In a batched run: "add these methods to the existing step file, don't rewrite it" (see §Batching — this is the crux). |

---

## Part 1 — The 60-second picture

```
   .feature files          ──────────────────────────►  copied across, near-verbatim
                                                                    │
   step definitions (.java) ──►  step-binder ──► which method runs each step
                                       │                            │
                                  di-resolver ──► how it wires up    │
                                       │                            ▼
                                  the SHARED reader ──► oracles ──► the agent translates
                                  (via --entry-points)              the glue, one pack,
                                                                    then the SHARED gate
                                                                    checks it
                                                                         │
                                                              PASS / NEEDS-HUMAN / BLOCK
```

The reader and the gate are the *same tools* the TestNG kit uses — this kit calls into
them. Everything except "the agent translates" is deterministic and free.

## Part 2 — Do it

### Step 1 — Prerequisites (once per machine)

Identical to the TestNG kit: **JDK 21 + Maven**, **Node 22.15+**, and a coding **agent**
(Claude Code, Cursor, or Copilot). After installing anything, open a **fresh terminal**.

**This kit is not standalone.** It borrows the reader and the gate from the TestNG kit, so
**both folders must be present** — keep them side by side and `init` finds the TestNG kit
on its own (you can point it explicitly with `--testng-kit` if needed).

### Step 2 — Set it up (one command, once per suite)

```
node <TESTNG-KIT>\tools\orchestrator\init.mjs --suite "C:\path\to\your-cucumber-suite"
```

**Note the path: `init.mjs` lives in the *TestNG* kit, not this one.** It's the single
entry point for both kits — it reads the suite, detects that it's BDD, and wires up the
BDD kit for you. (It sits in the TestNG kit because that kit is always present: the BDD
kit borrows its engine, so the TestNG kit is guaranteed to be there.)

That's the whole setup. `init` checks your prerequisites, reads the suite and confirms
it's BDD, **finds the BDD kit and the shared engine**, creates the migration folder
(a Playwright-BDD project with a `work\` scratch dir inside), installs Playwright, drops
the agent's instructions in, and — the point of it — **writes every path into a small
`migration.json` the tools read.** You never type `--testng-kit`, `--out`, or `--pw`:
`init` works them out and validates them, because a tool can check a path is real and a
chat box can't. *(If the BDD kit isn't found automatically, pass `--bdd-kit <path>`.)*

### Step 3 — Say it (in your editor's agent mode)

```
Migrate the suite.
```

That's the instruction. The agent reads `migration.json`, runs the whole deterministic
chain (parse features → bind steps → resolve DI → extract oracles → slice packs),
translates pack `00` (page objects + fixtures) first, then one step-class pack at a time,
running the gate after each, and finally validates and writes the report. It stops only
at the four hard-stops — the first being intake, where it shows you the feature/scenario
counts, bound/unbound steps, dead glue and must-pins, and waits for you to confirm.

To review in stages: **Migrate the suite in batches of 10 features.** To resume later:
**Continue the migration.** (There's also a manual CLI path with explicit flags — see
Part 3 if you'd rather drive the phases yourself.)

### Step 4 — Read the result

The target is **playwright-bdd**, so it runs with:

```
npx bddgen && npx playwright test
```

And the three numbers that mean "done" are the same: **must-pin recovery X/Y**,
**0 BLOCK**, and a **green** Playwright run.

---

## Part 3 — Reference

### The manual / CLI path

`init` + "Migrate the suite." is the primary flow. If you'd rather drive the deterministic
phases yourself — and translate in any agent between them — the orchestrator takes explicit
flags, which always override anything in `migration.json`:

```
# prepare: parse features, bind steps, resolve DI, extract oracles, slice packs
node <BDD-KIT>\tools\orchestrator\orchestrate_bdd.mjs prepare ^
     --testng-kit <TESTNG-KIT> --suite <SUITE> --out <WORK> --pw <PW>

# translate (your agent): migration-packs\00_page_objects.md first, then one step-class
#   pack at a time, into <PW>

# validate: gate + bddgen + playwright test
node <BDD-KIT>\tools\orchestrator\orchestrate_bdd.mjs validate ^
     --testng-kit <TESTNG-KIT> --out <WORK> --pw <PW>

# report
node <BDD-KIT>\tools\orchestrator\orchestrate_bdd.mjs report --out <WORK>
```

The four locations are the TestNG kit's (**KIT** here is the BDD kit; it defaults to where
the script lives), plus **`--testng-kit`** for the shared engine and **`--pw`** for the
playwright-bdd project.

### What's shared with the TestNG kit (one implementation, not two)

- **Oracle extraction** — the *same* origin-tracing reader, via its `--entry-points` mode.
  Entry points come from the step-binder instead of `@Test` scanning. (Reimplementing the
  reader for BDD would fork the most-tuned component in either kit and guarantee drift.)
- **The gate** — the *same* checker, via its `--bdd` flag; the only difference is the unit
  it looks for (`Then(...)` instead of `test(...)`).
- **The orchestrator, the agent workflow, and the four hard-stops** — identical. See the
  TestNG README §5 for the hard-stops and the HARD-STOP 3 exception (verify the cause,
  change only *how* it interacts, never weaken an assertion). The BDD kit adds one rule:
  the `.feature` files are never touched by a fix, either.

Only the *prepare chain* is a sibling rather than shared — six deterministic tools instead
of three. That's sequencing, not intelligence.

### Batching a large BDD engagement — BY FEATURE

The TestNG kit batches by test *class*. BDD **cannot**, and the reason is the crux of the
whole design: a feature's steps can span several step classes, so migrating a subset of
*classes* would leave steps UNDEFINED and `bddgen` would fail. **The batch unit is the
FEATURE.** The step classes it needs are derived, and only in-scope `.feature` files are
copied — an uncopied feature can't fail.

```
prepare ... --batch-size 10 --batch 1          # then --batch 2, 3 ...
        ... --only-features a.feature,b.feature
        ... --skip-features-file skip.txt       # one per line:  legacy.feature  # retired at source
```

**Tracking is per METHOD, not per class.** One step class often serves many features with
different method subsets — on the validation suite, `UITestSteps` serves all four features
(one method for the frames feature, seven for the web-form one). "Class already migrated,
skip it" would leave the web-form's six extra steps UNDEFINED. So a later batch gets an
**EXTEND pack**: add these methods to the existing step file, don't rewrite it.

- **One project.** Features accumulate in `<PW>\features`, never cleared. Pack `00`
  (pages + fixtures) is migrated once, on batch 1; later batches are told not to
  re-translate it.
- **The gate's scope is METHOD-level** here (class-level in the TestNG kit) and scores
  `in_scope + already_migrated` — every batch re-verifies everything migrated so far, so a
  later batch that breaks an earlier feature's step is a **BLOCK**.
- **Ledger, resume, drift, checkpoint** — as the TestNG kit, but fingerprinting the
  *feature* list. `status --out <WORK>` prints `RESUME HERE: prepare --batch K`.
- **Dead glue** = referenced by *no* feature in the whole suite — computed from all
  records, never from one batch's slice (or an earlier batch's migrated class would read as
  "dead" in a later one).
- **No `--batch-size` = no batching** — the full-suite path is unchanged.

### Validated on

- **`CucumberSeleniumFramework`** (Selenium 4.21 + Cucumber 7.18, static-factory DI) —
  primary. 4 features, 7 scenarios, 27 step definitions → 24 bound, 0 unbound, 9 dead glue
  found and skipped; gate clean, `npx playwright test` green.
- **`saipradeepcs/Selenium_Cucumber_framework`** (PicoContainer DI) — the DI-style test.

The TestNG kit's SauceDemo baseline (22 must-pin, 0 REVIEW) is unchanged by every
shared-code change — the two kits share an engine, so that baseline is the regression guard
for both.

### Known limitations (stated honestly)

- Proven on plain Cucumber + Page Objects with constructor or static-factory DI. **Serenity,
  the Screenplay pattern, Spring/Guice injection, and Gradle-only builds are refused up
  front** — each is a different model, not a small gap, and setup stops in the first ten
  seconds naming what and why.
- Everything the shared engine can't do, this kit can't either — see the TestNG README §9.
  In particular the gate scores *intent, not interaction*: a wrong selector that still
  passes is invisible to it, and the live `playwright test` run is the final authority.
- Anything outside the proven set: probe first (a read-only pass of the reader over the
  suite costs nothing and tells you what it found and what it missed), quote after.
