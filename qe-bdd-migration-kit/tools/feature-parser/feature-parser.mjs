#!/usr/bin/env node
/**
 * feature-parser.mjs — parse Cucumber .feature files into a JSON model. Deterministic, no LLM.
 *
 *   node feature-parser.mjs --repo <suite-root> [--out features.json]
 *
 * Emits: [ { file, feature, description?, background?, scenarios: [
 *   { name, type: "scenario"|"outline", tags: [], steps: [ {keyword, text} ], examples?: [ {col:val} ] }
 * ] } ]
 *
 * Rules:
 *  - keyword is the LITERAL Gherkin keyword (Given/When/Then/And/But). The step-binder resolves
 *    And/But to the effective Given/When/Then by surrounding context — the parser does NOT guess.
 *  - step text is preserved EXACTLY (including quoted args and <placeholders>).
 *  - Scenario Outline Examples become an array of row objects keyed by the header cells.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function findFeatureFiles(root) {
  const out = [];
  (function walk(d) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "target" || e.name === "node_modules" || e.name === ".git") continue;
        walk(p);
      } else if (e.name.endsWith(".feature")) out.push(p);
    }
  })(root);
  return out;
}

const STEP_KEYWORDS = ["Given", "When", "Then", "And", "But", "*"];

function parseFeatureFile(filePath, repoRoot) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const model = { file: path.relative(repoRoot, filePath).replace(/\\/g, "/"), feature: null, description: [], scenarios: [] };
  let pendingTags = [];
  let cur = null;              // current scenario
  let inExamples = false, exHeader = null;
  let background = null;

  const isStep = (t) => STEP_KEYWORDS.some(k => t === k || t.startsWith(k + " "));

  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("@")) { pendingTags.push(...line.split(/\s+/).filter(Boolean)); continue; }

    if (line.startsWith("Feature:")) { model.feature = line.slice(8).trim(); pendingTags = []; continue; }
    if (line.startsWith("Description:")) { model.description.push(line.slice(12).trim()); continue; }

    if (line.startsWith("Background:")) {
      background = { name: line.slice(11).trim(), steps: [] };
      model.background = background; cur = background; inExamples = false; continue;
    }

    if (line.startsWith("Scenario Outline:") || line.startsWith("Scenario Template:")) {
      cur = { name: line.replace(/^Scenario (Outline|Template):/, "").trim(), type: "outline", tags: pendingTags, steps: [], examples: [] };
      model.scenarios.push(cur); pendingTags = []; inExamples = false; continue;
    }
    if (line.startsWith("Scenario:")) {
      cur = { name: line.slice(9).trim(), type: "scenario", tags: pendingTags, steps: [] };
      model.scenarios.push(cur); pendingTags = []; inExamples = false; continue;
    }

    if (line.startsWith("Examples:")) { inExamples = true; exHeader = null; continue; }

    // table row (Examples or DataTable)
    if (line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map(c => c.trim());
      if (inExamples && cur && cur.type === "outline") {
        if (!exHeader) { exHeader = cells; }
        else { const row = {}; exHeader.forEach((h, i) => row[h] = cells[i]); cur.examples.push(row); }
      } else if (cur && cur.steps.length) {
        // attach as a data table to the last step
        const last = cur.steps[cur.steps.length - 1];
        (last.table ||= []).push(cells);
      }
      continue;
    }

    if (isStep(line) && cur) {
      const sp = line.indexOf(" ");
      const keyword = sp === -1 ? line : line.slice(0, sp);
      const text = sp === -1 ? "" : line.slice(sp + 1).trim();
      cur.steps.push({ keyword, text });
      inExamples = false;
      continue;
    }
  }
  if (model.description.length === 0) delete model.description;
  return model;
}

// ---- CLI ---- (guarded so the module can be imported without executing/exiting)
function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const repo = opt("--repo", "");
  const outPath = opt("--out", "");
  if (!repo) { console.error("usage: node feature-parser.mjs --repo <suite-root> [--out features.json]"); process.exit(2); }

  const files = findFeatureFiles(path.resolve(repo));
  const models = files.map(f => parseFeatureFile(f, path.resolve(repo)));
  const totalScenarios = models.reduce((a, m) => a + m.scenarios.length, 0);
  const json = JSON.stringify(models, null, 2);
  if (outPath) { fs.writeFileSync(outPath, json); }
  console.error(`feature-parser: ${files.length} feature file(s), ${totalScenarios} scenario(s)${outPath ? ` -> ${outPath}` : ""}`);
  if (!outPath) console.log(json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { parseFeatureFile, findFeatureFiles };
