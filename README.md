# QE Migration Kits

Two migration kits that turn a Java + Selenium test suite into a working Playwright +
TypeScript one — and **prove, mechanically, that no test quietly lost what it was
checking.** One kit handles TestNG suites, the other Cucumber/BDD suites. They share a
single engine.

- **`qe-migration-kit/`** — Java + Selenium + **TestNG** → Playwright + TypeScript.
  This is the primary kit. It holds the shared engine (the extractor and the gate) and
  `init.mjs`, the single entry point for **both** kits. See its
  [README](qe-migration-kit/README.md).
- **`qe-bdd-migration-kit/`** — **Cucumber** + Selenium/Java → playwright-bdd + TypeScript.
  The sibling kit. It borrows the TestNG kit's extractor and gate and adds only the pieces
  Cucumber needs (feature-parser, step-binder, DI resolver). See its
  [README](qe-bdd-migration-kit/README.md).

## The one rule that matters

**The BDD kit is not standalone — it requires the TestNG kit present as a sibling.** Keep
both folders side by side with these exact names (`qe-migration-kit` and
`qe-bdd-migration-kit`). `init.mjs` auto-resolves the BDD kit by looking for a sibling
folder of that name, so a rename or a move breaks that wiring. There is no equivalent the
other way round: the TestNG kit runs perfectly well alone.

## How they work (in three lines)

About 90% of a migration is mechanical — find the tests, list what each one checks, work
out which checks are load-bearing (a **must-pin**), slice the work, verify the result.
Deterministic tools do all of that, for zero AI cost and with the same answer every time.
The agent only rewrites Java into TypeScript, one small pack at a time, against a fixed
rulebook. Then a deterministic **gate** re-reads both sides and confirms every check
survived. The agent never decides *what* to test — only *how to say it in TypeScript*.

You're done when three numbers line up: **must-pin recovery X/X**, **0 BLOCK**, and a
**green** Playwright run.

## Getting started

Everything runs through one command in the TestNG kit:

```
node qe-migration-kit/tools/orchestrator/init.mjs --suite "C:\path\to\your-suite"
```

`init` detects whether the suite is TestNG or BDD, wires up the right kit, scaffolds the
Playwright project, and writes a `migration.json` the tools read — so the agent's whole
job becomes the prompt *"Migrate the suite."* Full walkthroughs, batching, the four
hard-stops, and the honest limitations are in each kit's README.

## Prerequisites

- **JDK 21 + Maven** — the extractor is Java and needs Maven to resolve your suite's classpath.
- **Node 22.15+** — everything else runs on Node (22.15+ enables the corporate-CA retry).
- **A coding agent** — Claude Code, Cursor, or GitHub Copilot, in agent mode.

After installing anything, open a fresh terminal so the PATH change is picked up.

## Repository layout

```
qe-migration-kits/
├── README.md              ← you are here
├── qe-migration-kit/      ← TestNG kit — shared engine + init.mjs live here
└── qe-bdd-migration-kit/  ← BDD kit — borrows the engine; needs the sibling above
```