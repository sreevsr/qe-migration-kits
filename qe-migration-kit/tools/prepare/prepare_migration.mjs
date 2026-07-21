#!/usr/bin/env node
/**
 * prepare_migration.mjs — deterministic context-slicer (ZERO tokens).
 *
 * Turns the extractor's records.json + the Java repo into minimal "migration packs":
 *   - one PAGE-OBJECTS pack (all non-test classes) — migrated ONCE
 *   - one pack PER TEST CLASS (its source + its pinned oracles) — migrated one at a time
 *
 * The point is token frugality: the agent is fed exactly the slice it needs for each unit,
 * never the whole repo, and the oracles are pre-computed so the agent spends no tokens
 * inferring intent. Everything here is deterministic file work — no LLM, no network.
 *
 * Usage:
 *   node prepare_migration.mjs --records <records.json> --repo <suite-root> --out <packs-dir>
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const RECORDS = opt("--records", "records.json");
const REPO = opt("--repo", ".");
const OUT = opt("--out", "migration-packs");

// ---- BATCHING (for engagements too large to migrate in one go) ----
// --only  A,B,C | --only-file <f>   : migrate ONLY these classes; the rest are DEFERRED (later batch)
// --skip  A,B,C | --skip-file <f>   : exclude these WITH A REASON; they are SKIPPED (never migrated)
// A skip file allows a reason per line:   WaitTypesTest   # flaky at source, quarantined
// The distinction is deliberate and auditable: "deferred" = not yet, "skipped" = decided against.
function parseList(inline, file) {
  const out = new Map();   // name -> reason|null
  if (inline) for (const t of inline.split(",").map(x => x.trim()).filter(Boolean)) out.set(t, null);
  if (file && fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const hash = line.indexOf("#");
      const name = (hash >= 0 ? line.slice(0, hash) : line).trim();
      const reason = hash >= 0 ? line.slice(hash + 1).trim() : null;
      if (name) out.set(name, reason);
    }
  }
  return out;
}
const ONLY = parseList(opt("--only", ""), opt("--only-file", ""));
const SKIP = parseList(opt("--skip", ""), opt("--skip-file", ""));
// --batch-size N --batch K : migrate the Kth chunk of N classes (1-based). At 300 tests, naming 30
// classes per batch by hand is unusable and loses tests silently; this makes "batches of 30" a
// two-flag instruction. Order is the SORTED class list, so batch K is stable across runs and any
// two people get the same slice. Composes with the others: SKIP is removed first, then ONLY filters,
// then the remainder is chunked.
const BATCH_SIZE = parseInt(opt("--batch-size", "0"), 10) || 0;
const BATCH_NO = parseInt(opt("--batch", "1"), 10) || 1;

// ---- gather every .java file under the repo, index by simple class name ----
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/(^|\/)(target|node_modules|\.git)$/.test(p)) walk(p, acc); }
    else if (e.name.endsWith(".java")) acc.push(p);
  }
  return acc;
}
const javaFiles = walk(REPO);
const norm = (p) => p.replace(/\\/g, "/");
const isTest = (p) => norm(p).includes("/tests/");
const nonTest = javaFiles.filter(p => !isTest(p));

// ---- load oracles, group by test class ----
const records = JSON.parse(fs.readFileSync(RECORDS, "utf8"));
const byClass = new Map();
for (const r of records) {
  const cls = r.id.slice(0, r.id.lastIndexOf("."));
  if (!byClass.has(cls)) byClass.set(cls, []);
  byClass.get(cls).push(r);
}

// ---- resolve the batch scope -------------------------------------------------------------
// Fail loudly on a name that matches no class: a typo in --only would otherwise silently migrate
// NOTHING, or a typo in --skip would silently migrate something you meant to exclude.
const allClasses = [...byClass.keys()];
const unknown = [...ONLY.keys(), ...SKIP.keys()].filter(n => !allClasses.includes(n));
if (unknown.length) {
  console.error(`\nERROR: --only/--skip named ${unknown.length} class(es) that do not exist in records.json:`);
  for (const u of unknown) console.error(`  - ${u}`);
  console.error(`\nKnown classes: ${allClasses.join(", ")}`);
  process.exit(2);
}
const batch = { in_scope: [], deferred: [], skipped: [] };
const candidates = [];
for (const cls of allClasses) {
  if (SKIP.has(cls)) batch.skipped.push({ name: cls, reason: SKIP.get(cls) || "no reason given" });
  else if (ONLY.size && !ONLY.has(cls)) batch.deferred.push(cls);
  else candidates.push(cls);
}
if (BATCH_SIZE > 0) {
  const ordered = [...candidates].sort();            // stable slice: same batch K for everyone
  const totalBatches = Math.ceil(ordered.length / BATCH_SIZE);
  if (BATCH_NO < 1 || BATCH_NO > totalBatches) {
    console.error(`\nERROR: --batch ${BATCH_NO} is out of range. ${ordered.length} migratable class(es) at --batch-size ${BATCH_SIZE} = ${totalBatches} batch(es).`);
    process.exit(2);
  }
  const start = (BATCH_NO - 1) * BATCH_SIZE;
  batch.in_scope = ordered.slice(start, start + BATCH_SIZE);
  batch.deferred.push(...ordered.filter(c => !batch.in_scope.includes(c)));
  batch.batch = { index: BATCH_NO, size: BATCH_SIZE, total_batches: totalBatches, migratable: ordered.length };
} else {
  batch.in_scope = candidates;
}
const batching = ONLY.size > 0 || SKIP.size > 0 || BATCH_SIZE > 0;

// Classes EARLIER batches already migrated (from the ledger). The migrated suite is ONE project that
// GROWS — so the gate re-verifies everything migrated so far, not just this batch, and the summary
// must account for them. Reporting only "in scope / deferred / skipped" makes the arithmetic not add
// up against the class total, which reads like a bug even when the tool is right.
let ALREADY = [];

// ---- LEDGER (append-only, spans batches) + DRIFT DETECTION -------------------------------
// Batches are slices of the SORTED class list. If the source suite gains or loses a class between
// batches, that list shifts and "--batch 4" silently covers a DIFFERENT set — you re-migrate one
// class and skip another, with nothing to notice. So fingerprint the list and refuse to continue a
// batched run whose fingerprint moved. This is the check that prevents silent test loss on a
// long-running engagement against an active repo.
const FINGERPRINT = crypto.createHash("sha256").update([...allClasses].sort().join("\n")).digest("hex").slice(0, 12);
// --ledger <path>: the ledger spans BATCHES, so it must not live in the packs dir (which is rewritten
// every prepare and is "the current batch"). The orchestrator passes the WORK dir explicitly, because
// its --out is the work dir while the slicer's --out is <work>/migration-packs. Getting this wrong
// writes a ledger nobody reads: the slicer reports "1 batch(es) recorded" and `status` shows nothing.
const LEDGER_PATH = opt("--ledger", path.join(OUT, "migration-ledger.json"));
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")); }
  catch { return { suite: path.resolve(REPO), fingerprint: FINGERPRINT, class_count: allClasses.length, created: new Date().toISOString(), batches: [], skipped: [] }; }
}
const ledger = loadLedger();
{
  const label = BATCH_SIZE > 0 ? BATCH_NO : `only:${[...ONLY.keys()].join("+")}`;
  const prior = (ledger.batches || []).filter(b => String(b.batch) !== String(label));
  ALREADY = [...new Set(prior.flatMap(b => b.classes || []))];
  // Attach NOW, not later: the INDEX and the console summary are built further down and both need
  // it. Assigning it just before batch.json is written left them reporting batch 1's finished
  // classes as "deferred" and made the class arithmetic not add up.
  batch.already_migrated = ALREADY.filter(c => !batch.in_scope.includes(c));
  batch.deferred = batch.deferred.filter(c => !batch.already_migrated.includes(c));
}
if (batching && ledger.batches.length && ledger.fingerprint !== FINGERPRINT) {
  console.error(`\nERROR: the source suite's class list CHANGED since this ledger started.`);
  console.error(`  ledger fingerprint : ${ledger.fingerprint}  (${ledger.class_count} classes)`);
  console.error(`  current fingerprint: ${FINGERPRINT}  (${allClasses.length} classes)`);
  console.error(`\nBatches are slices of the sorted class list, so the boundaries have MOVED: "--batch ${BATCH_NO}"`);
  console.error(`no longer means what it meant in earlier batches. Some classes would be migrated twice and`);
  console.error(`others skipped silently. Re-plan the batches against the new list (start a fresh --out),`);
  console.error(`or pass --accept-drift if you know exactly why the list changed and accept the consequence.`);
  if (!args.includes("--accept-drift")) process.exit(3);
  console.error(`\n--accept-drift given: continuing anyway. This is recorded in the ledger.`);
}

fs.mkdirSync(OUT, { recursive: true });
// Clear packs from a previous slice. Without this, batch 2 leaves batch 1's packs sitting in the
// directory and an agent told "translate the packs here" re-translates finished work. The INDEX
// describes exactly what is in this directory; the directory must match it.
for (const f of fs.readdirSync(OUT)) if (f.endsWith(".md")) fs.unlinkSync(path.join(OUT, f));

// ---- PACK 1: the abstraction layer (page objects, components, base, utils, api) — migrate once ----
function fileBlock(p) {
  const rel = norm(path.relative(REPO, p));
  return `\n### ${rel}\n\`\`\`java\n${fs.readFileSync(p, "utf8").trimEnd()}\n\`\`\`\n`;
}
// order: base first, then pages/components/objects/api/utils (helps the agent build bottom-up)
const rank = (p) => { p = norm(p);
  if (p.includes("/base/")) return 0; if (p.includes("/objects/")) return 1;
  if (p.includes("/components/")) return 2; if (p.includes("/pages/")) return 3;
  if (p.includes("/api/")) return 4; if (p.includes("/utils/") || p.includes("/util/")) return 5;
  if (p.includes("/factory/")) return 6; return 7; };
const layer = [...nonTest].sort((a, b) => rank(a) - rank(b));
let po = (ALREADY.length
  ? `# Migration Pack 00 — Abstraction Layer — ALREADY MIGRATED (reference only)\n\n`
    + `> **Do NOT re-translate this pack.** It was migrated in an earlier batch and your page objects\n`
    + `> already exist. Re-generating them would rewrite files that earlier batches' specs depend on,\n`
    + `> and the gate re-verifies those specs on every batch. Use this only to look something up.\n\n`
  : `# Migration Pack 00 — Abstraction Layer (migrate ONCE, first)\n\n`)
  + `These are the non-test classes: base, page objects, components, data objects, API helpers,\n`
  + `utils. Migrate them to Playwright + TypeScript page objects FIRST, following contracts/helper_contract.md.\n`
  + `The test packs below assume these already exist. Keep the same class/method names so the tests line up.\n`;
for (const p of layer) po += fileBlock(p);
fs.writeFileSync(path.join(OUT, "00_page_objects.md"), po);

// ---- PACK per test class: source + its pinned oracles (the translation spec) ----
const index = [];
for (const [cls, recs] of byClass) {
  if (!batch.in_scope.includes(cls)) continue;   // deferred or skipped -> no pack, no tokens
  const file = nonTest.concat(javaFiles).find(p => path.basename(p) === cls + ".java")
    || javaFiles.find(p => path.basename(p) === cls + ".java");
  if (!file) continue;
  let md = `# Migration Pack — ${cls}\n\n`
    + `Translate this ONE test class to a Playwright + TypeScript spec, following\n`
    + `contracts/helper_contract.md and reusing the page objects from pack 00.\n\n`
    + `## Oracles to PRESERVE (the extractor pinned these — do not drop or invent)\n`;
  let mp = 0, tot = 0;
  for (const r of recs) {
    md += `\n**${r.id}**  (tags: ${(r.tags || []).join(", ") || "none"})\n\n`;
    md += `| keep? | check | type |\n|---|---|---|\n`;
    for (const o of r.oracles) {
      tot++; if (o.recovery === "must_pin") mp++;
      const keep = o.recovery === "must_pin" ? "**MUST-PIN**" : "derive";
      md += `| ${keep} | \`${o.subject} ${o.relation} ${o.expected}\` | ${o.type} |\n`;
    }
  }
  md = md.replace("## Oracles to PRESERVE",
    `> ${recs.length} test method(s), ${tot} oracle(s), ${mp} must-pin. MUST-PIN checks are non-negotiable: the generated Playwright must assert each one, or the gate will BLOCK.\n\n## Oracles to PRESERVE`);
  md += `\n## Source (translate this)\n\`\`\`java\n${fs.readFileSync(file, "utf8").trimEnd()}\n\`\`\`\n`;
  fs.writeFileSync(path.join(OUT, `${cls}.md`), md);
  index.push({ cls, methods: recs.length, mustpin: mp });
}

// ---- INDEX with token guidance ----
let idx = `# Migration Packs — index & run order\n\n`
  + `Generated from ${path.basename(RECORDS)}. Migrate in this order:\n\n`
  + (ALREADY.length
      ? `1. ~~**00_page_objects.md**~~ — **ALREADY MIGRATED in an earlier batch. Do NOT re-translate it.**\n`
        + `   Your page objects already exist; reuse them. Re-generating them would rewrite files that\n`
        + `   earlier batches' specs depend on. The pack is included below only as reference.\n`
      : `1. **00_page_objects.md** — the abstraction layer, migrate ONCE (this batch).\n`)
  + index.map((e, i) => `${i + 2}. **${e.cls}.md** — ${e.methods} method(s), ${e.mustpin} must-pin.`).join("\n")
  + `\n\n## Token discipline\n`
  + `- Feed the agent ONE pack at a time. Never paste the whole repo.\n`
  + `- The oracles are already extracted — do not ask the agent to "figure out what to test".\n`
  + `- After each spec, run the gate (deterministic, 0 tokens). Only re-prompt on a real BLOCK,\n`
  + `  and include the gate's specific message — never a blind "try again".\n`;
// ---- batch manifest: what is in scope, what is deferred, what is skipped AND WHY ----------
// This is the auditable record. A migration that quietly covers 250 of 300 tests is a liability;
// one that states "250 migrated, 30 deferred to batch 2, 20 skipped [reasons]" is evidence.
if (batching) {
  idx += `\n## Batch scope\n`
    + (batch.batch ? `**Batch ${batch.batch.index} of ${batch.batch.total_batches}** (size ${batch.batch.size}, ${batch.batch.migratable} migratable classes).\n`
       + (batch.batch.index >= batch.batch.total_batches
            ? `This is the LAST batch — nothing further to prepare after this one.\n\n`
            : `Next: re-run prepare with \`--batch ${batch.batch.index + 1}\` (same \`--batch-size ${batch.batch.size}\`).\n\n`) : "")
    + `- **in scope (packed): ${batch.in_scope.length}** — ${batch.in_scope.join(", ") || "(none)"}\n`
    + ((batch.already_migrated || []).length
        ? `- **already migrated: ${batch.already_migrated.length}** (earlier batches; no pack needed. The gate RE-VERIFIES these — the migrated suite is ONE project checked as a whole) — ${batch.already_migrated.join(", ")}\n`
        : "");
  if (batch.deferred.length)
    idx += `- **deferred: ${batch.deferred.length}** (not this batch; no pack written) — ${batch.deferred.join(", ")}\n`;
  if (batch.skipped.length) {
    idx += `- **skipped: ${batch.skipped.length}** (deliberately excluded)\n\n| class | reason |\n|---|---|\n`;
    for (const sk of batch.skipped) idx += `| \`${sk.name}\` | ${sk.reason} |\n`;
  }
  idx += `\nPass \`--scope <batch.json>\` to the gate so deferred/skipped classes report as DEFERRED\n`
    + `instead of BLOCK — without it, every unmigrated class with a must-pin looks like a lost oracle.\n`;
  fs.writeFileSync(path.join(OUT, "INDEX.md"), idx);
}
fs.writeFileSync(path.join(OUT, "INDEX.md"), idx);

// batch.json is consumed by the gate (--scope) and the orchestrator's report
batch.generated_from = path.basename(RECORDS);
batch.total_classes = allClasses.length;
batch.fingerprint = FINGERPRINT;

fs.writeFileSync(path.join(OUT, "batch.json"), JSON.stringify(batch, null, 2));

// Append this batch to the ledger. batch.json is the CURRENT slice (overwritten every prepare);
// the ledger is the HISTORY (what was migrated, when, and what was skipped and why) — the record a
// customer is owed at the end of a 10-batch engagement, and what `status` reads to answer "resume?".
if (batching) {
  ledger.fingerprint = FINGERPRINT;
  ledger.class_count = allClasses.length;
  const label = batch.batch ? batch.batch.index : `only:${batch.in_scope.join("+")}`;
  const prior = ledger.batches.find(b => String(b.batch) === String(label));
  const entry = {
    batch: label,
    size: batch.batch ? batch.batch.size : batch.in_scope.length,
    total_batches: batch.batch ? batch.batch.total_batches : 1,
    prepared_at: new Date().toISOString(),
    classes: batch.in_scope,
    validated_at: null, gate: null, playwright: null,
    ...(args.includes("--accept-drift") ? { drift_accepted: true } : {}),
  };
  if (prior) Object.assign(prior, entry, { validated_at: prior.validated_at, gate: prior.gate, playwright: prior.playwright, re_prepared_at: entry.prepared_at });
  else ledger.batches.push(entry);
  for (const sk of batch.skipped)
    if (!ledger.skipped.some(x => x.name === sk.name))
      ledger.skipped.push({ name: sk.name, reason: sk.reason, at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  console.log(`Ledger: ${LEDGER_PATH} \u2014 ${ledger.batches.length} batch(es) recorded, ${ledger.skipped.length} class(es) skipped.`);
}

console.log(`Prepared ${index.length} test pack(s) + 1 page-objects pack + INDEX -> ${OUT}/`);
console.log(`Slices are minimal by design: page objects once, then one test class at a time.`);
if (batching) {
  if (batch.batch) console.log(`\nBatch ${batch.batch.index} of ${batch.batch.total_batches} (size ${batch.batch.size}) — ${batch.batch.migratable} migratable class(es) after skips.`);
  const alreadyN = (batch.already_migrated || []).length;
  console.log(`${batch.batch ? "" : "\n"}Batch scope: ${batch.in_scope.length} in scope${alreadyN ? ` · ${alreadyN} already migrated (earlier batches, re-verified by the gate)` : ""} · ${batch.deferred.length} deferred · ${batch.skipped.length} skipped = ${batch.in_scope.length + alreadyN + batch.deferred.length + batch.skipped.length} of ${allClasses.length} classes`);
  for (const sk of batch.skipped) console.log(`  skipped: ${sk.name} \u2014 ${sk.reason}`);
  if (batch.batch && batch.batch.index < batch.batch.total_batches)
    console.log(`Next batch: re-run prepare with --batch ${batch.batch.index + 1} (same --batch-size ${batch.batch.size}).`);
  console.log(`Wrote ${path.join(OUT, "batch.json")} \u2014 pass it to the gate as --scope so deferred/skipped classes report DEFERRED, not BLOCK.`);
}
