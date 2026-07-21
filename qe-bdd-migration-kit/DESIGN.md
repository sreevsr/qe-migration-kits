# QE BDD Migration Kit — Design Document
### Cucumber + POM + DI + Java + Selenium  →  Playwright-BDD + TypeScript

Status: DESIGN (v0.1). Sibling to the TestNG migration kit; reuses its proven components.
Validation target: `saipradeepcs/Selenium_Cucumber_framework`.

---

## 1. Goal & non-goals
**Goal.** Migrate a Cucumber+Selenium+POM+DI suite to **runnable** Playwright-BDD + TypeScript,
preserving the `.feature` files verbatim and preserving each scenario's verifiable intent, with an
agent driving the workflow and deterministic tools doing the heavy lifting for zero tokens.

**Non-goals (explicit boundaries).**
- **Serenity Screenplay** (Task/Question/Ability/`Ensure`) is OUT. A Screenplay suite is also a
  Cucumber suite, so this kit is the *foundation* a future Screenplay layer would build on — but
  translating the Screenplay pattern itself is a separate, un-probed problem.
- **Cucumber-JVM only** (io.cucumber `@Given/@When/@Then`, regex or cucumber-expression). Other
  BDD runners (JBehave, Concordion) are out.
- **Two DI/state-sharing styles are supported** (both found in real suites):
  - **Style A — PicoContainer constructor-DI:** `TestContext` + `PageObjectManager.getX()` lazy
    singletons + `ScenarioContext` (e.g. saipradeepcs).
  - **Style B — static ThreadLocal driver factory:** `DriverFactory.getDriver()` + step classes
    doing `new XxxPage(DriverFactory.getDriver())` directly; no context object (very common).
  Spring/Guice DI is out (flagged as `unsupported`, never guessed).

## 2. What we proved in the probe (so this isn't speculation)
On `saipradeepcs` we traced one scenario end-to-end and hand-translated it (see the
cucumber-to-playwright-bdd demo). Confirmed:
- The **`.feature` carries over near-verbatim** to playwright-bdd.
- The **Gherkin↔stepdef binding** is simple, parseable regex/cucumber-expressions — mechanical.
- The **DI (`TestContext`/`PageObjectManager`/`ScenarioContext`)** maps cleanly to Playwright
  fixtures — a pattern substitution, not an invention.
- **Page objects and oracle extraction** reuse the TestNG kit's approach.

## 3. The core reframe vs. the TestNG kit
The TestNG kit's unit of migration is a **Java `@Test` method**. The BDD kit's unit is a
**Gherkin scenario**, whose intent is spread across four layers that must be *stitched*:

```
  .feature step   ->   @When regex   ->   step-def method   ->   page object   ->   assertion
  (Gherkin)            (binding)          (Java glue)            (POM)             (oracle)
```

Everything downstream of "step-def method" is what the TestNG kit already handles. The NEW work is
(a) parsing `.feature` files, (b) binding steps to methods, and (c) mapping DI → fixtures.

## 4. Architecture — reuse vs. new

| Component | Source | Notes |
|---|---|---|
| **Feature parser** | **NEW** | Parse `.feature` → Feature/Scenario/Step/Examples model. |
| **Step binder** | **NEW** | Match each Gherkin step to its `@Given/@When/@Then` method (regex + cucumber-expression), map capture groups → params. THE novel front-end. |
| **DI resolver** | **NEW** | Detect `TestContext`/`PageObjectManager`/`ScenarioContext` (and constructor-injected managers) → emit a fixture plan. |
| **Oracle extractor** | **REUSE** (from TestNG kit) | Once inside a step-def method, the origin-tracing classifier applies unchanged: follow calls into page objects, classify assertions (must-pin vs derive) by origin. |
| **Assertion recognizer** | **EXTEND** | Add `assertThat(...)` (Hamcrest/AssertJ) alongside TestNG `Assert.*`. (This is the existing AssertJ loose-thread; the BDD kit needs it.) |
| **Slicer** | **ADAPT** | Slice by **feature file** (feature + its bound step-defs + page objects + oracles), not by test class. |
| **Helper contract** | **NEW (BDD-specific)** | Cucumber→playwright-bdd rules: regex→cucumber-expression, DI→fixtures, DataTable, Scenario Outline→Examples, hooks→fixtures, `.feature` carry-over. |
| **AST parity gate** | **REUSE + ADAPT tags** | Scores generated TS step-defs against oracles; `@source` becomes step/scenario-level. |
| **Orchestrator** | **REUSE** | Same subcommands (prepare/validate/status/report), same self-provisioning, same intake-attestation. |
| **Agent (CLAUDE.md + skill)** | **REUSE shell, NEW content** | Same sequence + 3 hard-stops; the skill is rewritten for Cucumber translation. |
| **Runtime target** | **NEW** | playwright-bdd (`bddgen` + `playwright test`) instead of plain `playwright test`. |

**~70% reuse. Two genuinely new deterministic pieces: the Step Binder and the DI Resolver.**

## 5. The new intent model (records.json for BDD)
The TestNG `records.json` is keyed by `Class.method`. The BDD version is keyed by
**feature + scenario**, with steps carrying their bound method and oracles:
```
[
  {
    "feature": "E2ETest.feature",
    "scenario": "user places an order by search an item",
    "tags": ["@SmokeTest"],
    "examples": [{ "customer": "Pradeep", "item": "dress" }, ...],   // Scenario Outline rows
    "steps": [
      { "keyword": "Given", "text": "user is on hom page",
        "bound_method": "HomePageSteps.user_is_on_hom_page", "params": [], "oracles": [] },
      { "keyword": "When", "text": "he searches for \"<item>\"",
        "bound_method": "HomePageSteps.he_searches_for", "params": ["item"],
        "oracles": [ /* same oracle shape as TestNG kit, if the method asserts */ ] }
    ],
    "oracle_count": N, "must_pin_count": M,
    "unbound_steps": []          // steps we could NOT match to a method -> REVIEW (fail-safe)
  }, ...
]
```
Key fail-safe (mirrors the TestNG kit's REVIEW): **an unbound step is never silently dropped** —
it's flagged for human review, because a step with no matching definition is a real problem.

## 6. The DI → fixture plan (the second new piece)
Two styles, one target — Playwright fixtures:

**Style A (PicoContainer):**
The DI resolver detects the pattern and emits a fixture plan the agent implements:
- `PageObjectManager.getX()` (lazy singleton) → one fixture `x` per page object.
- `ScenarioContext` (K/V bag) → a `scenarioContext` fixture.
- `DriverManager`/WebDriver → the built-in `page` fixture (free).
- Constructor-injected `TestContext` → dissolved; steps receive named fixtures.
- Cucumber `@Before/@After` hooks → playwright-bdd fixtures / `beforeEach`/`afterEach`.

**Style B (static ThreadLocal factory):**
- `DriverFactory.getDriver()` (static ThreadLocal) → the built-in `page` fixture.
- `new XxxPage(DriverFactory.getDriver())` in step classes → one fixture per distinct page type.
- Step code calling `getDriver().foo()` directly → direct `page.foo()`.
- Hooks that init/quit the driver → **DELETED** (Playwright owns the browser lifecycle).
- An `@After` screenshot-on-failure hook → **DELETED**; use `screenshot: 'only-on-failure'` in
  `playwright.config.ts`.

Either way the plan is emitted into pack 00 so the agent builds `fixtures.ts` once.

## 7. The migration unit & slicing
**REVISED after building it** (the original "one pack per feature" was wrong — recorded here rather
than quietly changed):
- **Pack 00 — abstraction layer + fixtures:** page objects + the DI→fixture plan (+ hook actions)
  → migrated ONCE (produces `pages/*.ts` + `fixtures.ts`).
- **One pack per USED step-definition class** — NOT per feature. Two reasons:
  (a) the agent's output unit is one `.ts` step file per Java step class; slicing by feature would
      DUPLICATE a class across packs (`UITestSteps` serves all 4 backgrounds — 7 scenarios) and
      split its context;
  (b) it mirrors the TestNG kit, which slices per test class. Same discipline, same shape.
  Each pack carries: the steps it binds (with the params that come from the feature), the oracles to
  preserve, the scenarios that depend on it, and the Java source.
- **`.feature` files are COPIED, not translated — 0 tokens, no agent.** Gherkin carries over verbatim
  to playwright-bdd, so the whole scenario layer is deterministic and cannot be corrupted by an LLM.
- **Dead step-def classes are skipped** (not packed, reported in the INDEX).

## 8. Hard-stops (same three, BDD-flavored)
1. **Intake attestation** — before migrating (source valid/representative).
2. **Gate BLOCK** — a must-pin oracle lost, OR an **unbound step** (a scenario that can't be fully
   bound is a real gap — surfaced, not silently migrated).
3. **playwright test failure** (via `bddgen` + `playwright test`).

## 9. Runnable target & validation
- Generated project uses **playwright-bdd**: `npx bddgen && npx playwright test`.
- Validate on `saipradeepcs`: prove features carry over, DI→fixtures works, steps bind, and the
  implemented scenarios run green. Then run on 1–2 other public Cucumber suites.

## 10. Build order (deterministic-first, like the TestNG kit)
1. **Feature parser** (`.feature` → model). Small, standalone, testable.
2. **Step binder** (Gherkin ↔ `@Given/@When/@Then`). THE novel piece; build + test in isolation.
3. **DI resolver** (detect TestContext/managers → fixture plan).
4. **records.json emitter** (BDD schema) [DONE — tools/bdd-records] + **slicer** (by feature).
5. **Oracle extraction** — wire in the reused origin-tracer + the `assertThat` recognizer.
6. **Helper contract** + **agent skill/CLAUDE.md** (BDD content).
7. **Gate adaptation** (step-level `@source`) + **orchestrator reuse**.
8. Validate on `saipradeepcs`.

## 10b. Validated so far (on real suites, not speculation)
- feature-parser, step-binder, di-resolver: all three run correctly on `saipradeepcs` (Style-A DI)
  and the colleague's `CucumberSeleniumFramework` (Style-B DI, Cucumber 7 cucumber-expressions).
- **Oracle extraction is the SHARED TestNG classifier**, reached via its additive `--entry-points`
  mode. On the colleague's suite: 18 step definitions, 6 assertions -> 3 MUST-PIN [external],
  3 derive, 0 REVIEW. The SauceDemo baseline (22 MUST-PIN / 0 REVIEW) is unchanged throughout.
- **Step-definition parameters classify EXTERNAL** — Cucumber binds them from the .feature (step
  text / Examples row / DataTable), which is external test data exactly like a data-provider row.
  Without this, an oracle pinned in Gherkin (`Then ... URL "https://..."`) wrongly reads as derive.
- The binder reports **unused (dead) step definitions** separately from UNBOUND steps.

## 11. Known risks (honest, up front)
- **Ambiguous step bindings** — two step-defs whose regexes both match a step. Binder must detect
  and flag (don't guess).
- **Glue-heavy / weak assertions** — many BDD suites assert only "element is displayed" (low-value
  oracles), like we saw. The kit extracts them faithfully but they're thin.
- **Hooks & tagged hooks** (`@Before("@SmokeTest")`) — conditional setup; maps to scoped fixtures,
  a known-fiddly area.
- **Custom `World`/DI beyond PicoContainer** — Spring/Guice would need a resolver extension.
- **playwright-bdd version drift** — the target tool evolves; pin a version.
- **The enterprise ceiling** — Screenplay is explicitly out; this kit is the foundation, not the
  whole answer for a Serenity+Screenplay suite.
