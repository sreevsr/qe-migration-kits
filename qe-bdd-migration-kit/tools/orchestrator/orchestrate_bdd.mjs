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
  if (DRY) { rep.steps.push({ step, command, dry: true }); saveReport(rep); return { ok: true, out: "" }; }
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
  rep.steps.push({ step, command, ok, ms: Date.now() - t0 }); saveReport(rep);
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
  const gate = run("gate (shared, --bdd)", `node "${path.join(TESTNG_KIT, "tools", "gate", "parity_check_ast.mjs")}" --oracles "${F.oracles()}" --generated "${gen}" --bdd${scopeArg}`);
  const g = DRY ? {} : parseGate(gate.out);
  if (!DRY && g.block > 0) {
    const rep = loadReport(); rep.gate = g; saveReport(rep);
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
  const r = loadReport();
  const md = [];
  md.push(`# BDD Migration Run Report\n`);
  md.push(`- started: ${r.started}`);
  if (r.finished) md.push(`- finished: ${r.finished}`);
  if (r.binding) md.push(`- binding: ${r.binding.bound} bound, ${r.binding.unbound} unbound, ${r.binding.ambiguous} ambiguous, ${r.binding.unused_definitions} unused definition(s) (dead glue, not migrated)`);
  if (r.gate) md.push(`- gate: PASS ${r.gate.pass} | NEEDS-HUMAN ${r.gate.needsHuman} | BLOCK ${r.gate.block} \u00b7 must-pin ${r.gate.mpFound}/${r.gate.mpTotal}`);
  if (r.playwright) md.push(`- playwright: ${r.playwright.passed} passed, ${r.playwright.failed} failed`);
  if (r.stopped) md.push(`- **STOPPED at ${r.stopped.at}** \u2014 (${r.stopped.code}) ${r.stopped.msg}`);
  md.push(`\n## Steps\n`);
  for (const s of r.steps || []) md.push(`- ${s.ok === false ? "\u2717" : "\u2713"} ${s.step}${s.ms ? ` (${(s.ms / 1000).toFixed(1)}s)` : ""}`);
  md.push(`\n## Tokens\n`);
  md.push(fs.existsSync(path.join(OUT, "tokens.json"))
    ? "- see tokens.json"
    : "- not metered (agent runtime). The deterministic steps above cost ZERO tokens; the agent spends tokens only on translation.");
  md.push(`\n## Notes\n- .feature files carry over verbatim (0 tokens).\n- Oracle extraction uses the SHARED TestNG classifier via --entry-points; the gate is the SHARED gate via --bdd.`);
  // The write-up is a DELIVERABLE, so it belongs beside the migrated suite — not in work/, which we
  // tell people to ignore. The machine-readable .json stays in work/ (it is state, not a report).
  const mdDir = (PW && fs.existsSync(PW)) ? PW : OUT;
  const out = path.join(mdDir, "migration-run-report.md");
  fs.writeFileSync(out, md.join("\n") + "\n");
  console.log(md.join("\n"));
  console.log(`\nWrote ${out}`);
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
