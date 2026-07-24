#!/usr/bin/env node
/**
 * orchestrate.mjs — deterministic migration driver (ZERO tokens; calls no LLM).
 *
 * Runs the mechanical steps and STOPS at judgment gates for a human/agent decision:
 *   prepare   : build classpath -> extract -> slice   (+ optional baseline-green gate)
 *   validate  : gate -> tsc --noEmit -> playwright test   (stops on BLOCK / compile / run failure)
 *   status    : which test packs are migrated vs pending
 *   report    : consolidated run report (json + md), incl. a token-usage slot
 *
 * The translation step is NOT here — that is the agent's job (Claude Code / Copilot / Cursor).
 * This driver prepares the work for the agent and validates the agent's output. That split is
 * what keeps it token-free (deterministic) and portable across agents.
 *
 * Exit codes (so an agent runbook can branch): 0 ok · 2 usage/bad --suite · 3 batch drift ·
 *   10 baseline-not-green · 12 classpath failed · 20 gate BLOCK · 30 tsc failure ·
 *   40 playwright failure · 50 batch checkpoint (NOT a failure: batch done, more remain).
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

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

// This script lives at <KIT>/tools/orchestrator/orchestrate.mjs, so it can always work out its own
// kit — no matter where the user is standing. Falling back to "." meant `cd tools/extractor` then
// running this produced <cwd>/tools/extractor/target/qe-extractor.jar and reported "extractor build
// failed", blaming the build for a path bug. init.mjs has always done it this way.
const SELF_KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIT = path.resolve(opt("--kit") || CFG.kit || SELF_KIT);
const SUITE = opt("--suite") || CFG.suite || "";
const OUT = path.resolve(opt("--out") || CFG.out || ".");
const GENERATED = opt("--generated", "");
const BROWSER = opt("--browser", "CHROME");
const PW_PROJECT = opt("--pw", "");   // playwright project dir for tsc/playwright

const REPORT = path.join(OUT, "migration-run-report.json");

function loadReport() { try { return JSON.parse(fs.readFileSync(REPORT, "utf8")); } catch { return { started: new Date().toISOString(), steps: [] }; } }
function saveReport(r) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(REPORT, JSON.stringify(r, null, 2)); }

// run a shell command, capture output+status, record into the report
function run(step, command, cwd, envOverride) {
  const rep = loadReport();
  console.log(`\n\u25b6 ${step}\n  $ ${command}`);
  if (DRY) { rep.steps.push({ step, command, status: "dry-run", when: new Date().toISOString() }); saveReport(rep); return { ok: true, out: "" }; }
  const t0 = Date.now();
  try {
    const out = execSync(command, { cwd: cwd || process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: envOverride ? { ...process.env, ...envOverride } : process.env });
    process.stdout.write(out);
    rep.steps.push({ step, command, status: "ok", seconds: ((Date.now() - t0) / 1000).toFixed(1), when: new Date().toISOString() });
    saveReport(rep);
    return { ok: true, out };
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    process.stdout.write(out);
    rep.steps.push({ step, command, status: "FAILED", seconds: ((Date.now() - t0) / 1000).toFixed(1), when: new Date().toISOString() });
    saveReport(rep);
    return { ok: false, out };
  }
}

// Corporate machines run a TLS-inspecting proxy that re-signs every response with a private root
// CA. That root lives in the MACHINE's trust store, which Node does not consult by default — so npm
// dies on a cert error that has nothing to do with the kit. `--use-system-ca` (a NODE flag, not an
// npm one — hence NODE_OPTIONS) tells Node to use the machine store. We do NOT set it
// unconditionally: it needs Node 22.15+, and on an older Node an unknown NODE_OPTIONS entry makes
// node refuse to start AT ALL, which would break every command instead of one. So: try clean, and
// only retry when the error actually looks like a certificate problem.
function npmInstall(step, dir, extra = "") {
  const cmd = `npm install${extra}`;
  const r = run(step, cmd, dir);
  if (r.ok) return r;
  const certish = /self.signed|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|CERT_|certificate|SSL routines/i.test(r.out || "");
  if (!certish) return r;
  console.log(`\n  \u2139 npm failed on a CERTIFICATE error. That is almost always a corporate TLS-inspecting`);
  console.log(`    proxy whose root CA is in the machine store but not trusted by Node. Retrying with`);
  console.log(`    NODE_OPTIONS=--use-system-ca ...`);
  const merged = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--use-system-ca`;
  const r2 = run(`${step} (retry with --use-system-ca)`, cmd, dir, { NODE_OPTIONS: merged });
  if (r2.ok) {
    console.log(`\n  \u2713 Succeeded using the machine's CA store. To avoid the retry every run, set it once`);
    console.log(`    in your shell:  $env:NODE_OPTIONS="--use-system-ca"   (PowerShell)`);
    return r2;
  }
  if (/bad option|not allowed in NODE_OPTIONS/i.test(r2.out || "")) {
    console.log(`\n  \u26d4 This Node (${process.version}) does not support --use-system-ca (needs 22.15+).`);
    console.log(`    Upgrade Node, or point npm at your proxy's root cert:  npm config set cafile <path-to-root.pem>`);
  } else {
    console.log(`\n  \u26d4 Still failing with the system CA store. Either your proxy's root cert is not in the`);
    console.log(`    machine store, or the registry itself is blocked. This is an environment issue, not the kit.`);
  }
  return r2;
}

function stopGate(code, msg) {
  console.log(`\n\u26d4 JUDGMENT GATE \u2014 ${msg}`);
  console.log(`   The driver is stopping here on purpose. A human/agent must decide, not auto-proceed.`);
  process.exit(code);
}

// ---------- parsers (deterministic, from tool stdout) ----------
export function parseGate(out) {
  const v = out.match(/Verdicts\s+PASS\s+(\d+)\s+\|\s+NEEDS-HUMAN\s+(\d+)\s+\|\s+BLOCK\s+(\d+)/);
  const mp = out.match(/must-pin recovery:\s+(\d+)\/(\d+)/);
  return { pass: v ? +v[1] : null, needsHuman: v ? +v[2] : null, block: v ? +v[3] : null,
           mpFound: mp ? +mp[1] : null, mpTotal: mp ? +mp[2] : null };
}
export function parsePlaywright(out) {
  const passed = out.match(/(\d+)\s+passed/); const failed = out.match(/(\d+)\s+failed/);
  return { passed: passed ? +passed[1] : null, failed: failed ? +failed[1] : 0 };
}

// ---------- self-provisioning setup (deterministic, idempotent) ----------
function toolPresent(probe) { try { execSync(probe, { stdio: "ignore" }); return true; } catch { return false; } }
function depResolves(dir, dep) { try { createRequire(path.join(dir, "package.json")).resolve(dep); return true; } catch { return false; } }

function setup() {
  console.log("\u2699  setup \u2014 checking prerequisites and kit tools\n");

  // 1. machine prerequisites the kit cannot install (JDK/Maven/Node)
  const probes = [["java", "java -version"], ["mvn", "mvn -version"], ["node", "node -v"], ["npx", "npx -v"]];
  const missing = probes.filter(([, p]) => !toolPresent(p)).map(([t]) => t);
  if (missing.length) {
    console.log(`\u26d4 Missing required tool(s) on PATH: ${missing.join(", ")}\n`);
    if (missing.includes("java") || missing.includes("mvn"))
      console.log(`  \u2022 JDK 21 + Maven:  choco install temurin21 maven -y   (then reopen the terminal)`);
    if (missing.includes("node") || missing.includes("npx"))
      console.log(`  \u2022 Node 22.15+ (ships npx):  choco install nodejs-lts -y   (then reopen the terminal)`);
    console.log(`    (18+ runs the kit, but 22.15+ is needed for the automatic corporate-CA retry on npm installs.)`);
    console.log(`\nInstall the above, reopen your terminal, and re-run the same command. Setup will re-check.`);
    process.exit(11);
  }
  console.log("  \u2713 prerequisites present (java, mvn, node, npx)");

  // 2. extractor jar (kit-owned) \u2014 build if absent
  const jar = path.join(KIT, "tools", "extractor", "target", "qe-extractor.jar");
  if (!fs.existsSync(jar)) {
    console.log("  \u2026 extractor jar missing \u2014 building (one-time)");
    const b = run("setup:build-extractor", `mvn -q clean package`, path.join(KIT, "tools", "extractor"));
    if (!b.ok) { console.log("\u26d4 extractor build failed (see output above)."); process.exit(2); }
  }
  console.log("  \u2713 extractor jar ready");

  // 3. node tools (kit-owned) \u2014 functional dep check, install only if a real dep can't resolve
  const nodeTools = [
    { dir: path.join(KIT, "tools", "gate"), deps: ["ts-morph"] },
    { dir: path.join(KIT, "tools", "prepare"), deps: [] },
    { dir: path.join(KIT, "tools", "orchestrator"), deps: [] },
  ];
  for (const t of nodeTools) {
    const need = t.deps.filter(d => !depResolves(t.dir, d));
    if (need.length) {
      console.log(`  \u2026 ${path.basename(t.dir)}: missing ${need.join(", ")} \u2014 installing`);
      const i = npmInstall(`setup:npm-${path.basename(t.dir)}`, t.dir);
      if (!i.ok) { console.log(`\u26d4 npm install failed in ${t.dir} \u2014 see the diagnosis above. The kit cannot run without it.`); process.exit(2); }
    }
    console.log(`  \u2713 ${path.basename(t.dir)} ready`);
  }
  console.log("\n\u2705 setup complete \u2014 kit is ready.\n");
}

// ---------- commands ----------
function prepare() {
  if (!has("--no-setup")) setup();
  if (!SUITE) stopGate(2, "prepare needs --suite <source-suite-root>");
  const cp = path.join(SUITE, "cp.txt");
  const jar = path.join(KIT, "tools", "extractor", "target", "qe-extractor.jar");
  const slicer = path.join(KIT, "tools", "prepare", "prepare_migration.mjs");
  const records = path.join(OUT, "records.json");
  const packs = path.join(OUT, "migration-packs");

  // Check the SUITE up front. A wrong --suite otherwise sails past the classpath step and surfaces
  // as a Java NoSuchFileException about cp.txt inside the extractor — which points at the wrong
  // component entirely. Fail here, where the actual mistake is.
  if (!fs.existsSync(SUITE)) stopGate(2, `--suite path does not exist: ${SUITE}\n   Pass the FULL path to the source suite root (the folder containing pom.xml).`);
  if (!fs.existsSync(path.join(SUITE, "pom.xml"))) stopGate(2, `no pom.xml in --suite: ${SUITE}\n   --suite must be the Maven project ROOT (the folder containing pom.xml), not a subfolder.`);

  const cpRun = run("classpath", `mvn -q -f "${path.join(SUITE, "pom.xml")}" dependency:build-classpath "-Dmdep.outputFile=cp.txt"`);
  // A failed classpath MUST stop here. Left unchecked it cascades: the extractor then dies on a
  // missing cp.txt and the error you read is about the wrong thing.
  if (!cpRun.ok && !DRY) stopGate(12, `Maven could not build the classpath for ${SUITE}.\n   The real error is in the Maven output above (bad path, unresolvable dependency, offline repo).\n   Fix that first \u2014 the extractor needs cp.txt to resolve types.`);
  if (!DRY && !fs.existsSync(cp)) stopGate(12, `Maven reported success but ${cp} was not written.\n   Check the Maven output above for a silent failure.`);
  const ext = run("extract", `java -jar "${jar}" "${SUITE}" "${cp}" "${records}"`);
  if (!ext.ok && !DRY) stopGate(2, "extractor failed (see output above)");

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
  // Batching: pass the scope through to the slicer. It writes batch.json, which validate() then
  // hands to the gate as --scope so deferred/skipped classes report DEFERRED instead of BLOCK.
  const batchArgs = ["--only", "--only-file", "--skip", "--skip-file", "--batch-size", "--batch"]
    .filter(k => opt(k, "")).map(k => `${k} "${opt(k, "")}"`).join(" ");
  // The ledger belongs in the WORK dir, not the packs dir — validate() and status() read it there.
  const ledgerArg = batchArgs ? ` --ledger "${path.join(OUT, "migration-ledger.json")}"` : "";
  run("slice", `node "${slicer}" --records "${records}" --repo "${SUITE}" --out "${packs}"${batchArgs ? " " + batchArgs : ""}${ledgerArg}`);

  // Baseline is an INTAKE ATTESTATION, not a per-run gate. Source-runtime greenness is a weak
  // signal (aging Selenium is often flaky), and running 100s of tests every prepare is impractical.
  // Default: trust the attestation and proceed. Opt-in soft check or ingest existing results.
  const reportFile = opt("--baseline-report", "");
  if (reportFile) {
    try {
      const xml = fs.readFileSync(reportFile, "utf8");
      const t = xml.match(/tests="(\d+)"/), f = xml.match(/failures="(\d+)"/), e = xml.match(/errors="(\d+)"/);
      const tot = t ? +t[1] : null, fail = (f ? +f[1] : 0) + (e ? +e[1] : 0);
      const rep = loadReport(); rep.baseline = { source: reportFile, tests: tot, failed: fail }; saveReport(rep);
      console.log(`\n\u2139  Baseline (from ${path.basename(reportFile)}): ${tot != null ? tot - fail + "/" + tot + " passed" : "parsed"}. Recorded as attested intake evidence.`);
    } catch { console.log(`\n\u26a0  Could not read --baseline-report ${reportFile}; treating baseline as attested.`); }
  } else if (has("--run-baseline")) {
    console.log("\n\u2139  --run-baseline: running the source suite (soft check; will not hard-block on failures).");
    const base = run("baseline", `mvn -f "${path.join(SUITE, "pom.xml")}" test "-Dbrowser=${BROWSER}"`);
    if (!base.ok && !/Tests run:/.test(base.out)) {
      stopGate(10, "the baseline could not be EXECUTED (not the same as tests failing) \u2014 e.g. build/PATH/param issue. Fix the run-contract, then retry.");
    }
    const m = base.out.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/);
    if (m) {
      const [tot, fail, err] = [+m[1], +m[2], +m[3]];
      const rep = loadReport(); rep.baseline = { tests: tot, failed: fail + err }; saveReport(rep);
      console.log(`\n\u2139  Baseline: ${tot - fail - err}/${tot} passed. NOTE: a red Selenium source can still migrate to green Playwright (auto-waiting fixes flakiness). Proceed if the tests are VALID, not necessarily all-green.`);
    }
  } else {
    console.log("\n\u2139  Baseline health assumed valid/green (established at intake by the suite owner). Proceeding \u2014 migrating test INTENT, which is intact regardless of Selenium-runtime flakiness.");
  }
  console.log(`\nPrepared. Next: the agent translates migration-packs/ (00_page_objects.md first, then each test), then run 'validate'.`);
}

function validate() {
  if (!GENERATED) stopGate(2, "validate needs --generated <generated-specs-dir>");
  const batchFile = path.join(OUT, "migration-packs", "batch.json");
  const scopeArg = fs.existsSync(batchFile) ? ` --scope "${batchFile}"` : "";
  const verdictsPath = path.join(OUT, "verdicts.json");   // emitted automatically; report() reads it
  const gate = run("gate", `node "${path.join(KIT, "tools", "gate", "parity_check_ast.mjs")}" --oracles "${path.join(OUT, "records.json")}" --generated "${GENERATED}"${scopeArg} --emit "${verdictsPath}"`);
  const g = DRY ? {} : parseGate(gate.out);
  if (!DRY && g.block > 0) {
    const rep = loadReport(); rep.gate = g;
    for (let i = rep.steps.length - 1; i >= 0; i--) { const s = rep.steps[i]; if (s.step === "gate" && s.block === undefined) { s.pass = g.pass; s.needsHuman = g.needsHuman; s.block = g.block; break; } }
    saveReport(rep);
    stopGate(20, `gate reports ${g.block} BLOCK (a must-pin lost). Review those specs with the agent using the SPECIFIC gate line \u2014 do not blind-regenerate.`);
  }
  const cwd = PW_PROJECT || undefined;
  const tsc = run("tsc", `npx tsc --noEmit`, cwd);
  if (!tsc.ok && !DRY) stopGate(30, "tsc --noEmit failed. Fix the compile errors (usually a small type/import issue) before running Playwright.");
  const pw = run("playwright", `npx playwright test`, cwd);
  const p = DRY ? {} : parsePlaywright(pw.out);
  const rep = loadReport();
  // Tag THIS cycle's gate + playwright steps with their numbers before anything can exit. rep.gate/
  // rep.playwright hold only the LATEST run; \u00a76 cycle history needs each cycle's own counts, and the
  // step records persist across the agent's fix-loop (run() appends), so tagging here builds it.
  for (let i = rep.steps.length - 1; i >= 0; i--) { const s = rep.steps[i]; if (s.step === "playwright" && s.passed === undefined) { s.passed = p.passed; s.failed = p.failed; break; } }
  for (let i = rep.steps.length - 1; i >= 0; i--) { const s = rep.steps[i]; if (s.step === "gate" && s.block === undefined) { s.pass = g.pass; s.needsHuman = g.needsHuman; s.block = g.block; break; } }
  rep.gate = g; rep.playwright = p; rep.finished = new Date().toISOString(); saveReport(rep);
  if (!pw.ok && !DRY) stopGate(40, `Playwright reports ${p.failed} failing test(s). If the failure is in API setup, it is likely an API-migration issue; if in a UI assertion, a selector/timing fix. Inspect before re-prompting.`);
  console.log(`\n\u2705 validate complete \u2014 gate PASS ${g.pass}, must-pin ${g.mpFound}/${g.mpTotal}, playwright ${p.passed} passed.`);

  // ---- close out this batch in the ledger, then the batch checkpoint --------------------------
  const ledgerPath = path.join(OUT, "migration-ledger.json");
  if (!DRY && fs.existsSync(ledgerPath)) {
    try {
      const led = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      const cur = led.batches[led.batches.length - 1];
      if (cur && !cur.validated_at) { cur.validated_at = new Date().toISOString(); cur.gate = g; cur.playwright = p; }
      else if (cur) { cur.validated_at = new Date().toISOString(); cur.gate = g; cur.playwright = p; cur.re_validated = true; }
      fs.writeFileSync(ledgerPath, JSON.stringify(led, null, 2));
      const done = led.batches.filter(b => b.validated_at).length;
      const total = cur && cur.total_batches ? cur.total_batches : done;
      console.log(`Ledger updated: batch ${cur ? cur.batch : "?"} closed \u2014 ${done} of ${total} batch(es) validated.`);

      // HARD-STOP 4 (batch checkpoint). ONLY when batching. A full-suite run (no --batch-size)
      // never reaches this and behaves exactly as it always has.
      const more = cur && typeof cur.batch === "number" && cur.batch < (cur.total_batches || 1);
      if (more && !has("--auto-continue")) {
        console.log(`\n\u23f8  BATCH CHECKPOINT \u2014 batch ${cur.batch} of ${cur.total_batches} is complete and green.`);
        console.log(`   Migrated this batch: ${cur.classes.join(", ")}`);
        console.log(`   ${(cur.total_batches - cur.batch) * cur.size} class(es) remain across ${cur.total_batches - cur.batch} more batch(es).`);
        console.log(`   Next: prepare --batch ${cur.batch + 1} --batch-size ${cur.size}   (or --auto-continue to chain batches unattended)`);
        console.log(`   This is a CHECKPOINT, not a failure: exit 50 means "batch done, more remain".`);
        process.exit(50);
      }
    } catch (e) { console.log(`(could not update ledger: ${e.message})`); }
  }
}

function status() {
  // The ledger is the cross-batch truth. migration-packs/ only ever holds the CURRENT batch, so it
  // cannot answer "where did we get to?" — that is what the ledger is for.
  const ledgerPath = path.join(OUT, "migration-ledger.json");
  if (fs.existsSync(ledgerPath)) {
    try {
      const led = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      const done = led.batches.filter(b => b.validated_at);
      const last = led.batches[led.batches.length - 1];
      console.log(`\nEngagement: ${led.suite}`);
      console.log(`Class list fingerprint: ${led.fingerprint} (${led.class_count} classes) \u2014 batches are slices of the SORTED list; if this changes, boundaries move.`);
      console.log(`\nBatches:`);
      for (const b of led.batches) {
        const v = b.validated_at
          ? `validated ${b.validated_at.slice(0, 16).replace("T", " ")} \u00b7 gate PASS ${b.gate?.pass ?? "?"}/BLOCK ${b.gate?.block ?? "?"} \u00b7 pw ${b.playwright?.passed ?? "?"} passed`
          : `prepared ${b.prepared_at.slice(0, 16).replace("T", " ")} \u00b7 NOT YET VALIDATED`;
        console.log(`  [${b.validated_at ? "x" : " "}] batch ${b.batch}${b.total_batches > 1 ? ` of ${b.total_batches}` : ""} (${b.classes.length} class(es))  ${v}`);
        console.log(`        ${b.classes.join(", ")}`);
      }
      if (led.skipped.length) {
        console.log(`\nSkipped (deliberately excluded, never migrated):`);
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
  const packs = path.join(OUT, "migration-packs");
  if (!fs.existsSync(packs)) { if (fs.existsSync(ledgerPath)) return; stopGate(2, "no migration-packs/ \u2014 run 'prepare' first."); }
  const testPacks = fs.readdirSync(packs).filter(f => f.endsWith(".md") && !/^(INDEX|00_page_objects)\./.test(f) && f !== "INDEX.md" && f !== "00_page_objects.md");
  const genDir = GENERATED || "";
  const genFiles = genDir && fs.existsSync(genDir) ? fs.readdirSync(genDir) : [];
  console.log(`Current batch's packs (${testPacks.length}):`);
  for (const pk of testPacks) {
    const cls = pk.replace(/\.md$/, "");
    const done = genFiles.some(f => f.startsWith(cls) && f.endsWith(".ts"));
    console.log(`  [${done ? "x" : " "}] ${cls}${done ? "" : "   <- pending translation"}`);
  }
}

function report() {
  const rep = loadReport();
  const rd = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
  const records  = rd(path.join(OUT, "records.json"), []);
  const verdicts = rd(path.join(OUT, "verdicts.json"), null);
  const fixes    = rd(path.join(OUT, "fixes.json"), null);   // agent-authored (§5)
  const notes    = rd(path.join(OUT, "notes.json"), {});     // agent-authored prose
  const batch    = rd(path.join(OUT, "migration-packs", "batch.json"), null);

  const PWDIR = CFG.pw || PW_PROJECT || "";
  const PEND  = (what) => `_— agent note pending (${what}) —_`;
  // Escape HTML-significant chars in AGENT-supplied free text so tags like <a>/<frameset> render
  // literally instead of being parsed as HTML by markdown viewers. Leaves `inline code` spans intact.
  const esc = (s) => String(s ?? "").split(/(`[^`]*`)/).map((seg, i) =>
    i % 2 ? seg : seg.replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("");
  const classOf = (id) => { const i = id.lastIndexOf("."); return i > 0 ? id.slice(0, i) : id; };

  // §1 intake, computed from records.json (read the JSON, not the printed line)
  const ORIGIN = { external:"external", computed:"computed", app_read:"app_read", ui_state:"app_read", literal:"literal", ui_literal:"literal", unknown:"unknown" };
  const allOracles = records.flatMap(r => r.oracles || []);
  const byRec = { must_pin:0, planner_can_derive:0, needs_review:0 };
  const byOrigin = { external:0, computed:0, app_read:0, literal:0, unknown:0 };
  for (const o of allOracles) { byRec[o.recovery] = (byRec[o.recovery] || 0) + 1; byOrigin[ORIGIN[o.origin ?? o.type] ?? "unknown"]++; }
  const sourceTests = records.length, assertions = allOracles.length;
  let packCount = null;
  try { packCount = fs.readdirSync(path.join(OUT, "migration-packs")).filter(f => f.endsWith(".md") && f !== "INDEX.md" && f !== "00_page_objects.md").length; } catch {}

  const classes = [...new Set(records.map(r => classOf(r.id)))].sort();
  const testsDir = PWDIR ? path.join(PWDIR, "tests") : (GENERATED || "");
  let specFiles = []; try { specFiles = fs.readdirSync(testsDir); } catch {}
  const specFor = (cls) => specFiles.find(f => f === `${cls}.spec.ts`) || specFiles.find(f => f.startsWith(`${cls}.`) && f.endsWith(".ts"));

  const gate = rep.gate || (verdicts && verdicts.headline ? { pass: verdicts.headline.verdicts.PASS, needsHuman: verdicts.headline.verdicts["NEEDS-HUMAN"], block: verdicts.headline.verdicts.BLOCK, mpFound: verdicts.headline.mpFound, mpTotal: verdicts.headline.mpTotal } : null);
  const pwRun = rep.playwright || null;
  const outcome = notes.outcome ? esc(notes.outcome) : (gate && gate.block === 0 && pwRun && pwRun.failed === 0 ? "COMPLETE — all intent preserved" : "INCOMPLETE — see gate/Playwright below");
  const fmt = (iso) => iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "?";
  const durMin = (rep.started && rep.finished) ? Math.round((Date.parse(rep.finished) - Date.parse(rep.started)) / 60000) : null;
  const suiteName = CFG.suite ? path.basename(CFG.suite) : (SUITE ? path.basename(SUITE) : "(suite)");

  const L = [];
  L.push(`# Migration Run Report — ${suiteName} (Java+Selenium+TestNG → Playwright+TypeScript)\n`);
  L.push(`**Suite:** \`${suiteName}\``);
  L.push(`**Type:** ${notes.type ? esc(notes.type) : "web"}`);
  L.push(`**Date:** ${fmt(rep.started)}${rep.finished ? " – " + fmt(rep.finished).slice(11) : ""}`);
  if (durMin != null) L.push(`**Duration:** ~${durMin} min (agent wall-clock)`);
  L.push(`**Outcome:** ${outcome}`);
  if (gate) { L.push(`**Must-pin recovery:** **${gate.mpFound}/${gate.mpTotal}**`); L.push(`**Gate:** ${gate.pass} PASS · ${gate.needsHuman} NEEDS-HUMAN · ${gate.block} BLOCK`); }
  if (pwRun) L.push(`**Playwright:** ${pwRun.passed}/${pwRun.passed + pwRun.failed} passing`);
  L.push(`**Key fix:** ${notes.keyFix ? esc(notes.keyFix) : PEND("header key-fix summary")}\n`);
  L.push(`> **How to read this report.** A migration is judged on one thing: did every check the source made survive into the target? **Must-pin recovery ${gate ? gate.mpFound + "/" + gate.mpTotal : "X/Y"} with ${gate ? gate.block : 0} BLOCK is that answer — nothing irreplaceable was lost.** NEEDS-HUMAN items are not failures; they are places the deterministic gate could not *score* a faithful translation and asks a human to confirm by eye. Each is explained in §4.`);
  L.push("\n---\n");

  L.push(`## 1. Intake & Fidelity\n`);
  L.push(`| | |`); L.push(`|---|---|`);
  L.push(`| Source tests | ${sourceTests} |`);
  L.push(`| Assertions found | ${assertions} |`);
  L.push(`| Distinct oracles | ${assertions} → **${byRec.must_pin} MUST-PIN**, ${byRec.planner_can_derive} derive, **${byRec.needs_review} REVIEW** |`);
  L.push(`| Packs sliced | ${packCount != null ? packCount + " test packs + 1 page-objects pack" : "(n/a)"} |`);
  L.push(`\n**Oracle origin breakdown** — where each expected value comes from:\n`);
  L.push(`| Origin | Count | Meaning | On loss |`); L.push(`|---|---|---|---|`);
  L.push(`| \`external\` | ${byOrigin.external} | Value comes from outside the app (API response, data file) | MUST-PIN → BLOCK |`);
  L.push(`| \`computed\` | ${byOrigin.computed} | Value is calculated in the test | MUST-PIN → BLOCK |`);
  L.push(`| \`app_read\` | ${byOrigin.app_read} | A live fact about the page, re-read at runtime | derive → NEEDS-HUMAN |`);
  L.push(`| \`literal\` | ${byOrigin.literal} | Compared against a hardcoded string/number | derive → NEEDS-HUMAN |`);
  L.push(`| \`unknown\` | ${byOrigin.unknown} | Origin could not be traced | REVIEW (pinned, fail-safe) |`);
  L.push(`\n**Localization check (the \`literal = ${byOrigin.literal}\` line).** ${notes.localization ? esc(notes.localization) : PEND("localization judgment on the hardcoded-string oracles")}`);
  L.push("\n---\n");

  L.push(`## 2. Intake Attestation (HARD-STOP 1)\n`);
  const att = notes.attestation || {};
  L.push(`- **Attested:** ${att.attested ? esc(att.attested) : PEND("intake attestation")}`);
  L.push(`- **Baseline:** ${att.baseline ? esc(att.baseline) : (rep.baseline ? `${rep.baseline.tests != null ? (rep.baseline.tests - rep.baseline.failed) + "/" + rep.baseline.tests + " passed" : "recorded"}` : "not run — attested instead")}`);
  L.push(`- **Proceed decision:** ${att.proceed ? esc(att.proceed) : PEND("proceed decision")}`);
  L.push("\n---\n");

  L.push(`## 3. What was migrated\n`);
  L.push(`| Source class | Generated spec | Status |`); L.push(`|---|---|---|`);
  for (const cls of classes) { const sp = specFor(cls); L.push(`| ${cls} | ${sp || "—"} | ${sp ? "✅" : "— missing"} |`); }
  L.push(`\n- **Totals:** ${classes.length} classes · ${sourceTests} source test methods${pwRun ? " · " + (pwRun.passed + pwRun.failed) + " runtime tests" : ""}.`);
  L.push(batch && batch.deferred && batch.deferred.length ? `- **Deferred to a later batch:** ${batch.deferred.join(", ")}.` : `- **Deferred to a later batch:** none.`);
  if (batch && batch.skipped && batch.skipped.length) { L.push(`- **Skipped (deliberately excluded):**`); for (const sk of batch.skipped) L.push(`  - \`${sk.name}\` — ${sk.reason}`); } else L.push(`- **Skipped (deliberately excluded):** none.`);
  L.push("\n---\n");

  L.push(`## 4. Gate verdicts\n`);
  if (verdicts && verdicts.tests) {
    const nonPass = verdicts.tests.filter(t => t.verdict !== "PASS");
    const passN = verdicts.tests.length - nonPass.length;
    L.push(`The gate re-reads both sides and scores whether each oracle survived. **must-pin ${gate.mpFound}/${gate.mpTotal} · ${gate.block} BLOCK.** ${nonPass.length ? "The " + nonPass.length + " non-PASS row(s) are explained below." : "Every test passed."}\n`);
    if (nonPass.length) {
      L.push(`| Source test | must-pin | verdict | Why (not a loss) |`); L.push(`|---|---|---|---|`);
      for (const t of nonPass) { const raw = (notes.verdictReasons && notes.verdictReasons[t.id]) || t.notes.join("; "); const reason = raw ? esc(raw) : PEND("reason"); L.push(`| ${t.id} | ${t.mpFound}/${t.mpTotal} | ${t.verdict} | ${reason} |`); }
      const missingHuman = nonPass.some(t => !(notes.verdictReasons && notes.verdictReasons[t.id]));
      if (missingHuman) L.push(`\n_Rows without a written explanation show the gate's mechanical note; add human elaboration via notes.json → verdictReasons before hand-off._`);
      L.push("");
    }
    L.push(`All other ${passN} test(s): **PASS** — every oracle matched.`);
    if (verdicts.headline && verdicts.headline.unscoreable) L.push(`\n(+ ${verdicts.headline.unscoreable} unscoreable must-pin(s) — generic subject/expected names give the matcher no tokens; reported, not counted. Verify by eye.)`);
  } else L.push(PEND("verdicts.json not found — run validate to emit it"));
  L.push("\n---\n");

  L.push(`## 5. Interaction fixes applied (HARD-STOP 3, rule 2)\n`);
  if (Array.isArray(fixes) && fixes.length) {
    const violation = fixes.some(f => f.assertionsTouched);
    if (violation) L.push(`> ⚠ **A recorded fix reports \`assertionsTouched: true\`.** Under HARD-STOP 3 rule 2 an interaction fix must NOT touch an assertion — review before hand-off.\n`);
    L.push(`No assertion was altered${violation ? " except where flagged" : ""}.\n`);
    L.push(`| # | File | Change | Cause (verified) | Assertions |`); L.push(`|---|---|---|---|---|`);
    fixes.forEach((f, i) => L.push(`| ${i + 1} | \`${f.file ? esc(f.file) : "?"}\` | ${f.change ? esc(f.change) : "?"} | ${f.cause ? esc(f.cause) : "?"}${f.evidence ? " — " + esc(f.evidence) : ""} | ${f.assertionsTouched ? "**TOUCHED ⚠**" : "untouched"} |`));
  } else L.push(`None recorded.${(rep.steps || []).some(s => s.step === "playwright" && s.status === "FAILED") ? " _(A Playwright cycle failed then recovered — if a fix was applied it should be in fixes.json.)_" : ""}`);
  L.push("\n---\n");

  L.push(`## 6. Cycle history\n`);
  const vSteps = (rep.steps || []).filter(s => ["gate", "tsc", "playwright"].includes(s.step));
  const cycles = []; let cur = {};
  for (const s of vSteps) { cur[s.step] = s; if (s.step === "playwright") { cycles.push(cur); cur = {}; } }
  if (Object.keys(cur).length) cycles.push(cur);
  if (cycles.length) {
    L.push(`| Cycle | gate | tsc | playwright | Outcome |`); L.push(`|---|---|---|---|---|`);
    cycles.forEach((c, i) => {
      const cell = (s) => s ? `${s.status === "ok" ? "✅" : "❌"} ${s.seconds || "?"}s` : "—";
      const pwOut = c.playwright && c.playwright.passed !== undefined ? (c.playwright.failed ? `${c.playwright.failed} failing` : `${c.playwright.passed}/${c.playwright.passed} passing`) : "";
      const reason = esc((notes.cycleReasons && notes.cycleReasons[i]) || "");
      L.push(`| ${i + 1} | ${cell(c.gate)} | ${cell(c.tsc)} | ${cell(c.playwright)} | ${[pwOut, reason].filter(Boolean).join(" — ") || "—"} |`);
    });
  } else L.push(`(single cycle — no fix-loop recorded)`);
  L.push("\n---\n");

  L.push(`## 7. Findings about the customer's system\n`);
  if (notes.findings && notes.findings.length) for (const f of notes.findings) L.push(`- ${esc(f)}`); else L.push(`- ${PEND("customer-system findings")}`);
  if (verdicts && verdicts.headline) L.push(`- **Blind spots:** ${verdicts.headline.blind === 0 ? "none — every page object and helper was followed" : verdicts.headline.blind + " (calls the gate could not follow)"}.`);
  L.push("\n---\n");

  L.push(`## 8. Playwright execution\n`);
  if (pwRun) { L.push(`- **Result:** ${pwRun.passed} passed, ${pwRun.failed} failed.`); L.push(`- **Command:** \`npx playwright test\``); L.push(`- **tsc --noEmit:** ${(rep.steps || []).some(s => s.step === "tsc" && s.status === "ok") ? "clean (compiles)" : "see steps"}`); } else L.push(`(not run)`);
  L.push("\n---\n");

  L.push(`## 9. Pipeline steps\n`);
  L.push(`| Step | Status | Time |`); L.push(`|---|---|---|`);
  let toolSec = 0;
  for (const s of rep.steps || []) { toolSec += parseFloat(s.seconds) || 0; L.push(`| ${s.step} | ${s.status} | ${s.seconds ? s.seconds + " s" : "—"} |`); }
  if (durMin != null) L.push(`\n**Why these don't sum to ~${durMin} min.** The times above are *deterministic tool* time (~${(toolSec / 60).toFixed(1)} min). The rest of the wall-clock is **agent** work between the tool steps — reading packs, writing specs, diagnosing failures — which the orchestrator can't meter. The difference *is* the agent time.`);
  L.push("\n---\n");

  L.push(`## 10. Translation cost\n`);
  let tokenLine = "not metered (agent runtime, e.g. a Claude subscription). The deterministic steps above cost ZERO tokens.";
  const tks = rd(path.join(OUT, "tokens.json"), null);
  if (Array.isArray(tks)) { const i = tks.reduce((a, x) => a + (x.input_tokens || 0), 0), o = tks.reduce((a, x) => a + (x.output_tokens || 0), 0); tokenLine = `input ${i}, output ${o}, across ${tks.length} translation call(s) (from tokens.json).`; }
  L.push(tokenLine + "\n");
  L.push(`| Runtime | Where the cost shows | Read by the kit? |`); L.push(`|---|---|---|`);
  L.push(`| GitHub Copilot (VS Code) | Copilot chat popover — AI Credits + context | No |`);
  L.push(`| Cursor | Cursor usage panel | No |`);
  L.push(`| Claude subscription | In-app usage | No |`);
  L.push(`| Anthropic API | \`usage\` on each response → \`tokens.json\` | **Yes** |`);
  L.push("\n---\n");

  L.push(`## 11. Re-run commands\n`);
  L.push("```");
  L.push(`# Full validation of the migrated suite`);
  L.push(`node <TESTNG-KIT>\\tools\\orchestrator\\orchestrate.mjs validate --out <WORK> --generated <PW>\\tests --pw <PW>`);
  L.push("");
  L.push(`# The migrated suite alone`);
  L.push(`cd <PW> && npx playwright test`);
  L.push("```");

  const md = L.join("\n") + "\n";
  const mdDir = (CFG.pw && fs.existsSync(CFG.pw)) ? CFG.pw : OUT;
  const mdPath = path.join(mdDir, "migration-run-report.md");
  fs.writeFileSync(mdPath, md);
  console.log(md);
  console.log(`(written ${mdPath})`);
}

const table = { setup, prepare, validate, status, report };
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!table[cmd]) {
    console.log(`usage: node orchestrate.mjs <setup|prepare|validate|status|report> [options]\n`
      + `  setup    --kit <kit>                       (auto-runs inside prepare; --no-setup to skip)\n`
      + `  prepare  --kit <kit> --suite <suite> --out <workdir> [--run-baseline --browser CHROME] [--dry-run]\n`
      + `  validate --kit <kit> --out <workdir> --generated <specs-dir> [--pw <pw-project>] [--dry-run]\n`
      + `  status   --out <workdir> [--generated <specs-dir>]\n`
      + `\n  batching (large engagements):\n`
      + `    --batch-size 30 --batch 1        migrate the 1st chunk of 30 classes; repeat with --batch 2, 3...\n`
      + `    --only A,B  | --only-file <f>    migrate only these (rest DEFERRED)\n`
      + `    --skip  A,B | --skip-file <f>    exclude with a reason (SKIPPED, auditable)\n`
      + `  report   --out <workdir>`);
    process.exit(cmd ? 2 : 0);
  }
  table[cmd]();
}
