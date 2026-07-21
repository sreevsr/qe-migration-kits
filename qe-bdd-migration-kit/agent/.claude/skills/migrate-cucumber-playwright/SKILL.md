---
name: migrate-cucumber-playwright
description: Translate one Cucumber+Java+Selenium unit (the abstraction layer, or one step-definition class) to playwright-bdd + TypeScript, preserving the extractor's pinned oracles. Use when translating a BDD migration pack.
---

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
