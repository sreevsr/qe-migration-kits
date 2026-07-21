# orchestrator — SIBLING (orchestrate_bdd.mjs), not a flag on the TestNG one
The extractor and the gate differ by ONE line between TestNG and BDD, so they take an additive flag
and stay SHARED. The prepare CHAIN genuinely differs (6 tools vs 3), so this is a sibling driver that
CALLS the shared components:
  - shared extractor : java -jar <testng-kit>/tools/extractor/target/qe-extractor.jar ... --entry-points
  - shared gate      : node  <testng-kit>/tools/gate/parity_check_ast.mjs ... --bdd
Point it at the TestNG kit with --testng-kit (default: ../qe-migration-kit).

prepare : classpath -> feature-parser -> step-binder -> di-resolver -> shared extractor
          -> bdd-records (join) -> slice (+ copies .feature files verbatim, 0 tokens)
validate: shared gate (--bdd) -> bddgen -> tsc --noEmit -> playwright test
Exit codes: 0 ok · 11 prereq · 15 UNBOUND/AMBIGUOUS steps · 20 gate BLOCK · 30 tsc/bddgen · 40 playwright.

## Exit 15 is BDD-specific
An UNBOUND (or AMBIGUOUS) Gherkin step = a step with no (or several) matching definition(s). A real
gap; never migrate past it. Distinct from UNUSED definitions (dead glue) — reported, not stopped.

## run() must capture BOTH streams (found on the first real end-to-end run)
The Node tools print their summaries to stderr so that JSON can go to stdout when --out is omitted.
execSync returns stdout ONLY — so the first orchestrated run silently swallowed every
"BOUND 24 · UNBOUND 0", "9 unused definitions" and "copied 4 .feature file(s)" line, making the run
look like it did nothing between steps. Now uses spawnSync and concatenates stdout+stderr.
NOTE (latent, not fixed): the TestNG orchestrator uses the same execSync pattern. It loses nothing
today (its tools all print to stdout, and its catch path captures stderr on failure), but a future
tool that warns on stderr while succeeding would be swallowed there too.

## `stopped` must be CLEARED by a run that gets past the stop (found by the agent, first real run)
`stopGate()` wrote `rep.stopped`; nothing ever deleted it. So after ANY hard-stop, every later report
carried a stale line forever — the delivered document said `BLOCK 0` and `7 passed` AND
`STOPPED: (20) a must-pin lost`, contradicting itself on a fully green run. The report is the
hand-off artifact; a self-contradictory one is worse than none.
Fix: `delete rep.stopped` on validate's success path (reached only after gate+bddgen+tsc pass) and at
the start of prepare (a fresh prepare supersedes an earlier stop). Safe because a subsequent failure
calls stopGate again immediately — a stop is only ever cleared by a run that actually got past it.
CORRECTION (this note previously claimed the TestNG orchestrator had the same defect — it does NOT;
that claim was written from pattern-matching without reading the file). The TestNG `stopGate()` only
prints and calls process.exit — it never persists a stop record, and its report() never prints a
STOPPED line. A stale contradiction is therefore impossible there. Its report conveys a stop
implicitly instead: `finished: (incomplete)` plus the gate's own `BLOCK n`.
