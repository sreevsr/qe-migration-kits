#!/usr/bin/env node
/**
 * step-binder.mjs — THE novel deterministic piece. Match each Gherkin step to its Java
 * @Given/@When/@Then step-definition method, extract capture-group params, flag UNBOUND/AMBIGUOUS.
 * No LLM.
 *
 *   node step-binder.mjs --repo <suite-root> --features features.json [--out bound.json]
 *
 * Reads the step-def .java files, parses every @Given/@When/@Then/@And/@But annotation into a
 * matcher (Cucumber regex OR cucumber-expression), then for each Gherkin step (from the feature
 * model) finds the matching definition.
 *
 * Fail-safes (mirror the extractor's REVIEW discipline — never guess):
 *  - 0 matches  -> UNBOUND  (recorded; a real gap for human review / gate BLOCK)
 *  - >1 match   -> AMBIGUOUS (flagged; the binder does not pick one)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---- collect step-def annotations from Java ----
// matches: @Given("...")  @When("^...$")  @Then('...')  incl. io.cucumber & cucumber.api styles
//
// WHY A REGEX AND NOT AN AST. The extractor parses Java properly (JavaParser); this tool does not,
// because it runs BEFORE the extractor — it is what tells the extractor which methods are entry
// points. That is a real trade-off, and it has real edge cases (below). What makes it safe rather
// than merely convenient is the FAILURE MODE: anything this regex cannot read becomes UNBOUND,
// which is a hard stop (exit 15) a human resolves. It never produces a WRONG binding silently.
//
// GAP: whatever may legally sit between the annotation and the method signature. Java allows a lot
// here and real enterprise code uses it: line comments, block comments, javadoc, and further
// annotations (@Override, @SuppressWarnings("x")). A trailing `// note` on the annotation line used
// to break the binding entirely and report a perfectly good step as UNBOUND.
const GAP = String.raw`(?:\s|//[^\n]*|/\*(?:[^*]|\*(?!/))*\*/|@\w+(?:\([^)]*\))?)*`;
const ANNO_RE = new RegExp(
  String.raw`@(Given|When|Then|And|But)\s*\(\s*(["'])((?:\\.|(?!\2).)*)\2\s*\)` +
  GAP +
  String.raw`(?:public\s+|protected\s+|private\s+)?[\w<>\[\],\s]*?\s+(\w+)\s*\(`,
  "gs"
);
// KNOWN AND ACCEPTED LIMITS — each becomes UNBOUND, i.e. a stop, never a wrong answer:
//   @Given(SOME_CONSTANT)          the value lives in a field; a regex cannot resolve it
//   @Given("^" + PREFIX + "$")     concatenation, same reason
//   annotations inherited from a superclass
// If a real suite trips one of these, the honest fix is to read the annotations from the extractor's
// AST rather than to grow this pattern further.

function findJavaFiles(root) {
  const out = [];
  (function walk(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!["target", "node_modules", ".git"].includes(e.name)) walk(p); }
      else if (e.name.endsWith(".java")) out.push(p);
    }
  })(root);
  return out;
}

// convert a Cucumber annotation pattern into { kind, regex, paramCount }
function patternToMatcher(pattern) {
  // strip Cucumber regex anchors ^ $
  let p = pattern.replace(/^\^/, "").replace(/\$$/, "");
  const isRegex = /[\\()\[\]|+*?]/.test(p) || pattern.startsWith("^") || pattern.endsWith("$");
  if (isRegex) {
    // Java-string already unescaped by our extraction; count capture groups
    const paramCount = (p.match(/\((?!\?:)/g) || []).length;
    let rx; try { rx = new RegExp("^" + p + "$"); } catch { rx = null; }
    return { kind: "regex", raw: pattern, regex: rx, paramCount };
  }
  // cucumber-expression: {string} {int} {word} {float} -> capture groups
  const paramCount = (p.match(/\{[^}]*\}/g) || []).length;
  const rxStr = p
    .replace(/[.*+?^${}()|[\]\\]/g, s => (/[{}]/.test(s) ? s : "\\" + s)) // escape regex, keep braces for now
    .replace(/\\\{string\\\}|\{string\}/g, '"([^"]*)"')
    .replace(/\\\{int\\\}|\{int\}/g, "([-+]?\\d+)")
    .replace(/\\\{float\\\}|\{float\}/g, "([-+]?\\d*\\.?\\d+)")
    .replace(/\\\{word\\\}|\{word\}/g, "(\\S+)")
    .replace(/\\\{\\\}|\{\}/g, "(.*)");
  let rx; try { rx = new RegExp("^" + rxStr + "$"); } catch { rx = null; }
  return { kind: "cucumber-expression", raw: pattern, regex: rx, paramCount };
}

function collectDefinitions(repoRoot) {
  const defs = [];
  for (const f of findJavaFiles(repoRoot)) {
    const src = fs.readFileSync(f, "utf8");
    const cls = (src.match(/class\s+(\w+)/) || [])[1] || path.basename(f, ".java");
    let m;
    ANNO_RE.lastIndex = 0;
    while ((m = ANNO_RE.exec(src))) {
      const [, keyword, , patternRaw, method] = m;
      // unescape Java string escapes (\" -> ", \\ -> \)
      const pattern = patternRaw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      defs.push({ file: path.relative(repoRoot, f).replace(/\\/g, "/"), class: cls, method, keyword, ...patternToMatcher(pattern) });
    }
  }
  return defs;
}

// Gherkin And/But inherit the effective keyword of the preceding Given/When/Then.
// (For binding we match on TEXT against ALL defs regardless of keyword — Cucumber itself binds by
//  text, not keyword — but we record the effective keyword for traceability.)
function effectiveKeywords(steps) {
  let last = "Given";
  return steps.map(s => {
    if (["Given", "When", "Then"].includes(s.keyword)) last = s.keyword;
    return { ...s, effectiveKeyword: (["And", "But", "*"].includes(s.keyword) ? last : s.keyword) };
  });
}

function bindStep(text, defs) {
  const matches = [];
  for (const d of defs) {
    if (!d.regex) continue;
    const m = d.regex.exec(text);
    if (m) matches.push({ def: d, params: m.slice(1) });
  }
  return matches;
}

/**
 * Scenario Outline placeholders: Cucumber substitutes the Examples row BEFORE matching a step to a
 * definition. So must we. Otherwise a typed pattern like ^he waits (\d+) seconds$ never matches the
 * raw text "he waits <delay> seconds", and we report a FALSE UNBOUND for a step that binds fine at
 * runtime (an unbound step is a hard-stop, so false ones are costly).
 * Substitution is for MATCHING ONLY — the feature text is never rewritten.
 */
function substitutePlaceholders(text, row) {
  if (!row) return text;
  return text.replace(/<([^>]+)>/g, (whole, col) => (col in row ? row[col] : whole));
}

function bind(features, defs) {
  const report = { bound: 0, unbound: 0, ambiguous: 0, backgrounds: [], scenarios: [], unused_definitions: [] };
  const usedDefs = new Set();   // which DEFINITIONS (class.method + pattern) any step actually bound to

  // Bind one step: raw text first; for outlines, retry with the first Examples row substituted.
  const bindOne = (step, row) => {
    let matches = bindStep(step.text, defs);
    let matchedVia = "raw";
    let resolvedText = step.text;
    if (matches.length === 0 && row) {
      const sub = substitutePlaceholders(step.text, row);
      if (sub !== step.text) {
        const subMatches = bindStep(sub, defs);
        if (subMatches.length) { matches = subMatches; matchedVia = "example-substituted"; resolvedText = sub; }
      }
    }
    const placeholders = (step.text.match(/<([^>]+)>/g) || []).map(x => x.slice(1, -1));
    if (matches.length === 1) {
      report.bound++;
      const { def, params } = matches[0];
      usedDefs.add(def.class + "." + def.method + "|" + def.raw);
      const out = { ...step, status: "BOUND", bound_method: `${def.class}.${def.method}`, file: def.file, params };
      if (matchedVia !== "raw") { out.matched_via = matchedVia; out.resolved_text = resolvedText; }
      if (placeholders.length) out.placeholders = placeholders;   // params driven by Examples columns
      return out;
    } else if (matches.length === 0) {
      report.unbound++;
      return { ...step, status: "UNBOUND", ...(placeholders.length ? { placeholders } : {}) };
    } else {
      report.ambiguous++;
      return { ...step, status: "AMBIGUOUS", candidates: matches.map(x => `${x.def.class}.${x.def.method}`) };
    }
  };

  for (const feat of features) {
    // BACKGROUND — Cucumber runs these before EVERY scenario in the feature, so they carry real
    // setup (e.g. the step that opens the page). Skipping them would silently drop that setup and
    // the migrated suite would fail with nothing on screen. Bound ONCE per feature (the same
    // step-def serves every scenario), so counts are not inflated.
    if (feat.background && feat.background.steps && feat.background.steps.length) {
      const bgSteps = effectiveKeywords(feat.background.steps).map(s => bindOne(s, null));
      report.backgrounds.push({ feature: feat.file, name: feat.background.name || "", steps: bgSteps });
    }

    for (const sc of feat.scenarios) {
      // For outlines, the first Examples row is representative: every row binds to the same method.
      const row = sc.type === "outline" && sc.examples && sc.examples.length ? sc.examples[0] : null;
      const steps = effectiveKeywords(sc.steps).map(s => bindOne(s, row));
      report.scenarios.push({
        feature: feat.file, scenario: sc.name, tags: sc.tags, type: sc.type, examples: sc.examples,
        has_background: !!(feat.background && feat.background.steps && feat.background.steps.length),
        steps
      });
    }
  }

  // Dead glue: step definitions no feature references. NOT the same as an UNBOUND step (that's a
  // Gherkin step with no definition — a hard-stop). This is the reverse: a definition nothing uses.
  // Worth reporting, not stopping on: at scale it says "don't migrate this glue".
  for (const d of defs) {
    if (!usedDefs.has(d.class + "." + d.method + "|" + d.raw))
      report.unused_definitions.push({ class: d.class, method: d.method, keyword: d.keyword, pattern: d.raw, file: d.file });
  }
  return report;
}

// ---- CLI ----
// Guarded so this module can be IMPORTED (for composition/tests) without executing the CLI or
// calling process.exit. Without this, `import { collectDefinitions }` runs the CLI and exits.
function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const repo = opt("--repo", ""), featuresPath = opt("--features", ""), outPath = opt("--out", "");
  if (!repo || !featuresPath) { console.error("usage: node step-binder.mjs --repo <root> --features features.json [--out bound.json] [--entry-points-out <file>]"); process.exit(2); }

  const features = JSON.parse(fs.readFileSync(featuresPath, "utf8"));
  const defs = collectDefinitions(path.resolve(repo));
  const report = bind(features, defs);
  const json = JSON.stringify(report, null, 2);
  if (outPath) fs.writeFileSync(outPath, json);

  // --entry-points-out <file>: the unique bound methods, one "Class.method" per line — the input the
  // SHARED extractor takes via its --entry-points flag. This is the seam between the two kits: the
  // binder decides WHICH methods are entry points; the extractor's origin-tracing classifier (reused
  // unchanged from the TestNG kit) decides what each one asserts.
  const epOut = opt("--entry-points-out", "");
  if (epOut) {
    const methods = new Set();
    const collect = steps => steps.forEach(s => { if (s.status === "BOUND" && s.bound_method) methods.add(s.bound_method); });
    report.backgrounds.forEach(b => collect(b.steps));   // background steps carry real setup — include them
    report.scenarios.forEach(sc => collect(sc.steps));
    const list = [...methods].sort();
    fs.writeFileSync(epOut, list.join("\n") + "\n");
    console.error(`step-binder: wrote ${list.length} unique entry point(s) -> ${epOut}`);
  }

  console.error(`step-binder: ${defs.length} step-def(s) found · BOUND ${report.bound} · UNBOUND ${report.unbound} · AMBIGUOUS ${report.ambiguous} · background step(s) bound: ${report.backgrounds.reduce((a,b)=>a+b.steps.length,0)} across ${report.backgrounds.length} feature(s)`);
  if (report.unused_definitions.length)
    console.error(`step-binder: ${report.unused_definitions.length} step definition(s) are UNUSED (no feature references them) — dead glue, safe to skip when migrating. See unused_definitions in the report.`);
  if (!outPath) console.log(json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { patternToMatcher, collectDefinitions, bind };
