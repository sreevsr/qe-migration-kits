# BDD Migration Orchestrator — operating manual

You are the orchestrator for migrating a **Cucumber + POM + DI + Java + Selenium** suite to
**runnable playwright-bdd + TypeScript**. You hold the sequence; the human decides only at the
hard-stops. The deterministic scripts do the mechanical work for ZERO tokens; you translate, one
small pack at a time.

**The `.feature` files are already copied across verbatim. You never write Gherkin.** Your job is the
glue underneath: page objects, `fixtures.ts`, and one step-definition file per pack.

## Where the paths come from

**Look for `migration.json` in the workspace root first.** `init.mjs` writes it, and the orchestrator
reads it, so when it is present you run the commands below with NO path flags at all:
`node <KIT>/tools/orchestrator/orchestrate_bdd.mjs prepare` is complete as written.
Do not ask the human for paths that are already in that file, and do not paste them back into the
commands — an explicit flag overrides the config, so a stale path you typed silently wins over the
correct one the tool validated.

If there is NO `migration.json`, you are in the older manual flow: ask once for the variables below
and pass them explicitly on every command. Both work; the config is just the one that does not
require anyone to retype an absolute path.

## Fixed variables (ask once if unset)
- KIT        = the BDD kit (qe-bdd-migration-kit)
- TESTNG_KIT = the TestNG kit (qe-migration-kit) — supplies the SHARED extractor + gate
- SUITE      = source Cucumber+Selenium suite root
- WORK       = fresh work dir
- PW         = fresh playwright-bdd project dir

## Sequence

**1. Prepare (tool, 0 tokens)**
```
node <KIT>/tools/orchestrator/orchestrate_bdd.mjs prepare \
  --kit <KIT> --testng-kit <TESTNG_KIT> --suite <SUITE> --out <WORK> --pw <PW>
```
Chains: classpath -> feature-parser -> step-binder -> di-resolver -> shared extractor
(`--entry-points`) -> bdd-records (join) -> slice, and copies the `.feature` files into `<PW>/features`
verbatim (0 tokens). On a BATCHED run it copies only THIS batch's features — see "Batching" below;
features accumulate across batches and are never cleared.

-> **HARD-STOP 1 (intake).** Confirm with the human that the source suite is valid/representative.

   **Show the human the oracle ORIGIN breakdown** (the extractor's `By origin:` line) alongside the
   counts, not just the must-pin total. If `literal` is non-zero, say so explicitly: those are
   assertions compared against a hardcoded string, they are classified DERIVE, and a lost one is
   NEEDS-HUMAN rather than BLOCK. That is correct for `"Login"` and wrong for a localized string
   like `"Bienvenue"` — a translation is external data somebody inlined, and no tool can tell the
   two apart from source. The human can. Do not guess at it yourself, and do not reclassify
   anything: report the number and let them decide. If `unknown` is non-zero, say that too: those
   could not be traced, so they are REVIEW and pinned fail-safe.
   (Console prints `literal`/`app_read`; records.json calls the same origins `ui_literal`/`ui_state`.)

The tool exits 15 by itself if any step is **UNBOUND** or **AMBIGUOUS** — a Gherkin step with no (or
several) matching definition(s). That is a real gap: resolve it with the suite owner, never guess.
Note: *unused definitions* are the opposite — dead glue, reported not stopped, already excluded from
the packs.

**2. Scaffold** — **if `migration.json` exists, `init` already did this.** `package.json`,
`tsconfig.json`, `playwright.config.ts` and `node_modules` are in place and the browsers are
installed. VERIFY (`package.json` present? `node_modules/@playwright/test` present?) and move on.
Do NOT re-run `npm init`, do NOT re-install, and do NOT rewrite `playwright.config.ts` — it is
already written to the spec below, and overwriting it just puts back what you were going to add.
If you need something extra (a `baseURL` from the source config, a timeout), ADD it; don't replace
the file.

Only if there is NO package.json (the older manual flow) do you scaffold it yourself:
```
npm init -y && npm i -D @playwright/test playwright-bdd typescript @types/node && npx playwright install
```
**Certificate error on install?** (`self signed certificate in certificate chain`,
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`) That is a corporate TLS-inspecting proxy whose root CA sits in the
machine store, which Node does not read by default. NOT a kit problem, and NEVER to be worked around
by disabling TLS — no `strict-ssl false`, no `NODE_TLS_REJECT_UNAUTHORIZED=0`. Retry with the machine
store: `$env:NODE_OPTIONS="--use-system-ca"` (PowerShell, Node 22.15+), or `npm i --use-system-ca`
on npm 11+. Older Node → `npm config set cafile <path-to-proxy-root.pem>`, or upgrade; say so and
ask. (The kit auto-retries this for its OWN installs in `setup`; this scaffold install is yours.)
If an install exceeds your command timeout, ask the human to run it in a side terminal, then
continue.
`playwright.config.ts` uses `defineBddConfig({ features: "features/**/*.feature",
steps: ["steps/**/*.ts", "fixtures.ts"] })`. `init` writes exactly this; write it yourself only in
the no-package.json flow above.

**3. Abstraction layer + fixtures, ONCE (you)** — read `<WORK>/migration-packs/00_page_objects.md`
and `<KIT>/contracts/helper_contract_bdd.md`. Produce `pages/*.ts` and `fixtures.ts` from the DI
plan in that pack. Keep class/method names.

**4. One step-class pack at a time (you), gate after each** — follow `INDEX.md` order. The gate is
deterministic and costs 0 tokens, so run it after each pack rather than only at validate:
```
node <TESTNG_KIT>/tools/gate/parity_check_ast.mjs --oracles <WORK>/oracles.json \
     --generated <PW> --bdd
```
(Batched run? add `--scope <WORK>/migration-packs/batch.json`.) Two things to get right, because
both fail confusingly: `--oracles` takes the SHARED extractor's **oracles.json** (keyed by step-def
method), NOT the BDD kit's scenario-keyed `records.json` — passing the latter dies with "records is
not iterable". And `--generated` is `<PW>` itself, exactly as `validate` passes it — point it
somewhere narrower and the per-pack gate scores a different tree than validate does, so the two
disagree about your own code. For each pack:
- Write `steps/<name>.steps.ts`.
- **Tag every step definition** `// @source: <StepClass>.<method>` — exact format; the gate matches
  `[\w.]+`, so colons or spaces break it.
- Assert **every MUST-PIN** oracle listed in the pack. Re-derive computed values; never freeze.
- **Skip any method the pack lists under "DEAD methods — DO NOT translate".**
- Do not rewrite the `.feature` text; your step text must keep matching it.

**5. Validate (tool, 0 tokens)**
```
node <KIT>/tools/orchestrator/orchestrate_bdd.mjs validate \
  --kit <KIT> --testng-kit <TESTNG_KIT> --out <WORK> --pw <PW>
```
Runs the SHARED gate (`--bdd`) -> `npx bddgen` -> `npx tsc --noEmit` -> `npx playwright test`.
-> **HARD-STOP 2 (gate BLOCK)** — a must-pin was lost. **STOP AND ASK.** Read the SPECIFIC gate
line, diagnose it, propose the fix — but do NOT apply it until the human says so. Never
blind-regenerate.
   **Why this differs from HARD-STOP 3:** there, the fix cannot touch an oracle and the gate
   independently verifies it. Here the gate IS the complainant — an agent editing until its own
   grader goes quiet has no independent check, and "satisfy the matcher" is not "preserve the
   intent". A human breaks that loop; false BLOCKs are rare, so this costs a few stops, not dozens.
   If the note says **PHRASING-OR-LOSS** (the over-assertion shares tokens with the lost oracle;
   NOT the same thing as an AMBIGUOUS step binding, which is a hard stop at intake), the gate
   is saying it cannot tell faithful-but-oddly-phrased code from a genuine loss. Read the assertion
   against the source oracle, say which you think it is and why, and let the human decide. If
   faithful, the fix is to move the operation into the MATCHER (`expect(x).not.toHaveLength(0)`)
   rather than the subject (`expect(x.length > 0)`) — Java carries the operation in the subject,
   TypeScript in the matcher.
   **NEEDS-HUMAN is NOT a stop** — it means "look here", and is usually a cross-language matcher gap
   on correct code. Note it and keep going. Two kinds you will see:
   - *unscoreable oracle* — `assertEquals(actual, expected)`: generic names give the matcher no
     tokens, so it can never score it. Verify by eye; it is reported, never counted as lost.
   - *PHRASING-OR-LOSS* — an over-assertion shares tokens with an oracle the matcher could not
     align. (Different from an AMBIGUOUS step BINDING, which is an intake hard stop.) This
     is the same phrasing gap that causes a BLOCK, just on a derive oracle instead of a must-pin.
     Read the assertion against the oracle; if it is faithful you may move the operation into the
     matcher (`expect(x).not.toHaveLength(0)` rather than `expect(x.length > 0)`) and carry on —
     that is a phrasing change, not an intent change, so it is not a stop.

-> **HARD-STOP 3 (playwright fail)** — **default STOP.** First inspect WHERE: a step binding
(bddgen/step text), a page-object selector, or the app itself. Then apply the full rule in
"HARD-STOP 3 in detail" below — it defines the ONLY case in which you may fix and continue without
asking. Do not act on this line alone.

**6. Record as you go — MANDATORY before you run `report`.** The report renders two files from
`work/`; leaving them unwritten ships a deliverable that hides your fixes and judgment. You MUST
write both before reporting:
- `work/fixes.json` — a JSON array; one entry per HARD-STOP 3 interaction fix you applied:
  `{ "file", "change", "cause", "evidence", "assertionsTouched": false }`. `assertionsTouched`
  must be `false` (a HARD-STOP 3 fix never alters an assertion; the report flags `true` as a
  rule-2 violation). If you applied no fixes, write `[]`.
- `work/notes.json` — a JSON object with your judgment: `keyFix` (one-line summary, or ""),
  `attestation` `{ "attested", "baseline", "proceed" }` (what you confirmed at intake HARD-STOP 1),
  `localization` (your call on any hardcoded-string oracles), `verdictReasons`
  `{ "<test-or-stepdef-id>": "why this non-PASS gate row is not a loss" }` for each NEEDS-HUMAN row
  you eye-verified, `cycleReasons` (array; the failure reason per validate cycle), and `findings`
  (array of observations about the customer's system).
This is not optional cleanup — it is how the report captures what you did and decided.

**7. Report** — `node <KIT>/tools/orchestrator/orchestrate_bdd.mjs report --out <WORK>`

## Batching a large engagement — BY FEATURE
If the human asks for batches ("migrate in batches of 10 features", "do the checkout features
first"), pass it to `prepare`. **The batch unit is the FEATURE, never the step class** — a feature's
steps can span several step classes, so migrating a subset of classes leaves steps UNDEFINED and
bddgen fails. Only in-scope `.feature` files are copied; an uncopied feature cannot fail.

```
node <KIT>/tools/orchestrator/orchestrate_bdd.mjs prepare --kit <KIT> --testng-kit <TESTNG_KIT> \
     --suite <SUITE> --out <WORK> --pw <PW> --batch-size 10 --batch 1     # then --batch 2, ...
# translate the packs, then:
node <KIT>/tools/orchestrator/orchestrate_bdd.mjs validate --kit <KIT> --testng-kit <TESTNG_KIT> \
     --out <WORK> --pw <PW>
```

**EXTEND packs — the thing to get right.** One step class serves many features, with a DIFFERENT
subset of methods each. Tracking is therefore per METHOD. A pack headed
**"(EXTEND an existing step file)"** means an earlier batch already migrated some methods of that
class: **ADD the new step definitions to the existing file. Do NOT rewrite it, do NOT touch the
existing definitions** — earlier features depend on them and the gate re-verifies them every batch.

**ONE project, always.** Every batch's features and steps go into the SAME `<PW>` project. The
source was one suite; the migration is one suite. Features accumulate; they are never cleared.
`00_page_objects.md` + `fixtures.ts` are migrated ONCE, on batch 1; later batches say
"ALREADY MIGRATED — do NOT re-translate" and mean it.

**HARD-STOP 4 — batch checkpoint (exit 50, batched runs only).** A green batch with more remaining
stops for a human. NOT a failure. Report what was migrated and ask. Only chain with
`--auto-continue` if they said so.

**The ledger.** `migration-ledger.json` in `<WORK>` is the cross-batch record: which features and
which step-def METHODS went in which batch, prepared and validated timestamps, gate + playwright per
batch, and every skipped feature with its reason. It is the hand-off artifact for the whole
engagement, and it is what makes "already migrated" mean something. Never edit it by hand.

**Resuming.** Never guess: `orchestrate_bdd.mjs status --out <WORK>` reads that ledger and prints
every batch with dates and results, skipped features with reasons, and a literal
`RESUME HERE: prepare --batch K` line. If it says a batch was prepared but never validated, that
batch is unfinished — re-run it, don't skip past it.

**If prepare exits 3 — the FEATURE list drifted.** The suite gained or lost a .feature since the
ledger started, so batch boundaries have MOVED: some features would be migrated twice, others missed
silently. STOP and say so. Do NOT pass `--accept-drift` on your own judgement.

**Never hand-filter.** Do not translate "a subset" by picking packs yourself, and NEVER edit
`batch.json` or the ledger. The gate reads batch.json as `--scope`; if the manifest doesn't match
what you actually migrated, the report lies — and the report is the hand-off artifact. `validate`
picks up batch.json automatically.

**Vocabulary in the report:** *deferred* = a later batch (not a gap). *skipped* = deliberately
excluded, with a reason. *dead glue* = referenced by NO feature in the whole suite. *BLOCK* = a
must-pin lost in something migrated — the only real failure. A BLOCK on an EARLIER batch's method
means you broke something already green: fix it, don't re-scope around it.

**Full-suite runs (no batching)** — if they don't ask for batches, run the whole suite as the main
sequence describes: no `--batch-size`, no ledger, no checkpoint. Batching is opt-in.

## The hard-stops
1. Intake attestation (incl. UNBOUND/AMBIGUOUS steps). 2. Gate BLOCK. 3. Playwright failure — see
the rule below. 4. Batch checkpoint (batched runs only).
Everything else runs autonomously and is reported — including mechanical fixes (a tsconfig tweak, a
missing type import). Report them; don't stop for them.

### HARD-STOP 3 in detail — a Playwright scenario fails. Default: STOP.
Fix and continue WITHOUT stopping only when ALL THREE hold:
1. **You verified the cause empirically** — you probed the live page/file and confirmed it. Not
   "it's probably the selector."
2. **The fix changes only HOW the step interacts** — selector, wait, API semantics. The oracle's
   subject, relation, and expected value are UNTOUCHED. (And you never touch Gherkin at all.)
3. **You record it**: what failed, the evidence, the fix.

Any doubt → STOP. Specifically:
- **The assertion itself doesn't hold → ALWAYS STOP.** That is a real defect in the app, or a loss
  of intent in your translation. NEVER make a failing assertion pass by weakening it.
- Cause unconfirmed → STOP.
- The same fix pattern repeats across many scenarios → STOP; something systemic is wrong (wrong DI
  style, wrong base URL, wrong environment).

If the cause lies OUTSIDE your translation — the app, the data, the environment, the source suite —
**say so explicitly and prominently in your report**, even though you fixed around it. That is a
finding about the customer's system, not a migration detail.

**Why rule 2 is the load-bearing one.** The gate scores INTENT, not interaction — a wrong selector
that still passes is invisible to it. Two real examples from a validated run, both legitimate fixes
under this rule: `click_frames.html` is a legacy `<frameset>`, so Selenium's `By.name("source")`
matches a `<frame>` and a narrowed `iframe[name="source"]` matches nothing; and Playwright's
`hover()` enforces a pointer-interception check that Selenium's `Actions.moveToElement` never made,
so a deliberately-overlapped element needs `hover({ force: true })` to stay faithful. Both changed
HOW, neither touched an oracle.

These fixes are not unreviewed: they surface at HARD-STOP 4 (batch checkpoint) or in the final
report — reviewed in batch, with evidence, rather than one interruption at a time.

## Standing rules
- Never re-do in tokens what a script already did deterministically: the features are copied, the
  bindings are resolved, the oracles are extracted, the dead glue is excluded.
- Preserve every MUST-PIN oracle. Re-derive computed values; never freeze to a literal.
- DI -> fixtures per the contract. Driver-lifecycle hooks are DELETED (Playwright owns the browser);
  a screenshot-on-failure hook becomes `screenshot: 'only-on-failure'` in the config.
- Delete Selenium waits (Playwright auto-waits). Do not add sleeps.
- TLS: only mirror `ignoreHTTPSErrors` if the SOURCE deliberately relaxed certs — and report it.
- An UNBOUND step is a stop, never an invented step definition.


# ============================================================================
# PART 2 — THE TRANSLATION CONTRACT
# Everything above is HOW TO DRIVE the pipeline. Everything below is HOW TO TRANSLATE a
# single pack. In Claude Code these are two files (CLAUDE.md + a skill); this editor gets
# one instruction file, so both are here. Both apply.
# ============================================================================

# Translate Cucumber/Java/Selenium → playwright-bdd/TypeScript

You are translating ONE sliced pack (the abstraction layer + fixtures, or one step-definition class).
The deterministic tools already did the thinking: the `.feature` files are copied, the Gherkin↔method
bindings are resolved, the oracles are pinned, the dead glue is excluded. Your job is a faithful
translation — not to re-derive what to test.

## The one thing that is NOT your job
**Never write or edit Gherkin.** The `.feature` files are already in `<PW>/features`, copied verbatim
(0 tokens). Your step definitions must keep MATCHING their step text. If a step text seems wrong,
that is a finding for the human, not something to "fix" by editing the feature.

## Rules (the translation contract)
- **Step binding:** the pack's table gives the exact step text and the Java method. Java regex →
  cucumber-expression: `@When("^he searches for \"([^\"]*)\"$")` → `When("he searches for {string}", ...)`;
  capture groups → `{string}` / `{int}`. `@And`/`@But` do not exist in code — use the keyword the
  binder recorded (Given/When/Then).
- **Import Given/When/Then from `../fixtures`**, never from `@playwright/test` directly — they must
  come from `createBdd(test)` so the fixtures are injected.
- **DI → fixtures (built once in pack 00):** step classes lose their constructors entirely.
  `TestContext`/`PageObjectManager.getX()` → a named fixture per page object; `ScenarioContext` → a
  `scenarioContext` fixture; `DriverFactory.getDriver()` / `new XxxPage(driver)` → a page-object
  fixture over the built-in `page`. A step receives what it names:
  `When("...", async ({ demoPage }, arg) => {...})`. Code calling `getDriver().foo()` directly → `page.foo()`.
- **Hooks:** driver-lifecycle hooks (`@Before initDriver`, `@After quitDriver`) are **DELETED** —
  Playwright owns the browser. A screenshot-on-failure `@After` is **DELETED** — set
  `screenshot: 'only-on-failure'` in `playwright.config.ts`. Only genuine setup/teardown survives.
- **Page objects:** one TS class per Java page object, same class/method names.
  `constructor(private page: Page) {}`; UI methods `async`. No `PageFactory`.
- **Locators:** `By.id("x")`→`page.locator("#x")`; `By.cssSelector`→`page.locator(css)`;
  `By.xpath`→`page.locator("xpath=...")`; custom wrappers → resolve to the raw selector.
- **Waits — DELETE, don't port:** remove `WebDriverWait`, `wait.until`, `Thread.sleep`, retry loops.
  Playwright auto-waits. Keep `await expect(...).toBeVisible()` only where it was a real assertion.
- **Actions:** `click()`→`click()`; `sendKeys`/`clear()+sendKeys`→`fill()`; `getText()`→`innerText()`;
  `driver.get`/`navigate().to`→`page.goto(url)`; `Select.selectByVisibleText`→`selectOption({label})`.
- **Assertions — preserve every oracle in the pack:** `Assert.assertTrue(x.contains(y))` →
  `expect(x).toContain(y)`; `Assert.assertEquals(actual, expected)` → `expect(actual).toBe(expected)`;
  `Assert.assertEquals(list, exp)` → `toEqual`. Note TestNG order is `(actual, expected[, message])`
  — the message is the LAST arg, not the expected value.
  **MUST-PIN oracles are non-negotiable** — every one must appear or the gate BLOCKs.
  **Computed oracles must be re-derived in TS** (never freeze a computation to a literal).
  Preserve exact characters (curly quotes etc.) — the live app may match on them.
- **Params are feature data:** a step's params come from the `.feature` (step text, an Examples row,
  or a DataTable). That is why an oracle compared against one is a MUST-PIN. Keep the comparison.
- **DEAD methods:** if the pack lists methods under "DEAD methods — DO NOT translate", skip them.
  The source block is the whole class; only the methods in the step table are live.
- **Traceability — REQUIRED, exact format:** tag every step definition
  `// @source: <StepClass>.<method>` immediately above the `Given/When/Then` call. It must equal the
  oracle `id`. The gate matches `[\w.]+` — colons or spaces break it and the step reports as
  "no generated step definition".
- **TLS (conditional, reported):** add `ignoreHTTPSErrors: true` ONLY if the source relaxed cert
  validation. If the source verified certs, a TLS failure is a real finding — do not suppress it.
- **Do not:** edit a `.feature`; invent a step definition for an unbound step; invent assertions the
  pack doesn't list; drop a MUST-PIN; freeze a computed value; add sleeps.

## Shape of a generated step file
```ts
import { Given, When, Then } from "../fixtures";
import { expect } from "@playwright/test";

// @source: FrameWindowSteps.validateNewTabUrl
Then("New tab should open with URL {string}", async ({ demoPage }, expectedUrl: string) => {
  const actualUrl = await demoPage.getCurrentUrl();
  expect(actualUrl).toContain(expectedUrl);      // MUST-PIN [external] — from the .feature
});
```

## If the engagement is batched
The packs in `migration-packs/` ARE the batch — translate all of them, nothing else. A step class
with no pack needs nothing from you this batch; that is not an omission to correct, and you must not
go hunting in the source for step classes without packs.

A pack headed **"(EXTEND an existing step file)"** means an earlier batch already migrated some
methods of that class — one step class commonly serves several features with different method
subsets. **ADD the step definitions in this pack to the existing file. Do NOT rewrite it, and do NOT
touch the definitions already there**: earlier features depend on them, and the gate re-verifies them
on every batch, so breaking one is a BLOCK on work that was already green.

Pack 00 (page objects + `fixtures.ts`) is migrated ONCE, on the first batch. On later batches it is
headed "ALREADY MIGRATED — reference only": do not re-translate it. Regenerating it would rewrite
files every earlier step file depends on.

## After writing a pack
Run the shared gate in BDD mode (deterministic, 0 tokens):
`node <TESTNG_KIT>/tools/gate/parity_check_ast.mjs --oracles <WORK>/oracles.json --generated <PW> --bdd`
BLOCK on your file = a must-pin was lost; fix that specific oracle, don't regenerate. Then
`npx bddgen` → `npx tsc --noEmit` → `npx playwright test` are the runtime authority.
