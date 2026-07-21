# Agent drop-in — make the agent the BDD migration orchestrator

Copy these files into a fresh workspace and give the agent ONE instruction. It runs the deterministic
scripts as tools, translates the glue itself, and pauses only at the three hard-stops.

## Claude Code
```
# in a fresh workspace folder (this becomes PW):
copy  <BDD_KIT>\agent\CLAUDE.md   .
xcopy <BDD_KIT>\agent\.claude     .\.claude\  /E /I
claude
```
Then:
> Migrate the Cucumber+Selenium suite at `<SUITE>` into this workspace, following CLAUDE.md.
> KIT=`<BDD_KIT>`, TESTNG_KIT=`<qe-migration-kit>`, WORK=`<WORK>`, PW=`<this folder>`.
> Run unattended, pausing only at the hard-stops.

**Cursor:** use `agent/.cursor/rules` instead of CLAUDE.md.
**Copilot:** use `agent/.github/copilot-instructions.md`.
Same behaviour — the agent is interchangeable; the deterministic tools do the same work regardless.

## What the agent does vs. what the tools do
| tools (0 tokens) | agent (tokens) |
|---|---|
| parse features, bind steps to methods | translate page objects + `fixtures.ts` (once) |
| resolve DI → fixture plan | translate ONE step-definition class per pack |
| extract oracles (SHARED classifier) | fix what the gate/tsc/playwright reports |
| join → scenario-keyed intent model | |
| slice into packs, exclude dead glue | |
| **copy the `.feature` files verbatim** | *(never writes Gherkin)* |
| gate (SHARED, `--bdd`), bddgen, tsc, playwright | |

## The three hard-stops (where the human decides)
1. **Intake** — is the source suite valid/representative? The tool exits 15 by itself on any UNBOUND
   or AMBIGUOUS step (a Gherkin step with no/several matching definitions — a real gap).
2. **Gate BLOCK** — a must-pin oracle was lost. Read the specific gate line.
3. **Playwright failure** — inspect where: step binding, page-object selector, or the app.
Everything else runs autonomously and is reported, including mechanical fixes.

## Honest notes
- Corporate networks: `$env:NODE_OPTIONS="--use-system-ca"` before launching, or `--use-system-ca`
  per npm command. Slow installs can exceed the agent's command timeout — run them in a side
  terminal and tell the agent to continue.
- The agent never edits a `.feature`. If step text looks wrong, that's a finding for you.
- Dead glue is already excluded from the packs; partially-dead classes list their dead methods.

## VS Code + Copilot / Cursor

Claude Code reads TWO files: `CLAUDE.md` (how to drive the pipeline) and the skill under `.claude/`
(how to translate a pack). Copilot and Cursor take ONE instruction file, so `copilot-instructions.md`
and `.cursor/rules` are **both files merged** — orchestration first, then the translation contract
under a "PART 2" banner. Do not copy `CLAUDE.md` into them; they are generated, and copying would
silently drop the entire translation contract (locator mapping, wait deletion, DI→fixtures,
assertion mapping, the `@source` format, MUST-PIN rules).

**Copilot:**
```
mkdir .github
copy <KIT>\agent\.github\copilot-instructions.md .github\
code .
```
Then use Copilot **agent mode** (it must be able to run terminal commands).

**Cursor:**
```
mkdir .cursor
copy <KIT>\agent\.cursor\rules .cursor\
```

**Claude Code** (two files, as before):
```
copy  <KIT>\agent\CLAUDE.md .
xcopy <KIT>\agent\.claude .\.claude\ /E /I
```

> **Only Claude Code is proven.** The hard-stops are a BEHAVIOUR — the tools exit with a code and
> print a message; stopping and asking is the agent choosing to obey this manual. Verify on a small
> suite that your editor's agent actually stops at HARD-STOP 1 before trusting it with a real one.
