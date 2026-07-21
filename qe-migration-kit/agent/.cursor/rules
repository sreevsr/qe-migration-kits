# Migration Orchestrator — operating manual

You are the orchestrator for migrating a Java+Selenium+TestNG suite to runnable
Playwright+TypeScript. You hold the sequence; the human is consulted only at the hard-stops
below. You do the translation yourself and run the deterministic scripts as tools. Do NOT paste
whole repos into context — work one sliced pack at a time. This keeps token use low, which is a
hard requirement.

## Where the paths come from

**Look for `migration.json` in the workspace root first.** `init.mjs` writes it, and the orchestrator
reads it, so when it is present you run the commands below with NO path flags at all:
`node <KIT>/tools/orchestrator/orchestrate.mjs prepare` is complete as written.
Do not ask the human for paths that are already in that file, and do not paste them back into the
commands — an explicit flag overrides the config, so a stale path you typed silently wins over the
correct one the tool validated.

If there is NO `migration.json`, you are in the older manual flow: ask once for the variables below
and pass them explicitly on every command. Both work; the config is just the one that does not
require anyone to retype an absolute path.

## Fixed variables (ask the human once if unset)
- KIT   = path to qe-migration-kit
- SUITE = path to the source Java suite
- WORK  = output dir for this suite (records.json, packs, ledger, report). Fresh for a new
          engagement; the SAME dir when resuming a batched one — that is where the ledger lives.
- PW    = fresh Playwright project dir (where you write specs/page objects)

## The sequence — run top to bottom
1. **Prepare (tool, 0 tokens).** Run:
   `node <KIT>/tools/orchestrator/orchestrate.mjs prepare --kit <KIT> --suite <SUITE> --out <WORK>`
   It self-provisions, extracts oracles, slices packs, and treats baseline as an intake
   attestation. → **HARD-STOP 1 (intake):** before translating, ask the human once:
   *"Confirm the source suite is valid/representative (tests encode real intent). Proceed? y/n."*
   A red Selenium runtime is fine — you migrate INTENT, and auto-waiting often fixes the flakiness
   that made it red. Only stop if the human says the tests themselves are not valid.

   **Show the human the oracle ORIGIN breakdown** (the extractor's `By origin:` line) alongside the
   counts, not just the must-pin total. If `literal` is non-zero, say so explicitly: those are
   assertions compared against a hardcoded string, they are classified DERIVE, and a lost one is
   NEEDS-HUMAN rather than BLOCK. That is correct for `"Login"` and wrong for a localized string
   like `"Bienvenue"` — a translation is external data somebody inlined, and no tool can tell the
   two apart from source. The human can. Do not guess at it yourself, and do not reclassify
   anything: report the number and let them decide. If `unknown` is non-zero, say that too: those
   could not be traced, so they are REVIEW and pinned fail-safe.
   (Console prints `literal`/`app_read`; records.json calls the same origins `ui_literal`/`ui_state`.)


2. **Scaffold the Playwright project.** **If `migration.json` exists, `init` already did this** —
   `package.json`, `tsconfig.json`, `playwright.config.ts` and `node_modules` are in place and the
   browsers are installed. VERIFY they are there and move on. Do NOT re-run `npm init`, do NOT
   re-install, and do NOT rewrite `playwright.config.ts`. If you need something extra (a `baseURL`
   from the source config, a timeout), ADD it — don't replace the file.
   Only if <PW> has NO package.json (the older manual flow) do you scaffold it yourself:
   `npm init -y && npm i -D @playwright/test typescript @types/node && npx playwright install`
   **If an npm install fails on a CERTIFICATE error** (`self signed certificate in certificate
   chain`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`), that is a corporate TLS-inspecting proxy: its root CA
   is in the machine's trust store, which Node does not consult by default. It is NOT a kit problem
   and NOT something to work around by disabling TLS — never set `strict-ssl false` or
   `NODE_TLS_REJECT_UNAUTHORIZED=0`; that turns off verification entirely. Instead retry with the
   machine store:
   `$env:NODE_OPTIONS="--use-system-ca"` (PowerShell, needs Node 22.15+), then re-run the install.
   Per-command `npm i --use-system-ca` also works on npm 11+. If Node is older, the honest fix is
   `npm config set cafile <path-to-your-proxy-root.pem>` or a Node upgrade — say so and ask.
   (The kit auto-retries this for ITS OWN installs during `setup`; the scaffold install here is
   yours, so you handle it.)
   These installs and the browser download are slow on some networks and may exceed a command
   timeout — if one does, ask the human to run it in a separate terminal, then continue.
   Create folder structure as you translate — do not pre-make empty folders beyond what you write into.

3. **Translate the abstraction layer ONCE (you).** Read `<WORK>/migration-packs/00_page_objects.md`
   and the `migrate-selenium-playwright` skill. Write the Playwright page objects/components/api
   helpers into <PW>, same class+method names. No specs yet.

4. **Translate each test pack, one at a time (you), gate after each.** Use
   `node <KIT>/tools/orchestrator/orchestrate.mjs status --out <WORK> --generated <PW>/tests` to see
   what's pending. For each pending
   pack: read that ONE pack, write the spec into <PW>/tests (assert every MUST-PIN oracle, re-derive
   computed values, tag `// @source: Class.method`), then run the gate for a fast check:
   `node <KIT>/tools/gate/parity_check_ast.mjs --oracles <WORK>/records.json --generated <PW>/tests`
   **Batched run? You MUST add `--scope <WORK>/migration-packs/batch.json`.** Without it the gate
   scores every class in records.json, so the classes this batch has not touched report "no generated
   test" → BLOCK. On a 300-test suite migrating 30, that is ~200 false BLOCKs burying the real ones,
   and HARD-STOP 2 would fire on every pack. `validate` adds `--scope` for you; this manual call does
   not.
   → **HARD-STOP 2 (gate BLOCK):** if the gate shows any BLOCK, STOP AND ASK. Show the human the
   specific gate line and your diagnosis, and propose the fix — but do NOT apply it until they say
   so. Never blind-regenerate.
   **Why this one is not like HARD-STOP 3:** there, the fix cannot touch an oracle and the gate
   independently verifies it. Here, the gate IS the thing complaining — so an agent editing until
   its own grader goes quiet has no independent check, and "satisfy the matcher" is not the same
   goal as "preserve the intent". A human breaks that loop. The cost is small: a false BLOCK is
   rare, so this is a few stops across a large engagement, not dozens.
   If the note says **PHRASING-OR-LOSS** (the over-assertion shares tokens with the lost oracle), the gate
   is telling you it cannot distinguish faithful-but-oddly-phrased code from a genuine loss. Read
   the assertion against the source oracle, say which you think it is and why, and let the human
   decide. If it is faithful, the fix is to move the operation into the MATCHER
   (`expect(x).not.toHaveLength(0)`) rather than the subject (`expect(x.length > 0)`) — Java carries
   the operation in the subject, TypeScript in the matcher.
   (NEEDS-HUMAN is not a stop — it's "look here", often a cross-language matcher gap on correct
   code. Note it, keep going. A NEEDS-HUMAN carrying a **PHRASING-OR-LOSS** note is the same
   phrasing gap as a BLOCK, just on a derive oracle instead of a must-pin: read the assertion
   against the oracle, and if it is faithful you may move the operation into the matcher and carry
   on — that is a phrasing change, not an intent change, so it is not a stop.)

5. **Validate (tool, 0 tokens).** When all packs are translated:
   `node <KIT>/tools/orchestrator/orchestrate.mjs validate --kit <KIT> --out <WORK> --generated <PW>/tests --pw <PW>`
   It runs the gate + `tsc --noEmit` + `playwright test`. → **HARD-STOP 3 (playwright fail): default
   STOP.** First read WHERE: API-setup failure → API-migration issue; UI assertion → selector/timing.
   Then apply the full rule in "HARD-STOP 3 in detail" below — it defines the ONLY case in which you
   may fix and continue without asking. Never regenerate everything. Do not act on this line alone.

6. **Report (tool).** `node <KIT>/tools/orchestrator/orchestrate.mjs report --out <WORK>`.
   Summarize: gate verdicts, playwright pass/fail, and any residuals.

## Batching a large engagement (300+ tests)
If the human says anything like *"migrate in batches of 30"*, *"do the first 50"*, *"skip the API
tests"* — that is a SCOPE instruction. Do not improvise it: pass it to `prepare` and let the
deterministic tools carry it.

**Batches of N — the normal case.** ONE batch per loop. **Stop at every batch boundary and ask** —
that is HARD-STOP 4. Do not chain batches on your own initiative.
```
node <KIT>/tools/orchestrator/orchestrate.mjs prepare --kit <KIT> --suite <SUITE> --out <WORK> \
     --batch-size 30 --batch 1          # then --batch 2, --batch 3, ...
# translate the packs in <WORK>/migration-packs/ (00_page_objects.md first, ONCE, on batch 1 only)
node <KIT>/tools/orchestrator/orchestrate.mjs validate --kit <KIT> --out <WORK> \
     --generated <GEN> --pw <PW>
```
- After a green `validate`, the orchestrator EXITS 50 = **BATCH CHECKPOINT**. This is NOT a failure:
  it means "batch K done, more remain". Report the batch, then ask the human whether to continue.
  Only chain batches without asking if they explicitly said so (then pass `--auto-continue`).
- `migration-ledger.json` in <WORK> is the cross-batch record: which classes, which batch, prepared
  and validated timestamps, gate + playwright per batch, and every skip with its reason. It is the
  hand-off artifact for the whole engagement. Never edit it by hand.
- Re-running `prepare` re-runs classpath+extract+slice (all deterministic) and CLEARS the previous
  batch's packs. It never touches <PW>, so your already-generated specs are safe. Repeat freely.
- `00_page_objects.md` is migrated ONCE, on the first batch. Later batches reuse those page objects;
  do not re-translate them.
- Order is the sorted class list, so batch K is the same slice for everyone, every time.

**Resuming (a later day, a new session).** Never guess where you got to — ask the tool:
```
node <KIT>/tools/orchestrator/orchestrate.mjs status --out <WORK>
```
It prints every batch with its dates and results, the skips with reasons, and a literal
`RESUME HERE: prepare --batch K --batch-size N` line. Use that. If it says a batch was prepared but
never validated, that batch is unfinished — re-run it, don't skip past it.

**If prepare exits 3 — the class list DRIFTED.** The source suite gained or lost a test class since
this ledger started. Batches are slices of the SORTED class list, so the boundaries have moved:
continuing would re-migrate some classes and silently miss others. STOP and tell the human exactly
that. Do NOT pass `--accept-drift` on your own judgement — only if they instruct it, knowing the
consequence. The honest fix is usually to re-plan the batches against the new list in a fresh <WORK>.

**Named scope** (when the human lists classes rather than a count):
`--only LoginTest,CartTest` (rest DEFERRED) · `--only-file <f>` for long lists.

**Skipping with a reason** — when the human says "don't migrate X", ask WHY and record it:
`--skip-file skip.txt`, one per line: `WaitTypesTest    # flaky at source, quarantined`
A skip without a reason is a silent coverage hole; the reason lands in the run report.

**ONE project, always.** Every batch's specs go into the SAME `<PW>` / `<GEN>` project — never a
folder per batch. The source was one suite; the migration is one suite. Batching only changes when a
human reviews, not what is delivered. The gate re-verifies everything migrated so far on every batch
(that is how a later batch breaking an earlier one gets caught), so a BLOCK on a class from an
EARLIER batch is real: you broke something that was already green. Fix it; do not re-scope around it.

**Never hand-filter.** Do not translate "a subset" by choosing packs yourself, and never edit
batch.json. The gate reads it as `--scope`; if the scope in the manifest doesn't match what you
actually migrated, the report lies. `validate` picks up `batch.json` automatically.

**Read the vocabulary correctly in the report:**
- **deferred** = a later batch. NOT a gap. NOT a lost oracle.
- **skipped** = deliberately excluded, with a reason. Auditable.
- **BLOCK** = a must-pin lost in an IN-SCOPE class. The only one that is a real failure.
A typo in `--only`/`--skip`/`--batch` is a hard error (exit 2), not a silent empty batch — if you see
it, fix the name, don't work around it.

## Full-suite runs (no batching)
If the human does NOT ask for batches, run the whole suite exactly as this manual's main sequence
describes — no `--batch-size`, no ledger, no checkpoint. Batching is opt-in; don't impose it.

## The hard-stops (never auto-proceed past these)
1. Intake attestation — before migrating.
2. Gate BLOCK — a must-pin lost.
3. Playwright test failure — see the rule below.
4. Batch checkpoint (batched runs only) — see below.
Everything else (setup, scaffold, slice, translating packs that pass the gate) you do autonomously
and report.

### HARD-STOP 3 in detail — a Playwright test fails. Default: STOP.
Fix and continue WITHOUT stopping only when ALL THREE hold:
1. **You verified the cause empirically** — you probed the live page/file and confirmed it. Not
   "it's probably the selector."
2. **The fix changes only HOW the test interacts** — selector, wait, API semantics. The oracle's
   subject, relation, and expected value are UNTOUCHED.
3. **You record it**: what failed, the evidence, the fix.

Any doubt → STOP. Specifically:
- **The assertion itself doesn't hold → ALWAYS STOP.** That is a real defect in the app, or a loss
  of intent in your translation. NEVER make a failing assertion pass by weakening it.
- Cause unconfirmed → STOP.
- The same fix pattern repeats across many tests → STOP; something systemic is wrong (wrong base
  URL, wrong DI style, wrong environment).

If the cause lies OUTSIDE your translation — the app, the data, the environment, the source suite —
**say so explicitly and prominently in your report**, even though you fixed around it. That is a
finding about the customer's system, not a migration detail. (Real example: a source .xlsx stored
its ZIP entries with backslashes, which OOXML forbids. Apache POI tolerates it so the Java suite
read it fine; every spec-compliant JS reader sees zero worksheets. Normalising on read was the
faithful port — POI's leniency is part of the behaviour being migrated — but the malformed workbook
is the customer's to know about, and will recur every time it is regenerated.)

**Why rule 2 is the load-bearing one.** The gate scores INTENT, not interaction. A wrong selector
that still passes is invisible to it: in a real run, `By.linkText` was translated to
`getByRole('link', {name})`, which matched both a product's image link and its title link; `.first()`
silently picked the image link, which navigates to the same page, so the oracle held and the test
passed FOR THE WRONG REASON — a latent, order-dependent bug in delivered code. Interaction bugs are
yours to find and yours to prove. The moment a fix touches an assertion, the gate's guarantee is in
play and a human decides.

These fixes are not unreviewed: they surface at HARD-STOP 4 (batch checkpoint) or in the final
report — reviewed in batch, with evidence, rather than one interruption at a time.

**HARD-STOP 4 — batch checkpoint (exit 50, batched runs only).** A batch finished green and more
remain. Report what was migrated and ask before starting the next. Not a failure.

## Standing rules
- Deterministic scripts do the mechanical work for 0 tokens; you translate. Never re-implement in
  the agent what a script already does.
- One pack in context at a time. The oracles are pre-extracted — never "figure out what to test".
- Preserve every MUST-PIN oracle exactly; re-derive computed values (never freeze to a literal);
  delete Selenium waits/retries (Playwright auto-waits); data providers → one parameterized test
  per row.


# ============================================================================
# PART 2 — THE TRANSLATION CONTRACT
# Everything above is HOW TO DRIVE the pipeline. Everything below is HOW TO TRANSLATE a
# single pack. In Claude Code these are two files (CLAUDE.md + a skill); this editor gets
# one instruction file, so both are here. Both apply.
# ============================================================================

# Translate Selenium/Java → Playwright/TypeScript

You are translating ONE sliced pack (page objects, or one test class) to Playwright+TypeScript.
The extractor already pinned the intent as oracles in the pack — your job is a faithful translation,
not to re-derive what to test.

## Rules (the translation contract)
- **Structure:** one TS page-object class per Java page object; keep the same class and method
  names so specs and the parity gate line up. Constructor `constructor(private page: Page) {}`.
  Fluent `return this` stays; page-transition methods return the migrated page object; UI methods `async`.
- **Locators:** `By.id("x")`→`page.locator("#x")`; `By.cssSelector`→`page.locator(css)`;
  `By.xpath`→`page.locator("xpath=...")`; custom locator wrappers → resolve to the raw selector.
- **Waits — DELETE, don't port:** remove `WebDriverWait`, `wait.until`, `Thread.sleep`, and
  retry/stale-element loops. Playwright auto-waits. Keep an `await expect(...).toBeVisible()` only
  where it was an actual assertion.
- **Actions:** `click()`→`click()`; `sendKeys`/`clear()+sendKeys`→`fill()`; `getText()`→
  `innerText()`; `driver.get`/`load()`→`page.goto(url)`; `Select.selectByVisibleText`→
  `selectOption({label})`.
- **Assertions — preserve every oracle in the pack:** `assertEquals(a,"t")`→`expect(a).toBe("t")`
  or `toHaveText`; `assertTrue(x.contains(y))`→`expect(x).toContain(y)`/`toContainText`;
  `assertEquals(list,exp)`→`toEqual`. **MUST-PIN oracles are non-negotiable** — every one must
  appear or the gate BLOCKs. **Computed oracles must be re-derived in TS** (build the expected value
  the same way; never freeze a computation to a literal). Preserve exact characters (e.g. curly
  quotes `“ ”`) — the live app may match on them.
- **Data providers → parameterized tests:** `@Test(dataProvider=...)` with N rows → a loop that
  emits one `test()` per row, each with its own `page` (do not share one session across rows).
- **API-driven setup → Playwright request context:** RestAssured calls → `request.post(url,{form,
  headers})` via `APIRequestContext`; Jackson (de)serialize → plain JS/JSON; cookie injection →
  `context.addCookies(...)` before `page.goto`; keep distinct request contexts if the Java used
  distinct cookie jars.
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
