---
name: migrate-selenium-playwright
description: Translate one Java+Selenium+TestNG unit (page objects or a test class) to Playwright+TypeScript, preserving the extractor's pinned oracles. Use when translating a migration pack.
---

# Translate Selenium/Java → Playwright/TypeScript

You are translating ONE sliced pack (page objects, or one test class) to Playwright+TypeScript.
The extractor already pinned the intent as oracles in the pack — your job is a faithful translation,
not to re-derive what to test.

## Rules (the translation contract)
- **Structure:** one TS page-object class per Java page object; keep the same class and method
  names so specs and the parity gate line up. Constructor `constructor(private page: Page) {}`.
  Fluent `return this` stays; page-transition methods return the migrated page object; UI methods `async`.
- **Locators:** `By.id("x")`→`page.locator("#x")`; `By.name("x")`→`page.locator("[name='x']")`; `By.cssSelector`→`page.locator(css)`;
  `By.xpath`→`page.locator("xpath=...")`; custom locator wrappers → resolve to the raw selector.
- **Waits — DELETE, don't port:** remove `WebDriverWait`, `wait.until`, `Thread.sleep`, and
  retry/stale-element loops. Playwright auto-waits. Keep an `await expect(...).toBeVisible()` only
  where it was an actual assertion. `waitForUrlContains("/x")`→`await expect(page).toHaveURL(/x/)` (only if it was asserting).
- **Actions:** `click()`→`click()`; `sendKeys`/`clear()+sendKeys`→`fill()`; `getText()`→
  `innerText()`; `driver.get`/`load()`→`page.goto(url)`; `Select.selectByVisibleText`→
  `selectOption({label})`.
- **Assertions — preserve every oracle in the pack:** `assertEquals(a,"t")`→`expect(a).toBe("t")`
  or `toHaveText`; `assertTrue(x.contains(y))`→`expect(x).toContain(y)`/`toContainText`;
  `assertEquals(list,exp)`→`toEqual`; `assertTrue(cond)`→`expect(cond).toBeTruthy()`. **MUST-PIN oracles are non-negotiable** — every one must
  appear or the gate BLOCKs. **Computed oracles must be re-derived in TS** (build the expected value
  the same way; never freeze a computation to a literal). Preserve exact characters (e.g. curly
  quotes `“ ”`) — the live app may match on them.
- **Data providers → parameterized tests:** `@Test(dataProvider=...)` with N rows → a loop that
  emits one `test()` per row, each with its own `page` (do not share one session across rows). Test data files → a `test-data/` folder at the project root (not inside `tests/`), read relative to root.
- **API-driven setup → Playwright request context:** RestAssured calls → `request.post(url,{form,
  headers})` via `APIRequestContext`; Jackson (de)serialize → plain JS/JSON; cookie injection →
  `context.addCookies(...)` before `page.goto`; keep distinct request contexts if the Java used
  distinct cookie jars. Keep the API calls as setup in a `beforeEach` or fixture, mirroring the Java `@BeforeMethod`.
- **Secrets & config:** credentials, tokens, and base URLs come from `process.env.X` — NEVER
  write a secret into a committed file (`config.ts`, a spec, or `playwright.config.ts`). Add each
  key (no value) to `.env.example`; a hard-coded fallback is allowed only for genuinely public
  values (e.g. a demo login). Full rule: contract §10.
- **TLS (conditional, reported):** add `ignoreHTTPSErrors: true` to a request context ONLY if the
  source relaxed cert validation (RestAssured default, `relaxedHTTPSValidation()`, trust-all SSL) —
  this mirrors source behavior. Report it as a deliberate fidelity choice. If the source verified
  certs normally, do NOT add it — a TLS failure there is a real finding for a hard-stop, not
  something to suppress.
- **Traceability:** tag each generated `test()` with `// @source: Class.method` matching the oracle
  id; carry TestNG `groups` as `@tag`s in the title.
- **Do not:** invent assertions the pack doesn't list; drop a MUST-PIN; freeze a computed value;
  add explicit sleeps/waits.

## If the engagement is batched
The packs in `migration-packs/` ARE the batch — translate all of them, nothing else. Classes not in
this batch have no pack on purpose (deferred or skipped); that is not an omission to correct. Do not
go looking in the source repo for tests without packs.

## After writing a spec
Run the parity gate (deterministic, 0 tokens). If it reports BLOCK on your spec, a must-pin was
lost — fix that specific oracle. If NEEDS-HUMAN, review the line (often a cross-language matcher
gap on correct code) but keep going. Then `tsc --noEmit` and `playwright test` are the runtime
authority.
