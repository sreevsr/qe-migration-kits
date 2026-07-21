#!/usr/bin/env node
/**
 * bdd-records.mjs — the JOIN. Turns the step-binder's bound.json + the SHARED extractor's
 * method-keyed oracles into the BDD intent model: records keyed by FEATURE + SCENARIO.
 * Deterministic, no LLM.
 *
 *   node bdd-records.mjs --bound bound.json --oracles cuke-oracles.json [--out records.json]
 *
 * Why a join: the extractor knows "what does UITestSteps.validatePasswordMask assert?" but nothing
 * about Gherkin. The binder knows "which scenario's step calls that method". Neither alone is the
 * intent model; the join is.
 *
 * Counting discipline (learned the hard way): one step-def method can serve MANY scenarios
 * (e.g. openAnyPage runs in 4 backgrounds). Its oracles genuinely execute for each scenario, so
 * per-scenario counts include them — but a suite TOTAL that sums those would double-count. So we
 * emit both: per-scenario counts (what runs) and a summary of DISTINCT oracles (what exists).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** index the extractor's records by method id ("Class.method") */
function indexOracles(oracleRecords) {
  const byId = new Map();
  for (const r of oracleRecords) byId.set(r.id, r.oracles || []);
  return byId;
}

function attach(step, byId) {
  const out = {
    keyword: step.keyword,
    effective_keyword: step.effectiveKeyword || step.keyword,
    text: step.text,
    status: step.status,
  };
  if (step.placeholders) out.placeholders = step.placeholders;
  if (step.matched_via) { out.matched_via = step.matched_via; out.resolved_text = step.resolved_text; }
  if (step.status === "BOUND") {
    out.bound_method = step.bound_method;
    out.source_file = step.file;
    out.params = step.params || [];
    const oracles = byId.get(step.bound_method);
    // A bound method the extractor never emitted a record for = the entry-point list and the
    // extraction disagree. Surface it rather than silently reporting zero oracles.
    if (oracles === undefined) { out.oracles = []; out.oracle_lookup = "NOT_IN_EXTRACTOR_OUTPUT"; }
    else out.oracles = oracles;
  } else {
    out.oracles = [];
    if (step.candidates) out.candidates = step.candidates;
  }
  return out;
}

const isMustPin = o => o.recovery === "must_pin";

function emit(bound, oracleRecords) {
  const byId = indexOracles(oracleRecords);
  const bgByFeature = new Map();
  for (const bg of bound.backgrounds || []) bgByFeature.set(bg.feature, bg);

  const records = [];
  for (const sc of bound.scenarios || []) {
    const steps = [];
    // Background steps RUN before every scenario in the feature, so they belong to each scenario's
    // intent — flagged, so the agent knows they come from the shared Background block.
    const bg = bgByFeature.get(sc.feature);
    if (bg) for (const s of bg.steps) steps.push({ ...attach(s, byId), from_background: true });
    for (const s of sc.steps) steps.push(attach(s, byId));

    const all = steps.flatMap(s => s.oracles);
    records.push({
      feature: sc.feature,
      scenario: sc.scenario,
      tags: sc.tags || [],
      type: sc.type,
      ...(sc.examples ? { examples: sc.examples } : {}),
      has_background: !!bg,
      steps,
      oracle_count: all.length,
      must_pin_count: all.filter(isMustPin).length,
      // Fail-safe, mirroring the extractor's REVIEW: a scenario we cannot fully bind is a real gap.
      unbound_steps: steps.filter(s => s.status !== "BOUND").map(s => ({ keyword: s.keyword, text: s.text, status: s.status })),
    });
  }

  // Distinct oracles = what exists in the codebase (vs. what runs, which counts re-used steps once
  // per scenario). Both numbers are honest; reporting only the sum would inflate.
  const distinct = new Map();
  for (const r of oracleRecords) for (const [i, o] of (r.oracles || []).entries()) distinct.set(r.id + "#" + i, o);
  const distinctOracles = [...distinct.values()];

  const summary = {
    features: new Set(records.map(r => r.feature)).size,
    scenarios: records.length,
    scenarios_with_unbound_steps: records.filter(r => r.unbound_steps.length).length,
    distinct_oracles: distinctOracles.length,
    distinct_must_pin: distinctOracles.filter(isMustPin).length,
    oracle_instances_across_scenarios: records.reduce((a, r) => a + r.oracle_count, 0),
    must_pin_instances_across_scenarios: records.reduce((a, r) => a + r.must_pin_count, 0),
    unused_definitions: (bound.unused_definitions || []).length,
  };
  return { summary, records, unused_definitions: bound.unused_definitions || [] };
}

// ---- CLI ---- (guarded so the module can be imported without executing/exiting)
function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const boundPath = opt("--bound", ""), oraclesPath = opt("--oracles", ""), outPath = opt("--out", "");
  if (!boundPath || !oraclesPath) { console.error("usage: node bdd-records.mjs --bound bound.json --oracles oracles.json [--out records.json]"); process.exit(2); }

  const bound = JSON.parse(fs.readFileSync(boundPath, "utf8"));
  const oracleRecords = JSON.parse(fs.readFileSync(oraclesPath, "utf8"));
  const result = emit(bound, oracleRecords);
  const json = JSON.stringify(result, null, 2);
  if (outPath) fs.writeFileSync(outPath, json);

  const s = result.summary;
  console.error(`bdd-records: ${s.features} feature(s), ${s.scenarios} scenario(s) -> ${s.distinct_oracles} distinct oracle(s) (${s.distinct_must_pin} MUST-PIN)`);
  console.error(`bdd-records: across scenarios (re-used steps counted per scenario): ${s.oracle_instances_across_scenarios} oracle instance(s), ${s.must_pin_instances_across_scenarios} must-pin`);
  if (s.scenarios_with_unbound_steps) console.error(`bdd-records: WARN — ${s.scenarios_with_unbound_steps} scenario(s) contain UNBOUND steps (hard-stop at intake)`);
  const lookupMisses = result.records.flatMap(r => r.steps).filter(x => x.oracle_lookup === "NOT_IN_EXTRACTOR_OUTPUT");
  if (lookupMisses.length) console.error(`bdd-records: WARN — ${lookupMisses.length} bound step(s) had no extractor record (entry-point list and extraction disagree)`);
  if (outPath) console.error(`bdd-records: wrote ${outPath}`);
  if (!outPath) console.log(json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { emit, indexOracles };
