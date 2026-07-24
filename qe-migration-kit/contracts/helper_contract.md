# Helper Contract — Selenium/Java/TestNG → Playwright/TypeScript

This is the fixed translation contract. Following it keeps every generated spec consistent and
cuts token use: the agent translates against known rules instead of re-deciding each time.

## 1. Project & Page-Object structure
- One TS page-object class per Java page object. **Keep the same class and method names** so the
  generated specs (and the parity gate) line up with the extracted oracles.
- Constructor takes `page: Page`. Store it: `constructor(private page: Page) {}`.
- Methods that returned `this` (fluent) → keep returning `this`. Methods that returned another
  page object → return an instance of the migrated page object. All UI methods are `async`.

## 2. Locators
| Selenium (Java) | Playwright (TS) |
|---|---|
| `driver.findElement(By.id("x"))` | `page.locator("#x")` |
| `By.cssSelector("...")` | `page.locator("...")` |
| `By.xpath("//...")` | `page.locator("xpath=//...")` |
| `By.name("x")` | `page.locator("[name='x']")` |
| a custom `LocatorUtil.by(...)` wrapper | resolve it to the underlying selector, then `page.locator(...)` |

## 3. Waits — DELETE them, don't translate them
Playwright auto-waits. Remove explicit waits and the retry/`Thread.sleep` loops entirely.
| Selenium | Playwright |
|---|---|
| `WaitUtil.waitForVisible(el)` / `wait.until(visibilityOf(...))` | just act on the locator; add `await expect(locator).toBeVisible()` only if it was an explicit assertion |
| `Thread.sleep(...)`, retry loops in getters | delete; use auto-waiting |
| `waitForUrlContains("/x")` | `await expect(page).toHaveURL(/x/)` (only if it was asserting) |

## 4. Actions
| Selenium | Playwright |
|---|---|
| `el.click()` | `await page.locator(sel).click()` |
| `el.sendKeys("t")` / `type(...)` | `await page.locator(sel).fill("t")` |
| `el.getText()` | `await page.locator(sel).innerText()` (or `.textContent()`) |
| `driver.get(url)` / `load()` | `await page.goto(url)` |
| `Select(...).selectByVisibleText(t)` | `await page.locator(sel).selectOption({ label: t })` |

## 5. Assertions — preserve EXACTLY the oracles in the pack
Use Playwright's `expect`. Map by intent, and **every MUST-PIN oracle must appear**:
| TestNG | Playwright |
|---|---|
| `Assert.assertEquals(actual, "text")` | `expect(await locator.innerText()).toBe("text")` or `await expect(locator).toHaveText("text")` |
| `Assert.assertEquals(a, b)` where b is computed | compute b in TS the SAME way and `expect(a).toBe(b)` — never hard-code the result (that is a "frozen literal" the gate rejects) |
| `Assert.assertTrue(x.contains(y))` | `expect(x).toContain(y)` / `await expect(locator).toContainText(y)` |
| `Assert.assertTrue(cond)` | `expect(cond).toBeTruthy()` |
| `Assert.assertEquals(list, expectedList)` | `expect(actualList).toEqual(expectedList)` |
- A `computed` oracle (e.g. `"Search results: " + searchFor`, `subtotal.add(tax)`) MUST be
  re-derived in TS. A frozen numeric/string literal in place of a computation will BLOCK.
- Preserve exact characters (e.g. curly quotes) — the live app may match on them.

## 6. Data providers → parameterized specs
A `@Test(dataProvider=...)` with N rows → a `for (const row of ROWS) test(\`...${row}\`, ...)`
loop that emits **one `test()` per row**, each with its own `page` — do NOT run all rows in one
shared session (that loses per-row isolation; the gate flags it as a data-row-loop smell).

## 7. API-driven setup → Playwright request context
Some suites set up state via REST (RestAssured) then inject cookies. Translate:
| Java | Playwright |
|---|---|
| `RestAssured.given()...post(url)` / `CartApi.addToCart(...)` | `const res = await request.post(url, { data, headers })` using `APIRequestContext` |
| `JacksonUtils.deserialize/serialize` | plain JS objects / `JSON.parse` / `JSON.stringify` |
| `injectCookiesToBrowser(cookies)` | `await context.addCookies(cookiesArray)` before `page.goto` |
- Read the base URL / credentials from `process.env` (see §10), never a hard-coded literal. Keep the API calls as setup in a
  `beforeEach` or a fixture, mirroring the Java `@BeforeMethod`.
- **TLS / certificate validation (fidelity rule — conditional, and must be reported):** add
  `ignoreHTTPSErrors: true` to a Playwright request context ONLY IF the Java source deliberately
  relaxed cert validation — e.g. RestAssured's default leniency, `relaxedHTTPSValidation()`, or a
  trust-all `SSLContext`. In that case the source never verified certs, so mirroring it preserves
  source behavior. When you do this, **flag it in the migration report**: "relaxed TLS validation in
  N request context(s), mirroring the source's RestAssured config — confirm acceptable for the
  target environment." Do NOT add `ignoreHTTPSErrors` when the source verified certificates
  normally: there, a TLS failure is a REAL finding (expired/broken chain, MITM) and must surface as
  a hard-stop, never be suppressed. The trigger is "the source didn't verify certs", not "a TLS
  error occurred" — never use this flag just to make an error go away.

## 8. Traceability (helps the gate)
- Tag each generated `test()` with a leading comment `// @source: Class.method` matching the
  oracle id. The gate uses this to map specs back to oracles. This is required.
- Preserve TestNG `groups` as Playwright tags in the title, e.g. `test("... @search @regression", ...)`.

## 9. What NOT to do
- Do not invent assertions the oracles don't list (the gate flags untraced over-assertions).
- Do not drop a MUST-PIN oracle (the gate BLOCKs).
- Do not freeze a computed value to a literal.
- Do not add explicit sleeps/waits.
- Do not write a secret value into any committed file (see §10).

## 10. Secrets & environment config — from process.env, never a committed file
Credentials, tokens, and base URLs are ENVIRONMENT config, not code. The kit scaffolds the
pattern (a gitignored `.env`, `dotenv` loaded in `playwright.config.ts`); use it — do not invent
a place for secrets.
- Read every credential/token/secret from `process.env.X`. NEVER write a secret value into a
  committed file — not `config.ts`, not a spec, not `playwright.config.ts`. A literal secret in a
  tracked file is the defect this rule exists to prevent.
- For each secret the source uses, add its KEY (no value) to `.env.example` so the next person
  knows what to set. `.env.example` is committed; `.env` holds the real values and is gitignored.
- A hard-coded fallback is allowed ONLY for values that are genuinely public and non-sensitive
  (e.g. a demo suite's public login): `process.env.SAUCE_USERNAME ?? "standard_user"`. Never fall
  back to a real credential.
- Non-secret config (baseURL, timeouts) may live in `playwright.config.ts`. A `config.ts` is fine
  ONLY if it reads from `process.env` — never if it holds literal secrets.