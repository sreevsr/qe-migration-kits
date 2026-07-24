#!/usr/bin/env node
/**
 * init.mjs — one command to start a migration.
 *
 * Replaces: pick the right kit, invent four folder names, retype four absolute paths into a chat
 * box, hand-copy an instruction file, scaffold a Playwright project, and discover halfway through
 * that the suite uses Screenplay (unsupported) or that your proxy eats npm.
 *
 *   node <TESTNG_KIT>/tools/orchestrator/init.mjs --suite "C:\path\to\customer-suite"
 *
 * It lives in the TestNG kit because that kit is ALWAYS present — the BDD kit borrows its extractor
 * and its gate. Same reason the shared things live here.
 *
 * Exit codes: 0 ok · 2 bad --suite · 4 unsupported framework · 11 missing prerequisite · 12 scaffold failed
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const argv = process.argv.slice(2);
const opt = (k, d = "") => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTNG_KIT = path.resolve(HERE, "..", "..");

const bail = (code, title, lines) => {
  console.error(`\n\u26d4 ${title}\n`);
  for (const l of lines) console.error(`   ${l}`);
  console.error("");
  process.exit(code);
};

// Same exclusions as every other tool in the kit. Without them a Maven `target/` copy of the
// features doubles every count and the first thing a new user sees is a number that looks wrong.
function walk(dir, match, out = []) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "target" || e.name === "node_modules" || e.name === ".git") continue;
      walk(p, match, out);
    } else if (match(e.name)) out.push(p);
  }
  return out;
}
const toolPresent = (cmd) => { try { execSync(cmd, { stdio: "ignore" }); return true; } catch { return false; } };

// ---------------------------------------------------------------------------------------------
if (has("--help") || has("-h") || !opt("--suite")) {
  console.log(`
Start a migration. One command; everything else is derived.

  node <TESTNG_KIT>/tools/orchestrator/init.mjs --suite <path-to-source-suite>

  --suite <path>      REQUIRED. The customer's Java+Selenium suite (the folder with pom.xml).
                      Never modified — it is read-only input.
  --into <path>       Where to create the migration. Default: "<suite>-migration", beside the suite.
  --editor <name>     copilot (default) | cursor | claude
  --no-scaffold       Skip the npm install / Playwright setup (config + instructions only).
  --bdd-kit <path>    Only if the BDD kit is not a sibling of this one.

Then open the created folder in your editor and say:  Migrate the suite.
`);
  process.exit(opt("--suite") ? 0 : 2);
}

const SUITE = path.resolve(opt("--suite"));
const EDITOR = opt("--editor", "copilot").toLowerCase();
if (!["copilot", "cursor", "claude"].includes(EDITOR))
  bail(2, `--editor must be copilot, cursor or claude (got "${EDITOR}")`, []);

console.log(`\n\u2699  init \u2014 setting up a migration\n`);

// ---- 1. prerequisites ------------------------------------------------------------------------
const probes = [["java", "java -version"], ["mvn", "mvn -version"], ["node", "node -v"], ["npx", "npx -v"]];
const missing = probes.filter(([, c]) => !toolPresent(c)).map(([t]) => t);
if (missing.length)
  bail(11, `Missing on PATH: ${missing.join(", ")}`, [
    missing.includes("java") || missing.includes("mvn")
      ? "JDK 21 + Maven:  choco install temurin21 maven -y   (or see INSTALL-PREREQS.md for the no-admin route)" : "",
    missing.includes("node") || missing.includes("npx")
      ? "Node 22.15+:     choco install nodejs-lts -y" : "",
    "",
    "Then CLOSE EVERY TERMINAL AND VS CODE (a PATH change never reaches an open one) and re-run.",
  ].filter(Boolean));
console.log(`  \u2713 java, mvn, node, npx present`);

// ---- 2. the suite ----------------------------------------------------------------------------
if (!fs.existsSync(SUITE))
  bail(2, `--suite does not exist: ${SUITE}`, ["Pass the FULL path to the suite root (the folder containing pom.xml)."]);
if (!fs.existsSync(path.join(SUITE, "pom.xml")))
  bail(2, `No pom.xml in ${SUITE}`, [
    "--suite must be the Maven project ROOT, not a subfolder.",
    "If the suite is Gradle-only, this kit cannot read it: the extractor needs Maven to resolve the",
    "classpath. That is a real limitation, not a workaround-able one.",
  ]);
const pom = fs.readFileSync(path.join(SUITE, "pom.xml"), "utf8").toLowerCase();
console.log(`  \u2713 suite: ${SUITE}`);

// ---- 3. refuse what we genuinely cannot do ---------------------------------------------------
// Better to say so in the first 10 seconds than to be discovered at the gate. Each of these is a
// boundary we have held deliberately, not a TODO.
const javaFiles = walk(SUITE, (n) => n.endsWith(".java"));
const javaText = javaFiles.slice(0, 400).map(f => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");
const blockers = [];
if (/serenity/.test(pom) || /net\.serenitybdd/.test(javaText))
  blockers.push(["Serenity BDD", "The kit is proven on plain Cucumber/TestNG + Page Objects. Serenity's reporting, @Steps and its own runner are a different model. NOT attempted \u2014 a Serenity suite needs its own probe before anyone commits to a timeline."]);
if (/screenplay/.test(pom) || /screenplay|attemptsTo\(|Task\.where|Question\.about/.test(javaText))
  blockers.push(["Screenplay pattern", "Actors/Tasks/Questions replace Page Objects entirely. The kit's slicer and DI resolver assume Page Objects. NOT supported, and not a small gap."]);
if (/cucumber-spring/.test(pom)) blockers.push(["Cucumber + Spring DI", "The DI resolver supports PicoContainer and static driver factories. Spring's context is not modelled."]);
if (/cucumber-guice/.test(pom))  blockers.push(["Cucumber + Guice DI", "The DI resolver supports PicoContainer and static driver factories. Guice is not modelled."]);
if (blockers.length) {
  console.error(`\n\u26d4 This suite uses something the kit does not support.\n`);
  for (const [what, why] of blockers) { console.error(`   ${what}`); console.error(`     ${why}\n`); }
  console.error(`   Stopping now rather than at the gate, half a migration later.`);
  console.error(`   What IS proven: Cucumber+PageObjects+PicoContainer/static-DI, and plain TestNG/JUnit`);
  console.error(`   + Page Objects. Both end-to-end, on real suites.\n`);
  process.exit(4);
}

// ---- 4. detect the kind ----------------------------------------------------------------------
// .feature files decide it. NOT the pom: a Cucumber suite very often uses TestNG purely as its
// runner (the validation suite does exactly that, with testng in the pom and zero @Test methods).
// Detecting on "testng in pom" would send it down the wrong kit.
const features = walk(SUITE, (n) => n.endsWith(".feature"));
const KIND = features.length > 0 ? "bdd" : "testng";
const testFiles = javaFiles.filter(f => { try { return /@Test\b/.test(fs.readFileSync(f, "utf8")); } catch { return false; } });
if (KIND === "bdd") console.log(`  \u2713 detected BDD \u2014 ${features.length} .feature file(s) (a TestNG runner alongside them is normal)`);
else {
  if (testFiles.length === 0)
    bail(2, `No .feature files and no @Test methods found in ${SUITE}`, [
      "The kit finds tests one of two ways: .feature files (BDD), or @Test annotations (TestNG/JUnit).",
      "This suite has neither, so there is nothing to migrate from. Is --suite pointing at the right folder?",
    ]);
  console.log(`  \u2713 detected TestNG/JUnit \u2014 ${testFiles.length} file(s) with @Test`);
}

// ---- 5. resolve the kits ---------------------------------------------------------------------
let KIT = TESTNG_KIT;
if (KIND === "bdd") {
  const guess = opt("--bdd-kit") || path.resolve(TESTNG_KIT, "..", "qe-bdd-migration-kit");
  if (!fs.existsSync(path.join(guess, "tools", "orchestrator", "orchestrate_bdd.mjs")))
    bail(2, `This is a BDD suite, but the BDD kit is not where I looked:`, [
      guess, "",
      "The BDD kit is a separate folder. Put it beside this one, or pass --bdd-kit <path>.",
      "(It is not standalone \u2014 it borrows this kit's extractor and gate.)",
    ]);
  KIT = path.resolve(guess);
  console.log(`  \u2713 BDD kit:    ${KIT}`);
  console.log(`  \u2713 shared kit: ${TESTNG_KIT}`);
} else console.log(`  \u2713 kit: ${KIT}`);

// ---- 6. create the migration folder ----------------------------------------------------------
// ONE folder. It IS the Playwright project, and `work/` inside it is scratch. The old layout was
// three near-identical names (cuke-suite / run-cuke / cuke-run) for input, scratch and deliverable
// \u2014 which nobody could keep straight, including the person who named them.
const INTO = path.resolve(opt("--into") || `${SUITE}-migration`);
if (fs.existsSync(INTO) && fs.readdirSync(INTO).length && !has("--force"))
  bail(2, `${INTO} already exists and is not empty.`, [
    "Delete it, pick another with --into <path>, or pass --force if you mean to reuse it.",
    "(Reusing a folder with an old ledger in it gives confusing resume behaviour.)",
  ]);
fs.mkdirSync(path.join(INTO, "work"), { recursive: true });
console.log(`\n  \u2713 created ${INTO}`);

// ---- 7. migration.json: the paths live in a FILE, not in your prompt -------------------------
const cfg = {
  kind: KIND,
  suite: SUITE,
  kit: KIT,
  testngKit: TESTNG_KIT,
  work: "work",
  pw: ".",
  editor: EDITOR,
  created: new Date().toISOString(),
};
fs.writeFileSync(path.join(INTO, "migration.json"), JSON.stringify(cfg, null, 2));
console.log(`  \u2713 migration.json  \u2014 the orchestrator reads its paths from here, so you never retype them`);

fs.writeFileSync(path.join(INTO, ".gitignore"),
`# scratch: absolute machine paths inside. Never portable, never committed.
work/
node_modules/
.features-gen/
test-results/
playwright-report/
cp.txt

# secrets: real credential values live here, never committed. .env.example (committed) lists the keys.
.env
`);
fs.writeFileSync(path.join(INTO, ".env.example"),
`# Copy this file to .env and fill in real values. .env is gitignored; .env.example (keys only) is committed.
# The agent lists the keys the source suite actually needs. In code, read them via process.env.<KEY>.
#
# Examples (replace with the suite's real keys — real secrets get NO default in code):
# BASE_URL=
# APP_USERNAME=
# APP_PASSWORD=
`);
console.log(`  \u2713 .env.example  \u2014 keys the migrated suite reads from process.env (.env is gitignored)`);

// ---- 8. drop in the instruction file ---------------------------------------------------------
const agentDir = path.join(KIT, "agent");
if (EDITOR === "copilot") {
  fs.mkdirSync(path.join(INTO, ".github"), { recursive: true });
  fs.copyFileSync(path.join(agentDir, ".github", "copilot-instructions.md"), path.join(INTO, ".github", "copilot-instructions.md"));
  console.log(`  \u2713 .github/copilot-instructions.md`);
} else if (EDITOR === "cursor") {
  fs.mkdirSync(path.join(INTO, ".cursor"), { recursive: true });
  fs.copyFileSync(path.join(agentDir, ".cursor", "rules"), path.join(INTO, ".cursor", "rules"));
  console.log(`  \u2713 .cursor/rules`);
} else {
  fs.copyFileSync(path.join(agentDir, "CLAUDE.md"), path.join(INTO, "CLAUDE.md"));
  const cp = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true }))
      e.isDirectory() ? cp(path.join(src, e.name), path.join(dst, e.name))
                      : fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name)); };
  cp(path.join(agentDir, ".claude"), path.join(INTO, ".claude"));
  console.log(`  \u2713 CLAUDE.md + .claude/skills/`);
}

// ---- 9. scaffold ------------------------------------------------------------------------------
if (!has("--no-scaffold")) {
  console.log(`\n  \u2026 scaffolding the Playwright project`);
  const deps = KIND === "bdd"
    ? "@playwright/test playwright-bdd dotenv typescript @types/node"
    : "@playwright/test dotenv typescript @types/node";
  fs.writeFileSync(path.join(INTO, "package.json"), JSON.stringify({
    name: path.basename(INTO).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    private: true, type: "module", scripts: KIND === "bdd"
      ? { test: "npx bddgen && npx playwright test", typecheck: "tsc --noEmit" }
      : { test: "npx playwright test", typecheck: "tsc --noEmit" },
  }, null, 2));
  // TypeScript 7 removed moduleResolution node10; "module": "preserve" is the working default and
  // this exact tsconfig has been through both proven runs.
  fs.writeFileSync(path.join(INTO, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "preserve", moduleDetection: "force", strict: true,
      skipLibCheck: true, noEmit: true, types: ["node"] },
  }, null, 2));
  fs.writeFileSync(path.join(INTO, "playwright.config.ts"), KIND === "bdd"
    ? `import "dotenv/config";   // loads .env into process.env; secrets come from there, never a committed file
import { defineConfig } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

// The agent may add baseURL / timeouts to match the source suite's config.
const testDir = defineBddConfig({
  features: "features/**/*.feature",
  steps: ["steps/**/*.ts", "fixtures.ts"],   // exactly what agent/CLAUDE.md specifies — do not diverge
});

export default defineConfig({
  testDir,
  use: { screenshot: "only-on-failure" },   // replaces the source's screenshot @After hook
});
`
    : `import "dotenv/config";   // loads .env into process.env; secrets come from there, never a committed file
import { defineConfig } from "@playwright/test";

// The agent may add baseURL / timeouts to match the source suite's config.
export default defineConfig({
  testDir: "./tests",
  use: { screenshot: "only-on-failure" },
});
`);

  // The corporate-CA retry. This is the reason init scaffolds at all: the agent spawns its own
  // terminal, which does NOT inherit a NODE_OPTIONS you set in yours — so an install that works by
  // hand hangs for the agent, and you spend the demo debugging a proxy.
  const npm = (extraEnv) => {
    try { execSync(`npm i -D ${deps}`, { cwd: INTO, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env }); return { ok: true, out: "" }; }
    catch (e) { return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` }; }
  };
  let r = npm();
  if (!r.ok && /self.signed|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|CERT_|certificate|SSL routines/i.test(r.out)) {
    console.log(`    \u2139 npm hit a certificate error \u2014 a corporate TLS-inspecting proxy. Retrying with the`);
    console.log(`      machine's CA store (NODE_OPTIONS=--use-system-ca) \u2026`);
    r = npm({ NODE_OPTIONS: `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : ""}--use-system-ca` });
    if (r.ok) {
      console.log(`    \u2713 worked. Set it once so every terminal (including the agent's) inherits it:`);
      console.log(`      [Environment]::SetEnvironmentVariable("NODE_OPTIONS","--use-system-ca","User")   then restart VS Code`);
    }
  }
  if (!r.ok) {
    console.error(`\n\u26d4 npm install failed. The project is created; only the packages are missing.\n`);
    console.error(r.out.split("\n").slice(-12).join("\n"));
    console.error(`\n   Run it yourself, then continue:`);
    console.error(`     cd "${INTO}"`);
    console.error(`     $env:NODE_OPTIONS="--use-system-ca"`);
    console.error(`     npm i -D ${deps}`);
    console.error(`     npx playwright install chromium\n`);
    process.exit(12);
  }
  console.log(`    \u2713 packages installed`);

  // Browsers are a SEPARATE download, from a CDN rather than the npm registry — so npm's proxy
  // settings do not apply to it and it fails differently (a silent hang, not a cert error).
  try {
    execSync(`npx playwright install chromium`, { cwd: INTO, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    console.log(`    \u2713 chromium ready`);
  } catch (e) {
    console.log(`\n    \u26a0 Browser download did not complete. This is a SEPARATE download from the packages`);
    console.log(`      above \u2014 it comes from a CDN, not npm, so npm's proxy settings do not apply.`);
    console.log(`      Run it in a terminal you can watch, then carry on:`);
    console.log(`        cd "${INTO}" ; npx playwright install chromium`);
    console.log(`      If it hangs silently, the proxy is eating the CDN connection:`);
    console.log(`        $env:HTTPS_PROXY="http://your-proxy:port" ; npx playwright install chromium`);
  }
}

// ---- 10. tell them exactly what to do next ----------------------------------------------------
const editorCmd = EDITOR === "cursor" ? "cursor ." : "code .";
console.log(`
${"\u2500".repeat(78)}
  Ready.  ${KIND === "bdd" ? "BDD (Cucumber)" : "TestNG/JUnit"} migration.

    cd "${INTO}"
    ${editorCmd}

  Then, in ${EDITOR === "copilot" ? "Copilot AGENT mode" : EDITOR === "cursor" ? "Cursor's agent" : "Claude Code"}, say:

      Migrate the suite.

  That is the whole prompt. Every path is in migration.json; the agent reads it.
  To review in stages instead:   Migrate the suite in batches of ${KIND === "bdd" ? "10 features" : "30 classes"}.
${"\u2500".repeat(78)}

  What is where:
    ${SUITE}
        the customer's suite. INPUT ONLY \u2014 never modified.
    ${INTO}
        your migrated Playwright suite. This IS the deliverable.
    ${path.join(INTO, "work")}
        scratch: what the tools extracted, the packs, the ledger. Gitignored; ignore it.
`);
