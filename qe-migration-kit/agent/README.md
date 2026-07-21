# Agent scaffolding — make the agent the orchestrator

This turns the migration from "a human runs the steps" into "the agent runs the steps, pausing
only at three hard-stops." Architecture: a **single orchestrator agent** running a **workflow**
(not multi-agent — the steps are sequential, interdependent, and token-sensitive, which is the
profile where a single agent is the right, cheaper choice). The agent calls the kit's deterministic
scripts as tools and does only the translation itself.

## Files
- `CLAUDE.md` — the operating manual (the sequence + the 3 hard-stops). The agent's constitution.
- `.claude/skills/migrate-selenium-playwright/SKILL.md` — the translation domain skill, loaded when
  translating a pack.

## Install per agent (same content, different wrapper — the agent is interchangeable)
**Claude Code (Max plan):** copy `CLAUDE.md` and the `.claude/` folder into the root of your
migration workspace (or the Playwright project). Claude Code auto-loads `CLAUDE.md` every session
and discovers the skill. Then just open Claude Code there and say: *"Migrate the suite at <SUITE>
into <PW>, following CLAUDE.md."* It runs prepare → scaffold → translate → validate → report,
stopping at the intake / gate-BLOCK / test-failure gates.

**Cursor:** copy the body of `CLAUDE.md` into `.cursor/rules` (or `.cursorrules`) at the project
root; paste the skill body where relevant, or keep it alongside as reference.

**GitHub Copilot:** copy the body of `CLAUDE.md` into `.github/copilot-instructions.md`.

## The three hard-stops (where the agent pauses for you)
1. **Intake attestation** — before migrating: confirm the source tests are valid/representative.
2. **Gate BLOCK** — a must-pin was lost; review the specific gate line before continuing.
3. **Playwright test failure** — inspect where it failed (API-setup vs UI) before fixing.
Everything else runs autonomously and is reported.

## What the agent handles autonomously (no stop, but reported)
- Self-provisioning, scaffolding the Playwright project (installs `@playwright/test` + `typescript`
  and the browsers up front; use `--use-system-ca` on corporate networks; if a slow install exceeds
  the agent's command timeout, run it in a side terminal and tell the agent to continue).
- Mechanical fixes that aren't judgment calls (e.g. a tsconfig/TypeScript-version tweak).
- **TLS fidelity:** if the source deliberately relaxed cert validation (RestAssured), the agent adds
  `ignoreHTTPSErrors: true` to the request context to mirror that — and reports it for confirmation.
  If the source verified certs, a TLS failure stays a hard-stop (a real finding, not suppressed).

## Proven
On a pilot (a public suite neither we nor the tool had seen), the agent ran the whole workflow
unattended: 11/11 tests green against the live site, gate PASS 7 / BLOCK 0, ~33k tokens, ~21
minutes, pausing only at intake and one real TLS judgment call it diagnosed correctly.

## Why single-agent (not multi-agent)
Per current best practice, multi-agent is for heavy parallelization, context exceeding a single
window, or 15-20+ tools — and it costs ~15x the tokens. Our pipeline is a short, sequential,
interdependent chain with tiny sliced contexts and ~5 tools, under a hard token budget. That is
exactly the single-agent/workflow sweet spot. (If a suite were huge and you wanted pack
translations parallelized, that one step is where subagents could later earn their extra cost.)

## What stays deterministic (0 tokens)
extract · slice · gate · tsc · playwright · report — all scripts. The agent spends tokens only on
translation, one small pack at a time.

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
