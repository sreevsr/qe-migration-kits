#!/usr/bin/env node
/**
 * prepare_bdd.mjs — slice a Cucumber suite into minimal migration packs. Deterministic, no LLM.
 *
 *   node prepare_bdd.mjs --records cuke-records.json --bound cuke-bound.json \
 *        --fixtures cuke-fixtures.json --repo <suite> --out migration-packs [--pw <playwright-dir>]
 *
 * WHY SLICE BY STEP-DEF CLASS, NOT BY FEATURE (deviates from DESIGN.md §7, deliberately):
 *  - The agent's output unit is one .ts step file per Java step class. Slicing by feature would
 *    duplicate a class across packs (UITestSteps serves all 4 backgrounds here) and split its
 *    context.
 *  - This also mirrors the TestNG kit, which slices per test class. Same discipline, same shape.
 *
 * THE .feature FILES ARE COPIED, NOT TRANSLATED (0 tokens):
 *  Gherkin carries over verbatim to playwright-bdd. The agent never sees them — copying is
 *  deterministic, so the entire scenario layer costs nothing and cannot be corrupted by an LLM.
 *
 * DEAD GLUE IS SKIPPED: step-def classes no feature references are not packed (reported instead).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const norm = p => p.replace(/\\/g, "/");

function walk(dir, filter, acc = []) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!["target", "node_modules", ".git", "build"].includes(e.name)) walk(p, filter, acc); }
    else if (filter(p)) acc.push(p);
  }
  return acc;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const RECORDS = opt("--records", ""), BOUND = opt("--bound", ""), FIXTURES = opt("--fixtures", "");
  const REPO = opt("--repo", "."), OUT = opt("--out", "migration-packs"), PW = opt("--pw", "");

  // ---- BATCHING BY FEATURE (not by step class) -------------------------------------------------
  // TestNG batches by test class because a subset of classes is a working subset of tests. BDD
  // cannot: a feature whose steps span three step classes needs ALL THREE migrated, or bddgen leaves
  // steps undefined and the whole run fails. So the batch unit is the FEATURE; the step classes it
  // needs are derived. Only in-scope .feature files are copied — an uncopied feature cannot fail.
  //
  // And the tracking is per METHOD, not per class. On the validation suite UITestSteps serves all 4
  // features: 1 method for the frames feature, 7 for the web-form feature. "Class already migrated,
  // skip it" would leave the web-form's 6 extra steps UNDEFINED. So a later batch EXTENDS an
  // existing step file with the methods its features newly need.
  const parseList = (inline, file) => {
    const out = new Map();
    if (inline) for (const t of inline.split(",").map(x => x.trim()).filter(Boolean)) out.set(t, null);
    if (file && fs.existsSync(file)) for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim(); if (!line || line.startsWith("#")) continue;
      const h = line.indexOf("#");
      const name = (h >= 0 ? line.slice(0, h) : line).trim();
      if (name) out.set(name, h >= 0 ? line.slice(h + 1).trim() : null);
    }
    return out;
  };
  const ONLY_F = parseList(opt("--only-features", ""), opt("--only-features-file", ""));
  const SKIP_F = parseList(opt("--skip-features", ""), opt("--skip-features-file", ""));
  const BATCH_SIZE = parseInt(opt("--batch-size", "0"), 10) || 0;
  const BATCH_NO = parseInt(opt("--batch", "1"), 10) || 1;
  const LEDGER_PATH = opt("--ledger", path.join(OUT, "migration-ledger.json"));
  if (!RECORDS || !BOUND) { console.error("usage: node prepare_bdd.mjs --records <records.json> --bound <bound.json> [--fixtures <plan.json>] --repo <suite> --out <dir> [--pw <playwright-dir>]"); process.exit(2); }

  const model = JSON.parse(fs.readFileSync(RECORDS, "utf8"));
  const records = model.records || model;
  const bound = JSON.parse(fs.readFileSync(BOUND, "utf8"));
  const fixtures = FIXTURES && fs.existsSync(FIXTURES) ? JSON.parse(fs.readFileSync(FIXTURES, "utf8")) : null;

  // ---- resolve the FEATURE scope --------------------------------------------------------------
  const allFeatures = [...new Set(records.map(r => r.feature))].sort();
  const featName = f => path.basename(f);
  const unknownF = [...ONLY_F.keys(), ...SKIP_F.keys()].filter(n => !allFeatures.some(f => featName(f) === n || f === n));
  if (unknownF.length) {
    console.error(`\nERROR: --only-features/--skip-features named ${unknownF.length} feature(s) that do not exist:`);
    for (const u of unknownF) console.error(`  - ${u}`);
    console.error(`\nKnown features: ${allFeatures.map(featName).join(", ")}`);
    process.exit(2);
  }
  const matches = (f, m) => m.has(featName(f)) || m.has(f);
  const batch = { features_in_scope: [], features_deferred: [], features_skipped: [] };
  const candF = [];
  for (const f of allFeatures) {
    if (matches(f, SKIP_F)) batch.features_skipped.push({ name: featName(f), reason: (SKIP_F.get(featName(f)) || SKIP_F.get(f) || "no reason given") });
    else if (ONLY_F.size && !matches(f, ONLY_F)) batch.features_deferred.push(featName(f));
    else candF.push(f);
  }
  const FINGERPRINT = crypto.createHash("sha256").update(allFeatures.map(featName).sort().join("\n")).digest("hex").slice(0, 12);
  const loadLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")); }
    catch { return { suite: path.resolve(REPO), kind: "bdd", fingerprint: FINGERPRINT, feature_count: allFeatures.length, created: new Date().toISOString(), batches: [], skipped: [] }; } };
  const ledger = loadLedger();
  const batching = ONLY_F.size > 0 || SKIP_F.size > 0 || BATCH_SIZE > 0;
  if (batching && ledger.batches.length && ledger.fingerprint !== FINGERPRINT) {
    console.error(`\nERROR: the suite's FEATURE list changed since this ledger started.`);
    console.error(`  ledger : ${ledger.fingerprint} (${ledger.feature_count} features)`);
    console.error(`  current: ${FINGERPRINT} (${allFeatures.length} features)`);
    console.error(`\nBatches are slices of the sorted feature list, so the boundaries have MOVED — some features`);
    console.error(`would be migrated twice and others skipped silently. Re-plan against the new list (fresh --out),`);
    console.error(`or pass --accept-drift if you know why and accept the consequence.`);
    if (!argv.includes("--accept-drift")) process.exit(3);
    console.error(`\n--accept-drift given: continuing. Recorded in the ledger.`);
  }
  let inScopeFeatures;
  if (BATCH_SIZE > 0) {
    const ordered = [...candF].sort();
    const totalBatches = Math.ceil(ordered.length / BATCH_SIZE);
    if (BATCH_NO < 1 || BATCH_NO > totalBatches) {
      console.error(`\nERROR: --batch ${BATCH_NO} out of range. ${ordered.length} migratable feature(s) at --batch-size ${BATCH_SIZE} = ${totalBatches} batch(es).`);
      process.exit(2);
    }
    inScopeFeatures = ordered.slice((BATCH_NO - 1) * BATCH_SIZE, (BATCH_NO - 1) * BATCH_SIZE + BATCH_SIZE);
    batch.features_deferred.push(...ordered.filter(f => !inScopeFeatures.includes(f)).map(featName));
    batch.batch = { index: BATCH_NO, size: BATCH_SIZE, total_batches: totalBatches, migratable: ordered.length };
  } else inScopeFeatures = candF;
  batch.features_in_scope = inScopeFeatures.map(featName);

  // Methods EARLIER batches already migrated — per METHOD, because one step class serves many
  // features with different method subsets.
  const label = BATCH_SIZE > 0 ? BATCH_NO : `only:${batch.features_in_scope.join("+")}`;
  const priorBatches = (ledger.batches || []).filter(b => String(b.batch) !== String(label));
  const ALREADY_METHODS = new Set(priorBatches.flatMap(b => b.methods || []));
  // Features earlier batches already migrated are NOT "deferred" — they are DONE. Reporting them as
  // deferred is the same falsehood the TestNG kit had for classes: the arithmetic still adds up to
  // the total, so it LOOKS right, while telling a customer that finished work is outstanding.
  const ALREADY_FEATURES = new Set(priorBatches.flatMap(b => b.features || []));
  batch.features_already_migrated = [...ALREADY_FEATURES].filter(f => !batch.features_in_scope.includes(f));
  batch.features_deferred = batch.features_deferred.filter(f => !ALREADY_FEATURES.has(f));
  const inScopeSet = new Set(inScopeFeatures);
  const scopedRecords = batching ? records.filter(r => inScopeSet.has(r.feature)) : records;

  const javaFiles = walk(REPO, p => p.endsWith(".java"));
  const featureFiles = walk(REPO, p => p.endsWith(".feature")).filter(f =>
    !batching || batch.features_in_scope.includes(path.basename(f)));
  const isStepDefFile = p => /\/(stepdefinitions|stepDefinitions|steps|glue)\//i.test(norm(p));
  const isRunner = p => /\/(runner|runners)\//i.test(norm(p));
  const isHook = p => /\/hooks?\//i.test(norm(p));
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith(".md")) fs.unlinkSync(path.join(OUT, f));

  // ---- which step-def classes are actually USED (dead glue is skipped, not migrated) ----
  const usedMethodsByClass = new Map();   // class -> Set(method)
  const scenariosByClass = new Map();     // class -> Set("feature::scenario")
  for (const r of scopedRecords) {
    for (const s of r.steps) {
      if (s.status !== "BOUND" || !s.bound_method) continue;
      const [cls, mth] = [s.bound_method.slice(0, s.bound_method.lastIndexOf(".")), s.bound_method.slice(s.bound_method.lastIndexOf(".") + 1)];
      if (!usedMethodsByClass.has(cls)) { usedMethodsByClass.set(cls, new Set()); scenariosByClass.set(cls, new Set()); }
      usedMethodsByClass.get(cls).add(mth);
      scenariosByClass.get(cls).add(path.basename(r.feature) + " :: " + r.scenario);
    }
  }
  // Dead = referenced by NO feature in the whole suite. Computed from ALL records, never from the
  // batch's slice: a class this batch doesn't happen to need is not dead — an earlier batch may have
  // migrated it, and a later batch may still need it.
  const usedByAnyFeature = new Set();
  for (const r of records) for (const st of r.steps)
    if (st.status === "BOUND" && st.bound_method) usedByAnyFeature.add(st.bound_method.slice(0, st.bound_method.lastIndexOf(".")));
  const deadClasses = new Set();
  const deadByClass = new Map();   // class -> [ {method, keyword, pattern} ] (dead methods)
  for (const d of bound.unused_definitions || []) {
    if (!usedByAnyFeature.has(d.class)) deadClasses.add(d.class);          // whole class is dead -> skipped
    if (!deadByClass.has(d.class)) deadByClass.set(d.class, []);
    deadByClass.get(d.class).push(d);
  }

  // ---- oracles per bound method (from the scenario-keyed model, deduplicated) ----
  const oraclesByMethod = new Map();
  const scenariosByMethod = new Map();
  for (const r of scopedRecords) for (const s of r.steps) {
    if (s.status !== "BOUND") continue;
    if (!oraclesByMethod.has(s.bound_method)) oraclesByMethod.set(s.bound_method, s.oracles || []);
    if (!scenariosByMethod.has(s.bound_method)) scenariosByMethod.set(s.bound_method, []);
    scenariosByMethod.get(s.bound_method).push({ feature: path.basename(r.feature), scenario: r.scenario, keyword: s.effective_keyword, text: s.text, from_background: !!s.from_background, params: s.params || [], placeholders: s.placeholders || [] });
  }

  const fileBlock = p => `\n### ${norm(path.relative(REPO, p))}\n\`\`\`java\n${fs.readFileSync(p, "utf8").trimEnd()}\n\`\`\`\n`;

  // ---- PACK 00: abstraction layer + the DI -> fixture plan (migrate ONCE) ----
  const rank = p => { p = norm(p);
    if (p.includes("/base/")) return 0; if (p.includes("/pages/") || p.includes("/pageObjects/")) return 1;
    if (p.includes("/managers/")) return 2; if (p.includes("/util/") || p.includes("/utils/")) return 3; return 4; };
  const layer = javaFiles.filter(p => !isStepDefFile(p) && !isRunner(p) && !isHook(p)).sort((a, b) => rank(a) - rank(b));

  const layerDone = ALREADY_METHODS.size > 0;   // an earlier batch already built pages + fixtures
  let po = (layerDone
    ? `# Migration Pack 00 — Abstraction Layer + Fixtures — ALREADY MIGRATED (reference only)\n\n`
      + `> **Do NOT re-translate this pack.** An earlier batch already built your page objects and\n`
      + `> \`fixtures.ts\`. Re-generating them would rewrite files that earlier batches' step definitions\n`
      + `> depend on, and the gate re-verifies those on every batch. Use this only to look something up.\n`
    : `# Migration Pack 00 — Abstraction Layer + Fixtures (migrate ONCE, first)\n\n`
      + `Translate these to Playwright + TypeScript page objects, and build \`fixtures.ts\` from the DI plan\n`
      + `below. Follow contracts/helper_contract_bdd.md. Keep class/method names so the step defs line up.\n`);

  if (fixtures) {
    po += `\n## DI → Playwright fixtures (build \`fixtures.ts\` from this)\n\n`
      + `Detected DI style: **${fixtures.di_style || "none detected"}**${fixtures.context_class ? ` (context class: \`${fixtures.context_class}\`)` : ""}\n\n`
      + `| fixture | replaces |\n|---|---|\n`;
    for (const f of fixtures.fixtures || []) po += `| \`${f.fixture}\` | ${f.from} |\n`;
    if ((fixtures.hooks || []).length) {
      po += `\n### Hooks\n\n| file | action |\n|---|---|\n`;
      for (const h of fixtures.hooks) po += `| \`${h.file}\` | ${h.maps_to} |\n`;
    }
    for (const n of fixtures.notes || []) po += `\n> NOTE: ${n}\n`;
    if ((fixtures.unsupported || []).length) {
      po += `\n> ⚠ UNSUPPORTED DI detected — a human must decide how these map:\n`;
      for (const u of fixtures.unsupported) po += `> - \`${u.file}\`: ${u.reason}\n`;
    }
  }
  po += `\n## Source (translate this)\n`;
  for (const p of layer) po += fileBlock(p);
  fs.writeFileSync(path.join(OUT, "00_page_objects.md"), po);

  // ---- PACK per USED step-def class ----
  const index = [];
  const migratedThisBatch = [];
  for (const [cls, allMethodsNeeded] of usedMethodsByClass) {
    const file = javaFiles.find(p => path.basename(p) === cls + ".java");
    if (!file) continue;
    // Per-METHOD scoping: only what this batch's features newly need. A class already partly
    // migrated (UITestSteps serves every feature here) gets an EXTEND pack, not a fresh one.
    const methods = new Set([...allMethodsNeeded].filter(m => !ALREADY_METHODS.has(cls + "." + m)));
    const previously = [...allMethodsNeeded].filter(m => ALREADY_METHODS.has(cls + "." + m));
    if (methods.size === 0) continue;   // every method this batch needs is already migrated
    for (const m of methods) migratedThisBatch.push(cls + "." + m);
    const isExtend = previously.length > 0;
    let mp = 0, tot = 0;
    const stepFile = `steps/${cls.replace(/Steps$/, "").toLowerCase()}.steps.ts`;
    let md = `# Migration Pack — ${cls}${isExtend ? " (EXTEND an existing step file)" : ""}\n\n`
      + (isExtend
          ? `**\`${stepFile}\` ALREADY EXISTS** — an earlier batch migrated ${previously.length} method(s) of this\n`
            + `class (${previously.map(m => "`" + m + "`").join(", ")}). This batch's features need ${methods.size} MORE.\n`
            + `**ADD the step definitions below to that file. Do NOT rewrite it and do NOT touch the\n`
            + `existing ones** — the gate re-verifies them and earlier features depend on them.\n\n`
          : `Translate this ONE step-definition class to a playwright-bdd step file\n`
            + `(\`${stepFile}\`), following contracts/helper_contract_bdd.md and using the fixtures +\n`
            + `page objects from pack 00.\n\n`)
      + `The .feature files are ALREADY COPIED across verbatim — do not rewrite them. Your step\n`
      + `definitions must keep matching their step text.\n\n`
      + `## Steps this class serves (bind exactly these)\n\n`
      + `Params come from the .feature file (step text, an Examples row, or a DataTable) — that is why\n`
      + `an oracle compared against one is a MUST-PIN.\n\n`
      + `| keyword | step text | → method | params (from the feature) | used by |\n|---|---|---|---|---|\n`;
    for (const m of [...methods].sort()) {
      const id = cls + "." + m;
      const uses = scenariosByMethod.get(id) || [];
      const u = uses[0];
      const ps = u && u.params && u.params.length
        ? u.params.map((v, i) => `\`${(u.placeholders && u.placeholders[i]) ? "<" + u.placeholders[i] + ">" : v}\``).join(", ")
        : "—";
      const usedBy = uses.length > 1 ? `${uses.length} scenarios` : "1 scenario";
      md += `| ${u ? u.keyword : "?"} | \`${u ? u.text : ""}\`${u && u.from_background ? " *(Background)*" : ""} | \`${m}\` | ${ps} | ${usedBy} |\n`;
    }
    md += `\n## Oracles to PRESERVE (the extractor pinned these — do not drop or invent)\n`;
    let any = false;
    for (const m of [...methods].sort()) {
      const id = cls + "." + m;
      const oracles = oraclesByMethod.get(id) || [];
      if (!oracles.length) continue;
      any = true;
      md += `\n**${id}**\n\n| keep? | check | type |\n|---|---|---|\n`;
      for (const o of oracles) {
        tot++; if (o.recovery === "must_pin") mp++;
        md += `| ${o.recovery === "must_pin" ? "**MUST-PIN**" : "derive"} | \`${o.subject} ${o.relation} ${o.expected}\` | ${o.type} |\n`;
      }
    }
    if (!any) md += `\n_None — every method in this class is an action step (no assertions). Translate the\nactions faithfully; do NOT invent assertions the source never had._\n`;
    md = md.replace("## Oracles to PRESERVE",
      `> ${methods.size} bound method(s), ${tot} oracle(s), ${mp} must-pin. MUST-PIN checks are non-negotiable:\n> the generated step definition must assert each one, or the gate will BLOCK.\n\n## Oracles to PRESERVE`);
    const dead = (deadByClass.get(cls) || []).filter(d => !methods.has(d.method));
    if (dead.length) {
      md += `\n## DEAD methods in this class — DO NOT translate\n\n`
        + `The source below is the WHOLE class, but no feature references these ${dead.length} method(s).\n`
        + `Skip them: translating them wastes tokens and emits step definitions nothing calls.\n\n`
        + `| keyword | pattern | method |\n|---|---|---|\n`;
      for (const d of dead) md += `| ${d.keyword} | \`${d.pattern}\` | \`${d.method}\` |\n`;
    }

    md += `\n## Scenarios that depend on this class\n\n`;
    for (const s of [...(scenariosByClass.get(cls) || [])].sort()) md += `- ${s}\n`;
    md += `\n## Source (translate this)\n\`\`\`java\n${fs.readFileSync(file, "utf8").trimEnd()}\n\`\`\`\n`;
    fs.writeFileSync(path.join(OUT, `${cls}.md`), md);
    index.push({ cls, methods: methods.size, mustpin: mp, dead: dead.length, extend: isExtend, previously: previously.length });
  }

  // ---- COPY the .feature files (deterministic, 0 tokens — Gherkin carries over verbatim) ----
  // Copy ONLY this batch's features, and NEVER clear the dir: the migrated suite is ONE playwright
  // project that GROWS. An uncopied feature cannot fail bddgen — which is exactly why the batch unit
  // is the feature and not the step class.
  let copied = 0;
  if (PW) {
    const dest = path.join(PW, "features");
    fs.mkdirSync(dest, { recursive: true });
    for (const f of featureFiles) { fs.copyFileSync(f, path.join(dest, path.basename(f))); copied++; }
  }

  // ---- INDEX ----
  let idx = `# BDD Migration Packs — index & run order\n\n`
    + `Generated from ${path.basename(RECORDS)}. Migrate in this order:\n\n`
    + (ALREADY_METHODS.size
        ? `1. ~~**00_page_objects.md**~~ — **ALREADY MIGRATED in an earlier batch. Do NOT re-translate it.**\n`
          + `   Your page objects and \`fixtures.ts\` already exist; reuse them. Re-generating them would\n`
          + `   rewrite files earlier batches' step definitions depend on. Reference only.\n`
        : `1. **00_page_objects.md** — abstraction layer + \`fixtures.ts\`, migrate ONCE (this batch).\n`)
    + index.map((e, i) => `${i + 2}. **${e.cls}.md** — ${e.methods} bound method(s), ${e.mustpin} must-pin${e.dead ? `, ${e.dead} dead method(s) to SKIP` : ""}${e.extend ? `  **[EXTEND: ${e.previously} method(s) already migrated in an earlier batch — ADD to the file, don't rewrite it]**` : ""}.`).join("\n")
    + `\n\n## The .feature files\n`
    + (PW ? `Already copied verbatim to \`${norm(path.join(PW, "features"))}\` (${copied} file(s)) — **0 tokens, no agent**.\n`
         : `NOT copied (no --pw given). Copy them verbatim into your playwright-bdd project's features/ dir.\n`)
    + `Gherkin carries over unchanged; only the glue underneath is translated.\n`;
  if (deadClasses.size) {
    idx += `\n## Skipped — dead glue (no feature references these)\n`;
    for (const c of [...deadClasses].sort()) idx += `- \`${c}\` — not packed, not migrated.\n`;
  }
  idx += `\n## Token discipline\n`
    + `- Feed the agent ONE pack at a time. Never paste the whole repo.\n`
    + `- The .feature files and the oracles are already handled deterministically — do not ask the\n`
    + `  agent to "figure out what to test".\n`
    + `- After each step file, run the gate (deterministic, 0 tokens). Only re-prompt on a real BLOCK.\n`;
  if (batching) {
    idx += `\n## Batch scope (by FEATURE)\n`
      + (batch.batch ? `**Batch ${batch.batch.index} of ${batch.batch.total_batches}** (size ${batch.batch.size}, ${batch.batch.migratable} migratable features).\n`
          + (batch.batch.index >= batch.batch.total_batches ? `This is the LAST batch.\n\n`
             : `Next: re-run prepare with \`--batch ${batch.batch.index + 1}\` (same \`--batch-size ${batch.batch.size}\`).\n\n`) : "")
      + `- **features in scope: ${batch.features_in_scope.length}** — ${batch.features_in_scope.join(", ") || "(none)"}\n`
      + (batch.features_already_migrated.length ? `- **features already migrated: ${batch.features_already_migrated.length}** (earlier batches; already copied and running. The gate RE-VERIFIES their steps) — ${batch.features_already_migrated.join(", ")}\n` : "")
      + (batch.features_deferred.length ? `- **features deferred: ${batch.features_deferred.length}** (a later batch; NOT copied, so they cannot fail bddgen) — ${batch.features_deferred.join(", ")}\n` : "")
      + (batch.features_skipped.length ? `- **features skipped: ${batch.features_skipped.length}** (deliberately excluded)\n\n| feature | reason |\n|---|---|\n`
          + batch.features_skipped.map(x => `| \`${x.name}\` | ${x.reason} |\n`).join("") : "")
      + (ALREADY_METHODS.size ? `\n- **step-def methods already migrated (earlier batches): ${ALREADY_METHODS.size}** — the gate RE-VERIFIES these; the migrated suite is ONE project checked as a whole.\n` : "")
      + `\nA step class can serve several features, so a later batch may EXTEND an existing step file\n`
      + `rather than create one. Packs above list ONLY the methods this batch newly needs.\n`;
  }
  fs.writeFileSync(path.join(OUT, "INDEX.md"), idx);

  // batch.json — the gate reads it as --scope. METHOD-level for BDD (a class can be half-migrated).
  const allMethods = new Set();
  for (const r of records) for (const st of r.steps) if (st.status === "BOUND" && st.bound_method) allMethods.add(st.bound_method);
  batch.in_scope_methods = migratedThisBatch;
  batch.already_migrated_methods = [...ALREADY_METHODS];
  batch.deferred_methods = [...allMethods].filter(m => !migratedThisBatch.includes(m) && !ALREADY_METHODS.has(m));
  batch.fingerprint = FINGERPRINT;
  batch.total_features = allFeatures.length;
  batch.generated_from = path.basename(RECORDS);
  fs.writeFileSync(path.join(OUT, "batch.json"), JSON.stringify(batch, null, 2));

  if (batching) {
    ledger.fingerprint = FINGERPRINT; ledger.feature_count = allFeatures.length;
    const entry = { batch: label, size: batch.batch ? batch.batch.size : batch.features_in_scope.length,
      total_batches: batch.batch ? batch.batch.total_batches : 1, prepared_at: new Date().toISOString(),
      features: batch.features_in_scope, methods: migratedThisBatch,
      validated_at: null, gate: null, playwright: null,
      ...(argv.includes("--accept-drift") ? { drift_accepted: true } : {}) };
    const prior = ledger.batches.find(b => String(b.batch) === String(label));
    if (prior) Object.assign(prior, entry, { validated_at: prior.validated_at, gate: prior.gate, playwright: prior.playwright, re_prepared_at: entry.prepared_at });
    else ledger.batches.push(entry);
    for (const sk of batch.features_skipped)
      if (!ledger.skipped.some(x => x.name === sk.name)) ledger.skipped.push({ name: sk.name, reason: sk.reason, at: new Date().toISOString() });
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    console.error(`prepare_bdd: ledger ${LEDGER_PATH} — ${ledger.batches.length} batch(es), ${ledger.skipped.length} feature(s) skipped.`);
  }

  console.error(`prepare_bdd: ${index.length} step-class pack(s) + 1 abstraction pack + INDEX -> ${OUT}/`);
  if (batching) {
    if (batch.batch) console.error(`prepare_bdd: Batch ${batch.batch.index} of ${batch.batch.total_batches} (size ${batch.batch.size}) — ${batch.batch.migratable} migratable feature(s).`);
    const amF = batch.features_already_migrated.length;
    console.error(`prepare_bdd: features — ${batch.features_in_scope.length} in scope${amF ? ` · ${amF} already migrated (earlier batches)` : ""} · ${batch.features_deferred.length} deferred · ${batch.features_skipped.length} skipped = ${batch.features_in_scope.length + amF + batch.features_deferred.length + batch.features_skipped.length} of ${allFeatures.length}`);
    console.error(`prepare_bdd: step-def methods — ${migratedThisBatch.length} new this batch · ${ALREADY_METHODS.size} already migrated (re-verified by the gate) · ${batch.deferred_methods.length} deferred`);
    const ext = index.filter(e => e.extend);
    if (ext.length) console.error(`prepare_bdd: ${ext.length} pack(s) EXTEND an existing step file: ${ext.map(e => e.cls).join(", ")}`);
    if (batch.batch && batch.batch.index < batch.batch.total_batches)
      console.error(`prepare_bdd: next batch — re-run with --batch ${batch.batch.index + 1} (same --batch-size ${batch.batch.size}).`);
  }
  const partial = index.filter(e => e.dead);
  if (partial.length) console.error(`prepare_bdd: ${partial.length} pack(s) contain dead methods to skip: ${partial.map(e => e.cls + "(" + e.dead + ")").join(", ")}`);
  if (deadClasses.size) console.error(`prepare_bdd: skipped ${deadClasses.size} dead step-def class(es): ${[...deadClasses].join(", ")}`);
  console.error(PW ? `prepare_bdd: copied ${copied} .feature file(s) verbatim -> ${norm(path.join(PW, "features"))} (0 tokens)`
                   : `prepare_bdd: .feature files NOT copied (pass --pw <playwright-dir> to copy them)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
