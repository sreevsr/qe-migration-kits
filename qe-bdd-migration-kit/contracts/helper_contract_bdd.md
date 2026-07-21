# Helper Contract — Cucumber/Java/Selenium → Playwright-BDD/TypeScript

The fixed translation contract for the BDD kit. Following it keeps generated step-defs consistent
and cuts tokens. Extends the TestNG kit's page-object/assertion rules with BDD-specific mappings.

## 1. Feature files — carry over, near-verbatim
- Copy each `.feature` file across unchanged EXCEPT: the runner/glue config is dropped (it lives in
  `playwright.config.ts` via `defineBddConfig`), and tags stay as-is (`@SmokeTest`).
- `Scenario Outline` + `Examples` tables carry over unchanged — playwright-bdd runs them the same way.
- `Background:` carries over **and playwright-bdd runs it before each scenario natively** — but its
  step definitions MUST still be translated (they're where the page gets opened). An unbound
  background step is a hard-stop like any other.
- `DataTable`s and `DocString`s carry over (see §4).

## 2. Step binding — regex → cucumber-expression
| Cucumber (Java)                              | Playwright-BDD (TS)                     |
|----------------------------------------------|-----------------------------------------|
| `@When("^he searches for \"([^\"]*)\"$")`    | `When("he searches for {string}", ...)` |
| `@Given("^user is on hom page$")`            | `Given("user is on hom page", ...)`     |
| capture group `([^\"]*)` / `(\\d+)`          | `{string}` / `{int}` parameter          |
| `@And` / `@But`                              | there is no And/But in code — use the keyword the step BINDS to (Given/When/Then) as recorded in records.json |
- Preserve the exact step TEXT so the step matches the carried-over `.feature`. The binder records
  which keyword each step actually bound to; use that, not the Gherkin `And`/`But`.

## 3. DI → Playwright fixtures (the core structural change)
Implement `fixtures.ts` ONCE from the DI plan in pack 00:
| Java (Cucumber + PicoContainer)              | Playwright-BDD                          |
|----------------------------------------------|-----------------------------------------|
| `DriverManager` / `WebDriver` (per scenario) | built-in `page` fixture (free)          |
| `PageObjectManager.getHomePage()` (lazy)     | a `homePage` fixture: `async ({page}, use) => use(new HomePage(page))` |
| `ScenarioContext` (between-steps K/V)        | a `scenarioContext` fixture (one per scenario) |
| `TestContext` (holds the above)              | dissolved — steps receive named fixtures |
| constructor `Steps(TestContext ctx)`         | standalone step fns: `When(..., async ({ homePage }, arg) => {...})` |
- Export `Given/When/Then` from `createBdd(test)` where `test` is the extended fixture. Step files
  import these, NOT from `@playwright/test` directly.

## 4. Data & tables
- `FileReaderManager`/`JsonReader`/POJO test-data → a TS reader (`fs` + `JSON.parse`) with the same
  lookup methods; keep the same data files.
- Cucumber `DataTable` param → playwright-bdd's `DataTable` arg. `DocString` → a string arg.
- `Scenario Outline` `<placeholders>` are handled by the `.feature`; the step fn just receives the
  bound param.

## 5. Hooks
- **Driver-lifecycle hooks are DELETED** (`@Before initDriver()`, `@After quitDriver()`) — Playwright
  owns the browser lifecycle. Do not port them.
- **Screenshot-on-failure `@After` → DELETED**; set `screenshot: 'only-on-failure'` in
  `playwright.config.ts` instead (Playwright does this natively).
- Genuine setup/teardown hooks → playwright-bdd fixtures or `Before`/`After` from `createBdd`.
- Tagged hooks (`@Before("@Third")`) → tag-scoped hooks/fixtures. NOTE: verify the exact
  playwright-bdd tag-scoping API against its current docs before relying on it.
- Two hook classes can share a simple name across packages (seen in the wild) — key them by FILE.

## 6. Page objects, actions, waits, assertions — SAME as the TestNG kit
- POM class per Java page object, same names; `constructor(private page: Page)`; methods `async`.
- Locators: `By.x` → `page.locator(...)`. Actions: `click`/`sendKeys`→`click`/`fill`; `getText`→
  `innerText`. `driver.get`/`navigate().to` → `page.goto`.
- **Waits DELETED** (auto-waiting); retry loops removed.
- **Assertions — preserve every oracle**: `Assert.*` and `assertThat(...)` → `expect(...)`.
  MUST-PIN oracles are non-negotiable; **computed values re-derived, never frozen**; preserve exact
  characters (curly quotes, etc.).

## 7. Traceability — the @source tag (REQUIRED, exact format)
Tag every generated step definition with the Java step-def method it came from:

```ts
// @source: FrameWindowSteps.validateNewTabUrl
Then("New tab should open with URL {string}", async ({ demoPage }, expectedUrl: string) => {
  ...
});
```

- Format is exactly `// @source: <StepClass>.<method>` — it must equal the `id` in the oracles file.
  The gate matches on `[\w.]+`, so colons/spaces break it and the step reports as "no generated
  step definition (check @source tag)".
- The comment goes IMMEDIATELY above the `Given/When/Then` call.
- Gherkin tags need no work — they ride along in the carried-over `.feature`.

## 8. What NOT to do
- Don't rewrite the `.feature` text (it must keep matching the step definitions).
- Don't drop a MUST-PIN oracle or freeze a computed value.
- Don't silently invent a step definition for an UNBOUND step — that's a gate BLOCK / human review.
- Don't add explicit waits/sleeps. Don't relax TLS unless the source did (same rule as TestNG kit).
