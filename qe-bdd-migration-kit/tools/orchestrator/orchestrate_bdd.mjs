#!/usr/bin/env node
/**
 * orchestrate_bdd.mjs — deterministic BDD migration driver (ZERO tokens; calls no LLM).
 *
 *   prepare  : classpath -> feature-parser -> step-binder -> di-resolver -> SHARED extractor
 *              (--entry-points) -> bdd-records (join) -> slice  (+ copies .feature files verbatim)
 *   validate : SHARED gate (--bdd) -> bddgen -> tsc --noEmit -> playwright test
 *   status   : which step-class packs are migrated vs pending
 *   report   : consolidated run report (json + md)
 *
 * WHY A SIBLING ORCHESTRATOR (not a --bdd flag on the TestNG one):
 * the extractor and the gate differ by ONE line between modes, so they take an additive flag and
 * stay shared. The prepare CHAIN genuinely differs (6 tools vs 3), so forcing one function to do
 * both would be worse than two clear ones. The expensive, tuned components stay shared; only the
 * sequencing is duplicated.
 *
 * Exit codes: 0 ok · 2 usage/bad --suite · 11 prereq missing · 12 classpath failed ·
 *   15 UNBOUND/AMBIGUOUS steps · 20 gate BLOCK · 30 bddgen/tsc · 40 playwright.
 */
import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

// ---- migration.json ------------------------------------------------------------------------
// Written by init.mjs. When a flag is omitted we read it from here, so nobody retypes four absolute
// paths into a chat box. Explicit flags ALWAYS win, so every existing command keeps working.
function loadMigrationConfig() {
  for (const dir of [process.cwd(), path.resolve(process.cwd(), "..")]) {
    const p = path.join(dir, "migration.json");
    if (!fs.existsSync(p)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      return {
        _from: p,
        suite: c.suite,
        kit: c.kit,
        testngKit: c.testngKit,
        out: c.work ? path.resolve(dir, c.work) : undefined,
        pw: c.pw ? path.resolve(dir, c.pw) : undefined,
        kind: c.kind,
      };
    } catch { /* malformed — fall through to flags rather than dying on it */ }
  }
  return {};
}
const CFG = loadMigrationConfig();

const DRY = has("--dry-run");

// This script lives at <KIT>/tools/orchestrator/orchestrate_bdd.mjs, so it can always work out its
// own kit regardless of the user's working directory. The old "." fallback also poisoned TESTNG_KIT
// below, which is derived from KIT — one wrong CWD broke both. init.mjs has always done it this way.
const SELF_KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIT = path.resolve(opt("--kit") || CFG.kit || SELF_KIT);                // the BDD kit
const TESTNG_KIT = path.resolve(opt("--testng-kit") || CFG.testngKit || path.join(KIT, "..", "qe-migration-kit"));  // shared extractor + gate
const SUITE = opt("--suite") || CFG.suite || "";
const OUT = path.resolve(opt("--out") || CFG.out || ".");
const PW = opt("--pw") || CFG.pw || "";
const REPORT = path.join(OUT, "migration-run-report.json");

const F = {
  features: () => path.join(OUT, "features.json"),
  bound:    () => path.join(OUT, "bound.json"),
  entry:    () => path.join(OUT, "entry-points.txt"),
  fixtures: () => path.join(OUT, "fixtures.json"),
  oracles:  () => path.join(OUT, "oracles.json"),
  records:  () => path.join(OUT, "records.json"),
  packs:    () => path.join(OUT, "migration-packs"),
};

function loadReport() { try { return JSON.parse(fs.readFileSync(REPORT, "utf8")); } catch { return { started: new Date().toISOString(), kind: "bdd", steps: [] }; } }
function saveReport(r) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(REPORT, JSON.stringify(r, null, 2)); }

function run(step, command, cwd, envOverride) {
  const rep = loadReport();
  console.log(`\n\u25b6 ${step}\n  $ ${command}`);
  if (DRY) { rep.steps.push({ step, command, status: "dry-run", when: new Date().toISOString() }); saveReport(rep); return { ok: true, out: "" }; }
  const t0 = Date.now();
  // Capture BOTH streams. The Node tools print their summaries to stderr (so that JSON can go to
  // stdout when --out is omitted) — execSync returns stdout ONLY, which silently swallowed every
  // "BOUND 24 · UNBOUND 0", "9 unused definitions", "copied 4 .feature file(s)" line. Those
  // summaries are the evidence of the run; losing them makes the orchestrator look like it did
  // nothing between steps.
  const r = spawnSync(command, { cwd, encoding: "utf8", shell: true, maxBuffer: 1 << 26, env: envOverride ? { ...process.env, ...envOverride } : process.env });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (out.trim()) console.log(out.trimEnd());
  const ok = r.status === 0;
  rep.steps.push({ step, command, status: ok ? "ok" : "FAILED", seconds: ((Date.now() - t0) / 1000).toFixed(1), when: new Date().toISOString() }); saveReport(rep);
  return { ok, out };
}

// Corporate machines run a TLS-inspecting proxy that re-signs responses with a private root CA that
// lives in the MACHINE store, which Node does not consult by default — npm then dies on a cert error
// nothing to do with the kit. `--use-system-ca` is a NODE flag (hence NODE_OPTIONS), needs Node
// 22.15+, and an unknown NODE_OPTIONS entry stops node starting AT ALL — so never set it
// unconditionally. Try clean; retry only when the failure actually looks like a certificate problem.
function npmInstall(step, dir, extra = "") {
  const cmd = `npm install${extra}`;
  const r = run(step, cmd, dir);
  if (r.ok) return r;
  if (!/self.signed|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|CERT_|certificate|SSL routines/i.test(r.out || "")) return r;
  console.log(`\n  \u2139 npm failed on a CERTIFICATE error \u2014 almost always a corporate TLS-inspecting proxy`);
  console.log(`    whose root CA Node does not trust. Retrying with NODE_OPTIONS=--use-system-ca ...`);
  const merged = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--use-system-ca`;
  const r2 = run(`${step} (retry with --use-system-ca)`, cmd, dir, { NODE_OPTIONS: merged });
  if (r2.ok) {
    console.log(`\n  \u2713 Succeeded using the machine's CA store. To skip the retry every run:`);
    console.log(`    $env:NODE_OPTIONS="--use-system-ca"   (PowerShell)`);
    return r2;
  }
  if (/bad option|not allowed in NODE_OPTIONS/i.test(r2.out || ""))
    console.log(`\n  \u26d4 This Node (${process.version}) does not support --use-system-ca (needs 22.15+). Upgrade Node,\n    or:  npm config set cafile <path-to-your-proxy-root.pem>`);
  else
    console.log(`\n  \u26d4 Still failing with the system CA store \u2014 the proxy root cert is not in the machine\n    store, or the registry is blocked. Environment issue, not the kit.`);
  return r2;
}

function stopGate(code, msg) {
  console.error(`\n\u26d4 HARD-STOP (${code}): ${msg}`);
  const rep = loadReport(); rep.stopped = { code, msg, at: new Date().toISOString() }; saveReport(rep);
  process.exit(code);
}
function toolPresent(p) { try { execSync(p, { stdio: "ignore" }); return true; } catch { return false; } }

function setup() {
  console.log("\u2699  setup \u2014 checking prerequisites and shared tools\n");
  const need = [["java -version", "JDK 21 (extractor)"], ["mvn -v", "Maven (classpath)"], ["node -v", "Node 22.15+"], ["npx -v", "npx"]];
  const missing = need.filter(([p]) => !toolPresent(p)).map(([, n]) => n);
  if (missing.length) stopGate(11, `missing prerequisite(s): ${missing.join(", ")}. Install, then open a FRESH terminal (PATH changes only apply to new terminals).`);
  console.log("  \u2713 prerequisites present (java, mvn, node, npx)");

  const jar = path.join(TESTNG_KIT, "tools", "extractor", "target", "qe-extractor.jar");
  if (!fs.existsSync(jar)) {
    console.log("  \u2026 building the shared extractor jar");
    const r = run("build-extractor", `mvn -q -f "${path.join(TESTNG_KIT, "tools", "extractor", "pom.xml")}" clean package`);
    if (!r.ok) stopGate(11, `could not build the shared extractor at ${TESTNG_KIT}. Pass --testng-kit <path-to-qe-migration-kit>.`);
  }
  console.log("  \u2713 shared extractor jar ready");
  const gate = path.join(TESTNG_KIT, "tools", "gate", "parity_check_ast.mjs");
  if (!fs.existsSync(gate)) stopGate(11, `shared gate not found at ${gate}. Pass --testng-kit <path-to-qe-migration-kit>.`);
  if (!fs.existsSync(path.join(TESTNG_KIT, "tools", "gate", "node_modules"))) {
    console.log("  \u2026 installing gate deps (ts-morph)");
    const gi = npmInstall("npm-gate", path.join(TESTNG_KIT, "tools", "gate"), " --silent");
    if (!gi.ok) stopGate(11, `npm install failed for the shared gate (ts-morph). See the diagnosis above.\n   Left unchecked this surfaces much later as "Cannot find module 'ts-morph'", which points at the\n   gate instead of at npm.`);
  }
  console.log("  \u2713 shared gate ready");
  console.log("\n\u2705 setup complete.\n");
}

function prepare() {
  if (!has("--no-setup")) setup();
  if (!SUITE) stopGate(2, "prepare needs --suite <cucumber-suite-root>");
  fs.mkdirSync(OUT, { recursive: true });
  // A new prepare supersedes any earlier stop (e.g. a resolved exit-15 on unbound steps). If this
  // run stops again, stopGate re-sets it.
  { const rep = loadReport(); delete rep.stopped; saveReport(rep); }
  const T = (...p) => path.join(KIT, "tools", ...p);
  const cp = path.join(SUITE, "cp.txt");
  const jar = path.join(TESTNG_KIT, "tools", "extractor", "target", "qe-extractor.jar");

  // Check the SUITE up front — a wrong --suite otherwise sails past the classpath step and surfaces
  // as a Java NoSuchFileException about cp.txt inside the extractor, pointing at the wrong component.
  if (!fs.existsSync(SUITE)) stopGate(2, `--suite path does not exist: ${SUITE}\n   Pass the FULL path to the source suite root (the folder containing pom.xml).`);
  if (!fs.existsSync(path.join(SUITE, "pom.xml"))) stopGate(2, `no pom.xml in --suite: ${SUITE}\n   --suite must be the Maven project ROOT, not a subfolder.`);

  const cpRun = run("classpath", `mvn -q -f "${path.join(SUITE, "pom.xml")}" dependency:build-classpath "-Dmdep.outputFile=cp.txt"`);
  if (!cpRun.ok && !DRY) stopGate(12, `Maven could not build the classpath for ${SUITE}.\n   The real error is in the Maven output above. Fix that first \u2014 the extractor needs cp.txt to resolve types.`);
  if (!DRY && !fs.existsSync(cp)) stopGate(12, `Maven reported success but ${cp} was not written. Check the Maven output above.`);
  run("feature-parser", `node "${T("feature-parser", "feature-parser.mjs")}" --repo "${SUITE}" --out "${F.features()}"`);
  const bind = run("step-binder", `node "${T("step-binder", "step-binder.mjs")}" --repo "${SUITE}" --features "${F.features()}" --out "${F.bound()}" --entry-points-out "${F.entry()}"`);
  run("di-resolver", `node "${T("di-resolver", "di-resolver.mjs")}" --repo "${SUITE}" --out "${F.fixtures()}"`);

  // HARD-STOP 1 (part a): an UNBOUND step is a Gherkin step with no definition — a real gap. Never
  // migrate past it silently. (Unused DEFINITIONS are the reverse: dead glue, reported not stopped.)
  if (!DRY) {
    try {
      const b = JSON.parse(fs.readFileSync(F.bound(), "utf8"));
      const rep = loadReport();
      rep.binding = { bound: b.bound, unbound: b.unbound, ambiguous: b.ambiguous, unused_definitions: (b.unused_definitions || []).length };
      saveReport(rep);
      if (b.unbound > 0 || b.ambiguous > 0)
        stopGate(15, `${b.unbound} UNBOUND and ${b.ambiguous} AMBIGUOUS step(s) — a Gherkin step with no (or several) matching definition(s). Resolve with the suite owner before migrating; see unbound/ambiguous entries in ${F.bound()}.`);
    } catch { /* binder output unreadable -> the run() above already showed why */ }
  }

  const ext = run("extract (shared classifier, entry-points mode)", `java -jar "${jar}" "${SUITE}" "${cp}" "${F.oracles()}" --entry-points "${F.entry()}"`);
  if (!ext.ok && !DRY) stopGate(2, "the shared extractor failed (see output above)");
  if (!DRY && /WARN: \d+ entry point\(s\) supplied but not found/.test(ext.out))
    console.log("\n\u26a0  Some entry points were not found in the parsed sources (see WARN above) \u2014 the binder and the extractor disagree. Investigate before trusting the oracle counts.");
  // INTAKE VISIBILITY. ExtractorPhase4 prints a "By origin:" line classifying every oracle. It
  // streams past in a wall of output and is never explained. Re-surface it HERE, because HARD-STOP 1
  // is where a human decides whether this suite is worth migrating — and `literal` is the number
  // that answers that for a localization suite.
  //
  // `literal` (records.json calls the same origin `ui_literal`) = an assertion compared against a
  // hardcoded string. It classifies as DERIVE, so the gate will NOT block if it is lost. That is
  // right for `"Login"` — anyone can check the page against it — and wrong for `"Bienvenue"`, which
  // is a translation: external data somebody inlined. No tool can tell those two apart from source,
  // because the hardcoding erased the provenance. A human can, in seconds, IF shown the count.
  // So show it, explain it, and guess nothing.
  const byOrigin = (ext.out || "").split("\n").find(l => l.startsWith("By origin:"));
  if (byOrigin) {
    const lit = parseInt((byOrigin.match(/literal=(\d+)/) || [0, "0"])[1], 10);
    const unk = parseInt((byOrigin.match(/unknown=(\d+)/) || [0, "0"])[1], 10);
    console.log("\n" + byOrigin);
    if (lit > 0) {
      console.log(`  NOTE  ${lit} assertion(s) compare against a hardcoded string (literal).`);
      console.log("        Classified DERIVE — losing one is NEEDS-HUMAN, not BLOCK.");
      console.log("        If any are LOCALIZED text, that expected value is external data that was");
      console.log("        inlined. It belongs in a resource bundle, and the fix is in the source");
      console.log("        suite, not in the migration. Worth checking before you confirm intake.");
    }
    if (unk > 0) console.log(`  NOTE  ${unk} oracle(s) could not be traced (unknown) -> REVIEW, pinned fail-safe.`);
  }

  run("bdd-records (join)", `node "${T("bdd-records", "bdd-records.mjs")}" --bound "${F.bound()}" --oracles "${F.oracles()}" --out "${F.records()}"`);
  // Batching by FEATURE. The ledger belongs in the WORK dir (validate/status read it there), NOT in
  // the packs dir which is rewritten every prepare.
  const batchArgs = ["--only-features", "--only-features-file", "--skip-features", "--skip-features-file", "--batch-size", "--batch"]
    .filter(k => opt(k, "")).map(k => `${k} "${opt(k, "")}"`).join(" ")
    + (has("--accept-drift") ? " --accept-drift" : "");
  const ledgerArg = batchArgs.trim() ? ` --ledger "${path.join(OUT, "migration-ledger.json")}"` : "";
  run("slice", `node "${T("prepare", "prepare_bdd.mjs")}" --records "${F.records()}" --bound "${F.bound()}" --fixtures "${F.fixtures()}" --repo "${SUITE}" --out "${F.packs()}"${PW ? ` --pw "${PW}"` : ""}${batchArgs.trim() ? " " + batchArgs.trim() : ""}${ledgerArg}`);

  console.log("\n\u2139  Baseline health assumed valid/green (established at intake by the suite owner). Proceeding \u2014 migrating scenario INTENT, which is intact regardless of Selenium-runtime flakiness.");
  console.log(`\nPrepared. HARD-STOP 1: confirm the source suite is valid/representative, then the agent translates`);
  console.log(`migration-packs/ (00_page_objects.md first, then one step-class pack at a time), then run 'validate'.`);
  if (!PW) console.log(`NOTE: no --pw given, so the .feature files were NOT copied. Pass --pw <playwright-dir> to copy them (0 tokens).`);
}

function parseGate(out) {
  const mp = out.match(/must-pin recovery:\s*(\d+)\/(\d+)/);
  const v = out.match(/PASS (\d+) \| NEEDS-HUMAN (\d+) \| BLOCK (\d+)/);
  return { mpFound: mp ? +mp[1] : null, mpTotal: mp ? +mp[2] : null, pass: v ? +v[1] : null, needsHuman: v ? +v[2] : null, block: v ? +v[3] : null };
}
function parsePlaywright(out) {
  const p = out.match(/(\d+) passed/), f = out.match(/(\d+) failed/);
  return { passed: p ? +p[1] : 0, failed: f ? +f[1] : 0 };
}

function validate() {
  const gen = opt("--generated", PW);
  if (!gen) stopGate(2, "validate needs --generated <playwright-project> (or --pw)");
  const batchFile = path.join(F.packs(), "batch.json");
  const scopeArg = fs.existsSync(batchFile) ? ` --scope "${batchFile}"` : "";
  const verdictsPath = path.join(OUT, "verdicts.json");   // emitted automatically; report() reads it
  const gate = run("gate (shared, --bdd)", `node "${path.join(TESTNG_KIT, "tools", "gate", "parity_check_ast.mjs")}" --oracles "${F.oracles()}" --generated "${gen}" --bdd${scopeArg} --emit "${verdictsPath}"`);
  const g = DRY ? {} : parseGate(gate.out);
  if (!DRY && g.block > 0) {
    const rep = loadReport(); rep.gate = g;
    for (let i = rep.steps.length - 1; i >= 0; i--) { const s = rep.steps[i]; if (s.step.startsWith("gate") && s.block === undefined) { s.pass = g.pass; s.needsHuman = g.needsHuman; s.block = g.block; break; } }
    saveReport(rep);
    stopGate(20, `gate reports ${g.block} BLOCK (a must-pin lost). Review the SPECIFIC gate line with the agent \u2014 do not blind-regenerate.`);
  }
  const cwd = PW || undefined;
  const bg = run("bddgen", `npx bddgen`, cwd);
  if (!bg.ok && !DRY) stopGate(30, "npx bddgen failed \u2014 usually a step definition that does not match its .feature text, or a missing steps/ path in playwright.config.ts.");
  const tsc = run("tsc", `npx tsc --noEmit`, cwd);
  if (!tsc.ok && !DRY) stopGate(30, "tsc --noEmit failed. Fix the compile errors before running Playwright.");
  const pw = run("playwright", `npx playwright test`, cwd);
  const p = DRY ? {} : parsePlaywright(pw.out);
  const rep = loadReport();
  for (let i = rep.steps.length - 1; i >= 0; i--) { const s = rep.steps[i]; if (s.step === "playwright" && s.passed === undefined) { s.passed = p.passed; s.failed = p.failed; break; } }
  for (let i = rep.steps.length - 1; i >= 0; i--) { const s = rep.steps[i]; if (s.step.startsWith("gate") && s.block === undefined) { s.pass = g.pass; s.needsHuman = g.needsHuman; s.block = g.block; break; } }
  // A `stopped` record describes a run that HALTED. Getting here means gate+bddgen+tsc all passed,
  // so any earlier stop is resolved — clear it. Without this, `stopped` is write-only and every
  // later report carries a stale "STOPPED: a must-pin lost" line alongside "BLOCK 0 / all passed",
  // contradicting itself. The report is the hand-off artifact; it must describe the CURRENT state.
  // Safe: if Playwright fails on the next line, stopGate(40) immediately re-sets it — so a stop is
  // only ever cleared by a run that actually got past it.
  delete rep.stopped;
  rep.gate = g; rep.playwright = p; rep.finished = new Date().toISOString(); saveReport(rep);
  if (!pw.ok && !DRY) stopGate(40, `Playwright reports ${p.failed} failing test(s). Inspect WHERE it failed (step binding vs page-object selector vs the app) before re-prompting.`);
  console.log(`\n\u2705 validate complete \u2014 gate PASS ${g.pass}, must-pin ${g.mpFound}/${g.mpTotal}, playwright ${p.passed} passed.`);

  const ledgerPath = path.join(OUT, "migration-ledger.json");
  if (!DRY && fs.existsSync(ledgerPath)) {
    try {
      const led = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      const cur = led.batches[led.batches.length - 1];
      if (cur) { cur.validated_at = new Date().toISOString(); cur.gate = g; cur.playwright = p; }
      fs.writeFileSync(ledgerPath, JSON.stringify(led, null, 2));
      const done = led.batches.filter(b => b.validated_at).length;
      console.log(`Ledger updated: batch ${cur ? cur.batch : "?"} closed \u2014 ${done} of ${cur && cur.total_batches ? cur.total_batches : done} batch(es) validated.`);
      // HARD-STOP 4 (batch checkpoint) — batched runs ONLY. A full-suite run never reaches this.
      const more = cur && typeof cur.batch === "number" && cur.batch < (cur.total_batches || 1);
      if (more && !has("--auto-continue")) {
        console.log(`\n\u23f8  BATCH CHECKPOINT \u2014 batch ${cur.batch} of ${cur.total_batches} complete and green.`);
        console.log(`   Features migrated this batch: ${cur.features.join(", ")}`);
        console.log(`   Step-def methods this batch: ${cur.methods.length}`);
        console.log(`   Next: prepare --batch ${cur.batch + 1} --batch-size ${cur.size}   (or --auto-continue to chain unattended)`);
        console.log(`   This is a CHECKPOINT, not a failure: exit 50 means "batch done, more remain".`);
        process.exit(50);
      }
    } catch (e) { console.log(`(could not update ledger: ${e.message})`); }
  }
}

function status() {
  const ledgerPath = path.join(OUT, "migration-ledger.json");
  if (fs.existsSync(ledgerPath)) {
    try {
      const led = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      const last = led.batches[led.batches.length - 1];
      console.log(`\nEngagement: ${led.suite}`);
      console.log(`Feature list fingerprint: ${led.fingerprint} (${led.feature_count} features) \u2014 batches are slices of the SORTED feature list; if this changes, boundaries move.`);
      console.log(`\nBatches (by FEATURE):`);
      for (const b of led.batches) {
        const v = b.validated_at
          ? `validated ${b.validated_at.slice(0, 16).replace("T", " ")} \u00b7 gate PASS ${b.gate?.pass ?? "?"}/BLOCK ${b.gate?.block ?? "?"} \u00b7 pw ${b.playwright?.passed ?? "?"} passed`
          : `prepared ${b.prepared_at.slice(0, 16).replace("T", " ")} \u00b7 NOT YET VALIDATED`;
        console.log(`  [${b.validated_at ? "x" : " "}] batch ${b.batch}${b.total_batches > 1 ? ` of ${b.total_batches}` : ""} \u2014 ${b.features.length} feature(s), ${b.methods.length} step-def method(s)  ${v}`);
        console.log(`        ${b.features.join(", ")}`);
      }
      if (led.skipped.length) {
        console.log(`\nSkipped features (deliberately excluded, never migrated):`);
        for (const sk of led.skipped) console.log(`  - ${sk.name} \u2014 ${sk.reason}`);
      }
      if (last && typeof last.batch === "number" && last.total_batches > 1) {
        const next = last.validated_at ? last.batch + 1 : last.batch;
        if (next <= last.total_batches)
          console.log(`\nRESUME HERE: prepare --batch ${next} --batch-size ${last.size}${last.validated_at ? "" : "   (batch " + last.batch + " was prepared but never validated)"}`);
        else console.log(`\nAll ${last.total_batches} batch(es) validated. Nothing to resume.`);
      }
      console.log("");
    } catch (e) { console.log(`(could not read ledger: ${e.message})`); }
  }
  const packs = F.packs();
  if (!fs.existsSync(packs)) { if (fs.existsSync(ledgerPath)) return; stopGate(2, "no migration-packs/ \u2014 run 'prepare' first."); }
  const stepPacks = fs.readdirSync(packs).filter(f => f.endsWith(".md") && f !== "INDEX.md" && f !== "00_page_objects.md");
  const gen = opt("--generated", PW);
  const genFiles = gen && fs.existsSync(path.join(gen, "steps")) ? fs.readdirSync(path.join(gen, "steps")) : [];
  console.log(`Current batch's step-class packs (${stepPacks.length}):`);
  for (const pk of stepPacks) {
    const cls = pk.replace(/\.md$/, "");
    const stem = cls.replace(/Steps$/, "").toLowerCase();
    const done = genFiles.some(f => f.toLowerCase().includes(stem));
    console.log(`  ${done ? "\u2713" : "\u00b7"} ${cls}${done ? "" : "   (pending)"}`);
  }
  // Only report a count we actually measured. Without --pw we do not know where the project is, and
  // printing "0" there states as fact something we never checked — in a status report that reads as
  // "nothing was copied", which is a different and alarming claim.
  if (PW && fs.existsSync(path.join(PW, "features")))
    console.log(`\n  .feature files copied so far: ${fs.readdirSync(path.join(PW, "features")).length} (cumulative across batches; deterministic, 0 tokens)`);
  else
    console.log(`\n  (.feature copy count not shown \u2014 pass --pw <playwright-project> to include it)`);
}

function report() {
  const rep = loadReport();
  const rd = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
  const oracles  = rd(F.oracles(), []);          // shared-extractor output (same oracle shape as TestNG)
  const verdicts = rd(path.join(OUT, "verdicts.json"), null);
  const fixes    = rd(path.join(OUT, "fixes.json"), null);
  const notes    = rd(path.join(OUT, "notes.json"), {});
  const batch    = rd(path.join(F.packs(), "batch.json"), null);
  const featuresJson = rd(F.features(), []);      // VERIFY shape — see note below

  const PWDIR = CFG.pw || PW || "";
  const PEND = (what) => `_— agent note pending (${what}) —_`;
  // Escape HTML-significant chars in AGENT-supplied free text so tags like <a>/<frameset> render
  // literally instead of being parsed as HTML by markdown viewers. Leaves `inline code` spans intact.
  const esc = (s) => String(s ?? "").split(/(`[^`]*`)/).map((seg, i) =>
    i % 2 ? seg : seg.replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("");

  const ORIGIN = { external:"external", computed:"computed", app_read:"app_read", ui_state:"app_read", literal:"literal", ui_literal:"literal", unknown:"unknown" };
  const allOracles = (Array.isArray(oracles) ? oracles : []).flatMap(r => r.oracles || []);
  const byRec = { must_pin:0, planner_can_derive:0, needs_review:0 };
  const byOrigin = { external:0, computed:0, app_read:0, literal:0, unknown:0 };
  for (const o of allOracles) { byRec[o.recovery] = (byRec[o.recovery] || 0) + 1; byOrigin[ORIGIN[o.origin ?? o.type] ?? "unknown"]++; }
  const assertions = allOracles.length;

  const featureCount = Array.isArray(featuresJson) ? featuresJson.length : null;
  const scenarioCount = Array.isArray(featuresJson) ? featuresJson.reduce((a, f) => a + (Array.isArray(f.scenarios) ? f.scenarios.length : 0), 0) : null;

  const bind = rep.binding || {};
  let featuresCopied = null, stepFiles = [], stepPacks = [];
  try { featuresCopied = fs.readdirSync(path.join(PWDIR, "features")).filter(f => f.endsWith(".feature")).length; } catch {}
  try { stepFiles = fs.readdirSync(path.join(PWDIR, "steps")).filter(f => f.endsWith(".ts")); } catch {}
  try { stepPacks = fs.readdirSync(F.packs()).filter(f => f.endsWith(".md") && f !== "INDEX.md" && f !== "00_page_objects.md"); } catch {}

  const gate = rep.gate || (verdicts && verdicts.headline ? { pass: verdicts.headline.verdicts.PASS, needsHuman: verdicts.headline.verdicts["NEEDS-HUMAN"], block: verdicts.headline.verdicts.BLOCK, mpFound: verdicts.headline.mpFound, mpTotal: verdicts.headline.mpTotal } : null);
  const pwRun = rep.playwright || null;
  const cleanBinding = (bind.unbound || 0) === 0 && (bind.ambiguous || 0) === 0;
  const outcome = notes.outcome ? esc(notes.outcome) : (gate && gate.block === 0 && pwRun && pwRun.failed === 0 && cleanBinding ? "COMPLETE — all intent preserved" : "INCOMPLETE — see gate/binding/Playwright below");
  const fmt = (iso) => iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "?";
  const durMin = (rep.started && rep.finished) ? Math.round((Date.parse(rep.finished) - Date.parse(rep.started)) / 60000) : null;
  const suiteName = CFG.suite ? path.basename(CFG.suite) : (SUITE ? path.basename(SUITE) : "(suite)");

  const L = [];
  L.push(`# BDD Migration Run Report — ${suiteName} (Cucumber+Selenium/Java → playwright-bdd+TypeScript)\n`);
  L.push(`**Suite:** \`${suiteName}\``);
  L.push(`**Type:** ${notes.type ? esc(notes.type) : "bdd"}`);
  L.push(`**Date:** ${fmt(rep.started)}${rep.finished ? " – " + fmt(rep.finished).slice(11) : ""}`);
  if (durMin != null) L.push(`**Duration:** ~${durMin} min (agent wall-clock)`);
  L.push(`**Outcome:** ${outcome}`);
  L.push(`**Binding:** ${bind.bound ?? "?"} bound · ${bind.unbound ?? "?"} unbound · ${bind.ambiguous ?? "?"} ambiguous · ${bind.unused_definitions ?? "?"} dead glue`);
  if (gate) { L.push(`**Must-pin recovery:** **${gate.mpFound}/${gate.mpTotal}**`); L.push(`**Gate:** ${gate.pass} PASS · ${gate.needsHuman} NEEDS-HUMAN · ${gate.block} BLOCK`); }
  if (pwRun) L.push(`**Playwright:** ${pwRun.passed}/${pwRun.passed + pwRun.failed} passing`);
  L.push(`**Key fix:** ${notes.keyFix ? esc(notes.keyFix) : PEND("header key-fix summary")}\n`);
  L.push(`> **How to read this report.** Did every check the source made survive into the target? **Must-pin recovery ${gate ? gate.mpFound + "/" + gate.mpTotal : "X/Y"} with ${gate ? gate.block : 0} BLOCK is that answer.** NEEDS-HUMAN items are faithful translations the gate could not mechanically *score*, each explained in §4. The \`.feature\` files carry over verbatim — business intent is copied, not re-derived.`);
  L.push("\n---\n");

  L.push(`## 1. Intake & Fidelity\n`);
  L.push(`| | |`); L.push(`|---|---|`);
  L.push(`| Features | ${featureCount ?? "(see features.json)"} |`);
  L.push(`| Scenarios | ${scenarioCount ?? "(see features.json)"} |`);
  L.push(`| Steps bound | ${bind.bound ?? "?"} (unbound ${bind.unbound ?? "?"}, ambiguous ${bind.ambiguous ?? "?"}) |`);
  L.push(`| Dead glue (unused step defs) | ${bind.unused_definitions ?? "?"} — found, reported, not migrated |`);
  L.push(`| Oracles | ${assertions} → **${byRec.must_pin} MUST-PIN**, ${byRec.planner_can_derive} derive, **${byRec.needs_review} REVIEW** |`);
  L.push(`| Step-class packs | ${stepPacks.length} |`);
  L.push(`\n**Oracle origin breakdown:**\n`);
  L.push(`| Origin | Count | Meaning | On loss |`); L.push(`|---|---|---|---|`);
  L.push(`| \`external\` | ${byOrigin.external} | Outside the app — incl. Gherkin Examples/DataTable values | MUST-PIN → BLOCK |`);
  L.push(`| \`computed\` | ${byOrigin.computed} | Calculated in the step | MUST-PIN → BLOCK |`);
  L.push(`| \`app_read\` | ${byOrigin.app_read} | A live fact about the page | derive → NEEDS-HUMAN |`);
  L.push(`| \`literal\` | ${byOrigin.literal} | Hardcoded string/number in the step | derive → NEEDS-HUMAN |`);
  L.push(`| \`unknown\` | ${byOrigin.unknown} | Origin could not be traced | REVIEW (pinned, fail-safe) |`);
  L.push(`\n**Localization check (the \`literal = ${byOrigin.literal}\` line).** ${notes.localization ? esc(notes.localization) : (byOrigin.literal === 0 ? "No hardcoded-string oracles — nothing to check. Values from Gherkin Examples/DataTable classify as external, so they are must-pinned, not at risk." : PEND("localization judgment on the hardcoded-string oracles"))}`);
  L.push("\n---\n");

  L.push(`## 2. Intake Attestation (HARD-STOP 1)\n`);
  const att = notes.attestation || {};
  L.push(`- **Binding (mechanical gate):** ${bind.bound ?? "?"} bound, ${bind.unbound ?? "?"} unbound, ${bind.ambiguous ?? "?"} ambiguous. ${cleanBinding ? "Every Gherkin step resolved to exactly one definition — clean." : "**Unbound/ambiguous steps present — must resolve before migrating.**"}`);
  L.push(`- **Attested:** ${att.attested ? esc(att.attested) : PEND("intake attestation")}`);
  L.push(`- **Proceed decision:** ${att.proceed ? esc(att.proceed) : PEND("proceed decision")}`);
  L.push("\n---\n");

  L.push(`## 3. What was migrated\n`);
  L.push(`**Features** carried over verbatim (copied, not translated — 0 tokens): ${featuresCopied != null ? featuresCopied : "(pass --pw to count)"}.\n`);
  L.push(`**Step classes** translated to step files:\n`);
  if (stepPacks.length) { L.push(`| Step-class pack | Status |`); L.push(`|---|---|`); for (const pk of stepPacks) { const cls = pk.replace(/\.md$/, ""); const done = stepFiles.some(f => f.toLowerCase().includes(cls.replace(/Steps$/, "").toLowerCase())); L.push(`| ${cls} | ${done ? "✅" : "— pending"} |`); } }
  else L.push(`(no step-class packs found)`);
  L.push(batch && batch.deferred && batch.deferred.length ? `\n- **Deferred features:** ${batch.deferred.join(", ")}.` : `\n- **Deferred features:** none.`);
  if (batch && batch.skipped && batch.skipped.length) { L.push(`- **Skipped features:**`); for (const sk of batch.skipped) L.push(`  - \`${sk.name}\` — ${sk.reason}`); } else L.push(`- **Skipped features:** none.`);
  L.push("\n---\n");

  L.push(`## 4. Gate verdicts\n`);
  if (verdicts && verdicts.tests) {
    const nonPass = verdicts.tests.filter(t => t.verdict !== "PASS");
    const passN = verdicts.tests.length - nonPass.length;
    L.push(`The shared gate (\`--bdd\`) scores whether each oracle survived, per **step definition**. **must-pin ${gate.mpFound}/${gate.mpTotal} · ${gate.block} BLOCK.** ${nonPass.length ? "The " + nonPass.length + " non-PASS row(s) are below." : "Every step definition passed."}\n`);
    if (nonPass.length) {
      L.push(`| Source step definition | must-pin | verdict | Why (not a loss) |`); L.push(`|---|---|---|---|`);
      for (const t of nonPass) { const raw = (notes.verdictReasons && notes.verdictReasons[t.id]) || t.notes.join("; "); const reason = raw ? esc(raw) : PEND("reason"); L.push(`| ${t.id} | ${t.mpFound}/${t.mpTotal} | ${t.verdict} | ${reason} |`); }
      const missingHuman = nonPass.some(t => !(notes.verdictReasons && notes.verdictReasons[t.id]));
      if (missingHuman) L.push(`\n_Rows without a written explanation show the gate's mechanical note; add human elaboration via notes.json → verdictReasons before hand-off._`);
      L.push("");
    }
    L.push(`All other ${passN} step definition(s): **PASS** — every oracle matched.`);
    if (verdicts.headline && verdicts.headline.unscoreable) L.push(`\n(+ ${verdicts.headline.unscoreable} unscoreable must-pin(s) — generic subject/expected names give the matcher no tokens; reported, not counted. Verify by eye.)`);
  } else L.push(PEND("verdicts.json not found — run validate to emit it"));
  L.push("\n---\n");

  L.push(`## 5. Interaction fixes applied (HARD-STOP 3, rule 2)\n`);
  if (Array.isArray(fixes) && fixes.length) {
    const violation = fixes.some(f => f.assertionsTouched);
    if (violation) L.push(`> ⚠ **A recorded fix reports \`assertionsTouched: true\`.** Under HARD-STOP 3 rule 2 an interaction fix must NOT touch an assertion — review before hand-off.\n`);
    L.push(`No assertion — and no \`.feature\` file — was altered${violation ? " except where flagged" : ""}.\n`);
    L.push(`| # | File | Change | Cause (verified) | Assertions |`); L.push(`|---|---|---|---|---|`);
    fixes.forEach((f, i) => L.push(`| ${i + 1} | \`${f.file ? esc(f.file) : "?"}\` | ${f.change ? esc(f.change) : "?"} | ${f.cause ? esc(f.cause) : "?"}${f.evidence ? " — " + esc(f.evidence) : ""} | ${f.assertionsTouched ? "**TOUCHED ⚠**" : "untouched"} |`));
  } else L.push(`None recorded.${(rep.steps || []).some(s => s.step === "playwright" && s.status === "FAILED") ? " _(A Playwright cycle failed then recovered — if a fix was applied it should be in fixes.json.)_" : ""}`);
  L.push("\n---\n");

  L.push(`## 6. Cycle history\n`);
  const vSteps = (rep.steps || []).filter(s => s.step.startsWith("gate") || ["bddgen", "tsc", "playwright"].includes(s.step));
  const cyc = []; let cur = {};
  for (const s of vSteps) { const key = s.step.startsWith("gate") ? "gate" : s.step; cur[key] = s; if (s.step === "playwright") { cyc.push(cur); cur = {}; } }
  if (Object.keys(cur).length) cyc.push(cur);
  if (cyc.length) {
    L.push(`| Cycle | gate | bddgen | tsc | playwright | Outcome |`); L.push(`|---|---|---|---|---|---|`);
    cyc.forEach((c, i) => {
      const cell = (s) => s ? `${s.status === "ok" ? "✅" : "❌"} ${s.seconds || "?"}s` : "—";
      const pwOut = c.playwright && c.playwright.passed !== undefined ? (c.playwright.failed ? `${c.playwright.failed} failing` : `${c.playwright.passed}/${c.playwright.passed} passing`) : "";
      const reason = esc((notes.cycleReasons && notes.cycleReasons[i]) || "");
      L.push(`| ${i + 1} | ${cell(c.gate)} | ${cell(c.bddgen)} | ${cell(c.tsc)} | ${cell(c.playwright)} | ${[pwOut, reason].filter(Boolean).join(" — ") || "—"} |`);
    });
  } else L.push(`(single cycle — no fix-loop recorded)`);
  L.push("\n---\n");

  L.push(`## 7. Findings about the customer's system\n`);
  if (notes.findings && notes.findings.length) for (const f of notes.findings) L.push(`- ${esc(f)}`); else L.push(`- ${PEND("customer-system findings")}`);
  if (bind.unused_definitions) L.push(`- **Dead glue:** ${bind.unused_definitions} step definition(s) referenced by no feature — real code, never run. Found and skipped, not migrated.`);
  if (verdicts && verdicts.headline) L.push(`- **Blind spots:** ${verdicts.headline.blind === 0 ? "none — every page object and helper was followed" : verdicts.headline.blind + " (calls the gate could not follow)"}.`);
  L.push("\n---\n");

  L.push(`## 8. Playwright execution\n`);
  if (pwRun) { L.push(`- **Result:** ${pwRun.passed} passed, ${pwRun.failed} failed.`); L.push(`- **Command:** \`npx bddgen && npx playwright test\``); L.push(`- **tsc --noEmit:** ${(rep.steps || []).some(s => s.step === "tsc" && s.status === "ok") ? "clean (compiles)" : "see steps"}`); } else L.push(`(not run)`);
  L.push("\n---\n");

  L.push(`## 9. Pipeline steps\n`);
  L.push(`| Step | Status | Time |`); L.push(`|---|---|---|`);
  let toolSec = 0;
  for (const s of rep.steps || []) { toolSec += parseFloat(s.seconds) || 0; L.push(`| ${s.step} | ${s.status} | ${s.seconds ? s.seconds + " s" : "—"} |`); }
  if (durMin != null) L.push(`\n**Why these don't sum to ~${durMin} min.** The times above are *deterministic tool* time (~${(toolSec / 60).toFixed(1)} min). The rest is **agent** work between steps — reading packs, writing step files, diagnosing failures — which the orchestrator can't meter.`);
  L.push("\n---\n");

  L.push(`## 10. Translation cost\n`);
  let tokenLine = "not metered (agent runtime, e.g. a Claude subscription). The deterministic steps above cost ZERO tokens.";
  const tks = rd(path.join(OUT, "tokens.json"), null);
  if (Array.isArray(tks)) { const i = tks.reduce((a, x) => a + (x.input_tokens || 0), 0), o = tks.reduce((a, x) => a + (x.output_tokens || 0), 0); tokenLine = `input ${i}, output ${o}, across ${tks.length} translation call(s) (from tokens.json).`; }
  L.push(tokenLine + "\n");
  L.push(`| Runtime | Where the cost shows | Read by the kit? |`); L.push(`|---|---|---|`);
  L.push(`| GitHub Copilot (VS Code) | Copilot chat popover | No |`);
  L.push(`| Cursor | Cursor usage panel | No |`);
  L.push(`| Claude subscription | In-app usage | No |`);
  L.push(`| Anthropic API | \`usage\` on each response → \`tokens.json\` | **Yes** |`);
  L.push("\n---\n");

  L.push(`## 11. Re-run commands\n`);
  L.push("```");
  L.push(`# Full validation of the migrated BDD suite`);
  L.push(`node <BDD-KIT>\\tools\\orchestrator\\orchestrate_bdd.mjs validate --testng-kit <TESTNG-KIT> --out <WORK> --pw <PW>`);
  L.push("");
  L.push(`# The migrated suite alone`);
  L.push(`cd <PW> && npx bddgen && npx playwright test`);
  L.push("```");

  const md = L.join("\n") + "\n";
  const mdDir = (PW && fs.existsSync(PW)) ? PW : OUT;
  const mdPath = path.join(mdDir, "migration-run-report.md");
  fs.writeFileSync(mdPath, md);
  console.log(md);
  console.log(`(written ${mdPath})`);
}

function usage() {
  console.log(`usage: node orchestrate_bdd.mjs <prepare|validate|status|report|setup> [options]

  --kit <dir>          this BDD kit (default: .)
  --testng-kit <dir>   the TestNG kit, for the SHARED extractor + gate (default: ../qe-migration-kit)
  --suite <dir>        source Cucumber+Selenium suite root
  --out <dir>          work dir (features/bound/oracles/records/packs/report)
  --pw <dir>           playwright-bdd project dir (features are copied here; tsc/bddgen/playwright run here)
  --generated <dir>    what the gate scores (defaults to --pw)
  --no-setup           skip self-provisioning
  --dry-run            print the commands without running them
`);
}

switch (cmd) {
  case "setup": setup(); break;
  case "prepare": prepare(); break;
  case "validate": validate(); break;
  case "status": status(); break;
  case "report": report(); break;
  default: usage(); process.exit(cmd ? 2 : 0);
}
