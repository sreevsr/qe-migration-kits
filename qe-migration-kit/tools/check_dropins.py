#!/usr/bin/env python3
"""Drop-in drift check. Run after ANY edit to CLAUDE.md or a SKILL.md.
Copilot/Cursor get ONE file, so it must contain BOTH halves. Copying CLAUDE.md over the top
silently drops the entire translation contract — which is exactly what happened."""
import glob, re, sys, os
bad = 0
for kit in ["tk/qe-migration-kit", "bddkit/qe-bdd-migration-kit"]:
    claude = open(f"{kit}/agent/CLAUDE.md", encoding="utf-8").read()
    skill = open(glob.glob(f"{kit}/agent/.claude/skills/*/SKILL.md")[0], encoding="utf-8").read()
    skill_body = re.sub(r'^---\n.*?\n---\n', '', skill, flags=re.S)
    # a fingerprint line from each half that must survive into the drop-in
    probes = [("orchestration", "HARD-STOP 3 in detail"), ("translation contract", "@source")]
    for dest in [f"{kit}/agent/.github/copilot-instructions.md", f"{kit}/agent/.cursor/rules"]:
        d = open(dest, encoding="utf-8").read()
        for label, probe in probes:
            if probe not in d:
                print(f"  DRIFT: {dest} is missing the {label} half ({probe!r} absent)"); bad += 1
        if len(d) < len(claude) + len(skill_body) * 0.8:
            print(f"  DRIFT: {dest} is too short to hold both halves — was it overwritten with CLAUDE.md?"); bad += 1
print("  drop-ins: CLEAN — every editor file carries both halves" if not bad else f"  {bad} problem(s)")
sys.exit(1 if bad else 0)
