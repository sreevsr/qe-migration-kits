# QE Migration Kit — Selenium/Java → Playwright/TypeScript

Turn a Java + Selenium + TestNG test suite into a working Playwright + TypeScript
one — and **prove, mechanically, that no test quietly lost what it was checking.**

## Why this exists

There are two usual ways to migrate a test suite, and both have a catch.

*By hand* is accurate but slow — weeks to months — and when it's done, nobody can
prove test #147 still checks what it used to.

*Hand the whole thing to an AI* is fast to start and will attempt anything, but with
nothing holding it to a standard it silently drops assertions. You get green tests
that check **less** than they used to, and you can't tell by looking. That's the
dangerous failure: the suite passes, the coverage report looks fine, and the check
that would have caught the next bug is simply gone.

The real problem was never speed. It was **proof.**

This kit splits the job in two. About 90% of a migration is mechanical — find the
tests, list what each one checks, work out which checks are load-bearing, cut the
work into small pieces, verify the result. Deterministic tools do all of that, for
**zero AI cost** and with the same answer every time. Only the remaining ~10% —
actually rewriting Java into TypeScript — needs an AI, and it works on **one small
piece at a time**, against a fixed rulebook. Then a deterministic checker re-reads
both sides and confirms every check survived.

The AI never decides *what* to test. It only decides *how to say it in TypeScript.*

## The words this document uses

Skim these once; the rest of the README uses them freely.

| term | what it means |
|---|---|
| **oracle** | The part of a test that decides pass or fail — an assertion, plus what it's really checking. Not the clicks and waits around it. |
| **must-pin** | An oracle whose expected value comes from *outside* the app — a data file, a calculation. Nobody could re-derive it by looking at the page, so losing one **stops the migration**. |
| **derive** | An oracle whose value is a plain fact about the page (a button is visible, a list is non-empty). Kept and checked, but never blocks. |
| **REVIEW** | The reader couldn't trace where a value came from. Flagged for a human — **never** silently treated as safe. |
| **extractor** | The tool that reads the Java suite and writes down every test and every oracle. |
| **gate** | The tool that reads your generated Playwright and checks each oracle survived. No AI, no cost, same answer every time. |
| **verdict** | What the gate returns per test: **PASS** (every oracle found) · **NEEDS-HUMAN** (something to eyeball, not a failure) · **BLOCK** (a must-pin is missing — everything stops). |
| **pack** | One small unit of translation work — usually one test class — with just the source and the oracles to preserve. |
| **orchestrator** | The tool that runs everything in order, checks each result, and stops at the four hard-stops. |
| **hard-stop** | A point where the tools pause and a human decides. There are four (see §5). |
| **helper contract** | The fixed rulebook mapping each Java idiom to its Playwright equivalent. Ships with the kit; not written per customer. |
| **agent** | Your coding AI — Claude Code, Cursor, or GitHub Copilot — running in its "agent" mode. |

---

## Part 1 — The 60-second picture

```
   your Java/Selenium suite          this kit                    Playwright/TS
   ────────────────────────          ────────                    ─────────────
   LoginTest.java          ──►   extractor ──► records.json  ──►  the agent      ──►  login.spec.ts
   CheckoutTest.java             (lists every    (pinned            translates          checkout.spec.ts
   page objects...                oracle)         intent)           one pack,           page objects...
                                                                    then the GATE          │
                                                                    checks it ◄────────────┘
                                                                        │
                                                              PASS / NEEDS-HUMAN / BLOCK
```

Everything except the "agent translates" box is deterministic and free. The agent is
handed one small pack at a time, and the gate re-checks its work before moving on.

## Part 2 — Do it

### Step 1 — Install the prerequisites (once per machine)

The kit checks for these and stops with instructions if any is missing:

- **JDK 21 + Maven** — the extractor is Java, and it needs Maven to work out your
  suite's own dependencies.
- **Node 22.15+** — everything else (the slicer, the gate, the orchestrator, and
  Playwright itself) runs on Node. Node 18+ will run the kit, but 22.15+ is needed
  for the automatic corporate-certificate retry (see §7).
- **A coding agent** — **Claude Code** (works on a Claude Max plan, no API key), or
  **Cursor** / **GitHub Copilot** at a customer site.

After installing anything, open a **fresh terminal** — a changed PATH never reaches a
terminal that was already open.

### Step 2 — Set it up (one command, once per suite)

```
node <KIT>\tools\orchestrator\init.mjs --suite "C:\path\to\your-suite"
```

That's the whole setup — you never build the kit's tools by hand. `init` checks your
prerequisites, reads the suite and works out whether it's TestNG or BDD, creates the
migration folder (a Playwright project with a `work\` scratch dir inside), builds the
extractor and installs Playwright, drops the agent's instructions in, and — the point of
it — **writes every path into a small `migration.json` the tools read.** You never type
the four locations below: `init` works them out and validates them, because a tool can
check a path is real and a chat box can't.

The four locations, for when you read the config or use the manual path (Part 3):

- **KIT** — this kit's folder. *(Defaults to where the script lives.)*
- **SUITE** — your source Java suite (the folder with `pom.xml`).
- **WORK** — a scratch folder for this suite (`--out`); holds `records.json`, the packs,
  and the run report. Safe to delete and regenerate.
- **PW** — the Playwright project the migration produces (`--pw`); where the specs land.

> **Note on the baseline.** By default the kit does **not** run your old Selenium suite
> first — at hundreds of tests that's impractical, and aging Selenium is often flaky.
> Instead you (or the suite's owner) attest the tests are valid, and the kit migrates
> their *intent*. A red Selenium suite often migrates to a **green** Playwright one,
> because Playwright's auto-waiting fixes the flakiness that made it red.

### Step 3 — Say it (in your editor's agent mode)

```
Migrate the suite.
```

That's the instruction. The agent reads `migration.json`, extracts the oracles, slices
the work, translates the shared page objects once, then each test pack — running the gate
after every one — and finally validates and writes the report. It stops only at the four
hard-stops, the first being intake: it shows you the tests, oracles and must-pins found,
and waits for you to confirm before translating anything.

To review in stages: **Migrate the suite in batches of 30 classes.** To resume later:
**Continue the migration.**

**The agent is interchangeable.** `init` drops the right instruction file for your editor
— `.github/copilot-instructions.md` for Copilot, `.cursor/rules` for Cursor, `CLAUDE.md`
for Claude Code — and the tools, the rulebook, and the gate are identical in all three.
(There's also a manual CLI path with explicit flags — see Part 3 if you'd rather drive the
phases yourself.)

### Step 4 — Read the result

Three things tell you it worked:

- **`must-pin recovery X/Y`** — every irreplaceable check survived. Want X = Y.
- **`0 BLOCK`** — nothing was lost.
- **`playwright test` green** — it actually runs.

All three, or it isn't done. Full detail on reading the output is in §6.

---

## Part 3 — Reference

### The manual / CLI path

If you'd rather drive the deterministic phases yourself and translate in any agent
between them (`init` isn't required — these flags work standalone):

```
# setup only: check prerequisites, build the extractor, install tool dependencies
node <KIT>\tools\orchestrator\orchestrate.mjs setup   --kit <KIT>

# prepare: self-provision + extract + slice
node <KIT>\tools\orchestrator\orchestrate.mjs prepare  --suite <SUITE> --out <WORK>
#   --baseline-report <surefire.xml>  record existing results as evidence
#   --run-baseline [--browser CHROME]  soft check (won't hard-block on failures)
#   --no-setup                          skip self-provisioning

# translate (your agent): <WORK>\migration-packs\00_page_objects.md once, then each
#   test pack, following contracts\helper_contract.md, into <PW>\tests and page objects.

# status: what's translated vs pending
node <KIT>\tools\orchestrator\orchestrate.mjs status   --out <WORK> --generated <PW>\tests

# validate: gate + tsc --noEmit + playwright test
node <KIT>\tools\orchestrator\orchestrate.mjs validate --out <WORK> --generated <PW>\tests --pw <PW>

# report
node <KIT>\tools\orchestrator\orchestrate.mjs report   --out <WORK>
```

### §4b — Batching a large engagement

At 300+ tests you rarely migrate in one go — and a 300-test migration reviewed only at
the end isn't really reviewed. Batching turns it into a series of small, green, checked
deliveries. Two distinct, auditable states:

- **deferred** — not this batch, migrate later. `--only LoginTest,CartTest`
  (or `--only-file <f>`); everything else is deferred.
- **skipped** — deliberately excluded, **with a reason.** `--skip A,B` or
  `--skip-file <f>`, where the file records *why*:

```
# skip.txt
WaitTypesTest    # wait-util coverage is obsolete under Playwright auto-waiting
ApiTest          # API tests staying in Java (out of migration scope)
```

```
node <KIT>\tools\orchestrator\orchestrate.mjs prepare --suite <SUITE> --out <WORK> ^
     --only "LoginTest,CartTest" --skip-file skip.txt
```

Deferred and skipped classes cost zero tokens. A typo in `--only`/`--skip` is a hard
error, not a silent no-op.

**Why the gate must know the scope.** The gate scores every record in `records.json`.
Migrate 50 of 300 without telling it, and it reports "no generated test → BLOCK" for
the ~200 untouched classes, burying the real blocks and showing 17% recovery on a
perfect batch. With scope, those report DEFERRED/SKIPPED, drop out of the denominator,
and the report reads "migrated N of M; skipped K [reasons]."

**The ledger, resume, and drift**

- `migration-ledger.json` (in `--out`) is **append-only** across batches: per batch —
  the classes, the prepared/validated timestamps, the gate and Playwright results; plus
  every skip with its reason and date. `batch.json` is the *current* slice (overwritten
  each prepare); the ledger is the *history*.
- `status --out <WORK>` prints the whole engagement and a literal
  `RESUME HERE: prepare --batch K`.
- **Drift (exit 3):** batches are slices of the *sorted* class list. If the suite gains
  or loses a class mid-engagement the boundaries move — `--batch 4` would re-migrate
  some classes and silently skip others. The ledger fingerprints the list and refuses
  to continue. `--accept-drift` overrides knowingly (and is recorded).
- **Batch checkpoint (exit 50):** a green batch with more remaining stops for a human.
  Not a failure. `--auto-continue` chains unattended.
- Each prepare clears the previous batch's packs, so `migration-packs/` always matches
  its INDEX.
- **No `--batch-size` = no batching:** no ledger, no checkpoint, no drift check — the
  full-suite path is unchanged.

**One source suite in, ONE migrated suite out.** Batching is a *review cadence*, not a
split of the deliverable. `--out` is scratch (records, packs, ledger — packs are swapped
each batch). `--pw` is *the* migrated suite; every batch's specs accumulate into that one
project. Never make a project per batch.

Because of this the gate verifies the **whole** migrated suite as it grows: `batch.json`
carries `already_migrated` from the ledger, and the gate scores
`in_scope + already_migrated`. So a later batch that edits a shared page object — or
"tidies" an earlier spec — and drops an oracle from an earlier batch is a **BLOCK**.
Playwright would catch a runtime break; only the gate catches a silently weakened
assertion.

### §5 — The four hard-stops (where a human decides)

1. **Intake attestation** — before migrating: confirm the source tests are valid and
   representative. This is also where the oracle **origin breakdown** is shown — worth a
   look if the suite has localized text (see the note below).
2. **Gate BLOCK** — a must-pin oracle was lost. The agent diagnoses and proposes; a
   *human* decides. (The gate is its own complainant here — an agent editing until its
   grader goes quiet has no independent check, so a human must.) A BLOCK may carry a
   **PHRASING-OR-LOSS** note: the missing oracle has a near-match sharing its words, which
   is *either* faithful code phrased the TypeScript way (Java often puts the operation in
   the subject, `!x.isEmpty()`; TypeScript in the matcher, `.not.toHaveLength(0)`) *or* a
   real loss. The gate can't tell those apart and says so rather than guess — because
   widening its matching to cover every idiom is an endless list that loosens matching
   everywhere, and a false BLOCK costs one iteration while a masked loss ships a broken
   test. The same note on a NEEDS-HUMAN row is the identical gap on a *derive* oracle:
   same defect, lower severity.
3. **Playwright test failure** — default STOP, with one narrow exception (below).
4. **Batch checkpoint** (batched runs only, exit 50) — a green batch with more remaining.

Everything else — setup, scaffolding, slicing, translating packs that pass the gate,
and mechanical fixes like a tsconfig tweak — runs on its own and is reported.

**The hard-stop 3 exception, and why it exists.** The agent may fix a failing test and
continue *without* stopping only when all three hold: **(1)** it verified the cause
against the live page or file — not "probably the selector"; **(2)** the fix changes
only *how* the test interacts (a selector, a wait, an API call) and leaves the oracle's
subject, relation, and expected value **untouched**; **(3)** it records what failed, the
evidence, and the fix. Any doubt → stop. **A failing assertion is always a stop** —
never made to pass by weakening it. A fix that keeps recurring → stop; something
systemic is wrong.

Rule 2 is load-bearing because the gate scores *intent, not interaction*: a wrong
selector that still passes is invisible to it. In a real run, `By.linkText` became a
role-based locator that matched both a product's image link and its title link;
`.first()` picked the image link, which happens to navigate to the same page, so the
oracle held and the test passed **for the wrong reason** — a latent, order-dependent bug
in shipped code. Interaction bugs are the agent's to find and prove; the moment a fix
touches an assertion, a human decides.

If the cause lies *outside* the translation — the app, the data, the environment — the
agent reports it prominently; that's a finding about the customer's system, not a
migration defect.

> **Localization note.** An expected value that comes from a resource file is external
> data — a must-pin. But if someone *hardcoded* a translated string into a test
> (`assertEquals(header, "Bienvenue")`), inlining it erased that origin, and the reader
> can only see a plain string literal — which classifies as *derive*, not must-pin. No
> static tool can tell `"Bienvenue"` from `"Login"`. So intake reports the count of
> hardcoded-string oracles; if your suite is localization-heavy, check them. The real
> fix is upstream: the string belongs in a resource bundle, not the test.

### §6 — Reading the output

- **The migrated suite** is in `<PW>` (page objects + `<PW>\tests\*.spec.ts`), runnable
  with `npx playwright test`.
- **The run report** — `<WORK>\migration-run-report.md` (and `.json`): per-step status
  and timings, the gate verdicts, Playwright pass/fail, and a token line (on Claude Max
  it reads "not metered (agent runtime)"). It records what was migrated, skipped and why,
  what needed a human, and what the agent fixed with its evidence. **It's a deliverable —
  hand it over with the code.**
- **The gate result** — `PASS / NEEDS-HUMAN / BLOCK` per test, plus `must-pin recovery
  X/Y`. Read it as: **0 BLOCK** = no intent lost; NEEDS-HUMAN = "look here", usually a
  cross-language matcher gap on correct code, not a defect; PASS = matched.
- **Runtime truth** — `tsc --noEmit` clean = it compiles; `playwright test` green = it
  actually runs. The gate is static; the live run is the final authority.

### §7 — Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `mvn`/`java`/`claude` "not recognized" but it worked before | **Stale PATH.** Close the terminal, open a fresh one — PATH changes only reach newly-opened terminals. |
| `claude: command not found` right after install | Same — open a new terminal. The installer puts it at `~/.local/bin`; if still missing, run `claude doctor`. |
| `npm install` hangs / the agent times out on it | Slow or corporate registry. Add `--use-system-ca`. If the agent times out, run the install in a side terminal, then tell it to continue. |
| Source suite fails at driver startup (`NullPointer: Name is null`) | A missing run parameter, not a code bug. Pass `-Dbrowser=CHROME` or use the suite's `testng.xml`. (Only relevant if you run the optional baseline.) |
| Extractor: `dependency jars: 0` | Wrong classpath. Re-run `dependency:build-classpath` and pass the absolute `cp.txt` path. |
| Extractor finds fewer assertions than a text grep | Usually correct — it ignores commented-out/disabled `@Test` methods that a text grep counts. Compare against live tests only. |
| Extractor: many `REVIEW` rows | Origins it couldn't trace (dynamic dispatch, unusual libs). Honest "look here" flags — never silent drops. |
| Gate BLOCK on correct-looking code | Often the cross-language matcher (`isEmpty`↔`length`, `urlContains`↔`toHaveURL`). Verify by eye; a known matcher gap, not necessarily a lost oracle. |
| Gate: `NEEDS-HUMAN (+N shared, attributed once)` | Shared setup assertions (login/nav) reached by many tests — reported once, not a per-test defect. |
| API tests fail: `unable to verify the first certificate` | The source (RestAssured) was relaxed about certs; Node isn't. **If** the source deliberately relaxed cert validation, mirror it with `ignoreHTTPSErrors: true` (a fidelity choice — flag it). If the source verified certs, this is a **real finding** — don't suppress it. |
| `playwright test` fails but the gate passed | A runtime/app issue (selector drift, timing, backend). The gate checks intent statically; the app is the runtime authority. |
| 0 assertions found on a real suite | The extractor recognises TestNG/JUnit `Assert.*` plus custom wrappers. AssertJ/Hamcrest suites need a recognizer extension (known limitation). |

### §8 — Deployment models

- **Claude Code (Max):** the agent self-drives; the deterministic tools run as CLI. No
  per-token billing.
- **Cursor / Copilot (customer):** the same drop-in operating manual; deterministic tools
  run in-repo; code never leaves the customer's boundary. Using an API key instead of an
  agent is a security/procurement decision (model choice, data-retention terms, egress).

### §9 — Known limitations (stated honestly)

- Extractor assertion detection is TestNG/JUnit-shaped (plus custom wrappers); other
  libraries need an extension.
- Gate matching is deterministic on structure but heuristic on cross-language
  equivalence — BLOCK and NEEDS-HUMAN are "look here", not final verdicts.
- The gate is static; `playwright test` is the runtime authority.
- Translation quality tracks the agent and the helper contract; the deterministic tools
  are fixed.
- On Claude Max, tokens aren't cleanly metered — measure per-test cost on an
  API/Cursor/Copilot run.

---

## Appendix A — Entry-points mode (shared with the BDD kit)

The origin-tracing classifier doesn't care *how* an entry method was found — only that
it has one. By default the extractor scans for `@Test`. Given `--entry-points <file>`
(one `Class.method` per line) it takes the entry methods from that file instead. This is
how the **BDD kit** reuses this exact classifier for Cucumber step definitions rather
than forking it:

```
java -jar tools\extractor\target\qe-extractor.jar <SUITE> <cp.txt> <records.json> ^
     --entry-points <entry-points.txt>
```

- **Without the flag:** byte-for-byte as before (`@Test` scanning, `/tests/` convention).
- **With the flag:** `@Test` scanning is off; all test sources are scanned (step defs live
  in `/stepdefinitions/`, `/steps/`, etc.); only the named methods become entry points.
  Call following, origin classification, and oracle emission are unchanged and shared.
- **Step-definition parameters classify as EXTERNAL** — Cucumber binds them from the
  `.feature` file (step text, an Examples row, a DataTable), which is external test data
  by the same definition as a data-provider row. So an oracle pinned in Gherkin becomes a
  must-pin instead of reading as derive. `@Test` methods carry no `@Given/@When/@Then`, so
  the TestNG path is unaffected.
- **Fail-safe:** any supplied entry point not found in the sources is reported as a WARN
  with the exact names — never silently ignored.

Reimplementing the tracer for BDD would fork the most-tuned component in the kit and
guarantee drift. One classifier, two entry-point strategies.

## Appendix B — Corporate networks (TLS-inspecting proxies)

If `npm install` fails with `self signed certificate in certificate chain`, your network
re-signs traffic with a private root certificate. It's in the machine's trust store, but
Node doesn't consult that store by default. **`setup` detects this and retries
automatically** with `NODE_OPTIONS=--use-system-ca` (Node 22.15+), and tells you how to
set it permanently. It only retries on a certificate error — a 404 or a blocked registry
is reported as-is — and never sets the flag unconditionally, because an unknown
`NODE_OPTIONS` value can stop older Node starting at all.

**Never** work around it with `strict-ssl false` or `NODE_TLS_REJECT_UNAUTHORIZED=0` —
those disable verification entirely instead of trusting the right certificate. The agent
manuals carry the same rule for the Playwright browser download.
