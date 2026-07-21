/**
 * parity_check_ast.mjs (v3) — call-graph-with-provenance parity gate.
 *
 * Upgrades over v2:
 *  - DEEP call-following: test -> page object -> helper -> utility -> ... (arbitrary depth,
 *    cycle-safe via a visited set, capped to avoid pathological graphs).
 *  - PROVENANCE CHAINS: every assertion records the path of methods it was found through.
 *  - STRUCTURAL "shared" detection: a method reached by >= 2 distinct tests is shared; its
 *    assertions are attributed ONCE ("review once" bucket), not multiplied per test. No method
 *    names / no prior knowledge -> generalises to any customer suite.
 *  - HONEST blind spots: calls that resolve to a bodyless in-project declaration (interface /
 *    abstract / overload -> dynamic dispatch) are reported as "could not follow", not silently
 *    dropped. External (node_modules) calls are not blind spots and are ignored quietly.
 *
 * Usage:  node parity_check_ast.mjs --oracles records.json --generated ./generated [--bdd]
 *          --bdd scores playwright-bdd step definitions (Given/When/Then) instead of test() blocks;
 *          the oracles file is the same schema either way (the shared extractor emits both).
 */
import { Project, Node } from "ts-morph";
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ORACLES = opt("--oracles", "records.json");
const EMIT = opt("--emit", "");   // when set, write per-test verdicts + headline as JSON
// --bdd: score generated playwright-bdd STEP DEFINITIONS (Given/When/Then) instead of test() blocks.
// Everything else — call following, assertion matching, must-pin scoring, verdicts — is IDENTICAL
// and shared with the TestNG path. The oracles file is the same schema (the same extractor emits it,
// via its --entry-points mode). One gate, two unit kinds.
const BDD = process.argv.includes("--bdd");
// --scope <batch.json>: the slicer's batch manifest. Records for classes that are DEFERRED (a later
// batch) or SKIPPED (deliberately excluded) are reported as DEFERRED and left out of the verdict
// counts and the must-pin denominator. Without this, batching is unusable: migrate 50 of 300 classes
// and the gate reports "no generated test" -> BLOCK for ~200 untouched classes with must-pins,
// burying the handful that matter and showing 50/300 = 17% recovery on a perfect batch.
const SCOPE_FILE = opt("--scope", "");
let SCOPE = null;
if (SCOPE_FILE) {
  try {
    const b = JSON.parse(fs.readFileSync(SCOPE_FILE, "utf8"));
    // Score this batch AND everything earlier batches migrated: the deliverable is ONE growing
    // suite, so each batch re-verifies the whole of it. Only genuinely un-migrated (deferred) and
    // deliberately excluded (skipped) units are left out.
    //
    // TestNG scopes by CLASS; BDD scopes by METHOD. A BDD batch is a set of FEATURES, and one step
    // class can serve several features with different method subsets (UITestSteps: 1 method for one
    // feature, 7 for another) — so a class can be half-migrated and class-level scoping would either
    // skip real work or claim un-migrated methods are done.
    if (b.in_scope_methods) {
      const already = new Set(b.already_migrated_methods || []);
      SCOPE = { methodLevel: true, inScope: new Set([...(b.in_scope_methods || []), ...already]), already,
                skipped: new Map((b.features_skipped || []).map(x => [x.name, x.reason])),
                deferred: new Set(b.deferred_methods || []) };
    } else {
      const already = new Set(b.already_migrated || []);
      SCOPE = { methodLevel: false, inScope: new Set([...(b.in_scope || []), ...already]), already,
                skipped: new Map((b.skipped || []).map(x => [x.name, x.reason])), deferred: new Set(b.deferred || []) };
    }
  } catch (e) { console.error(`could not read --scope ${SCOPE_FILE}: ${e.message}`); process.exit(2); }
}
const classOf = (id) => id.slice(0, id.lastIndexOf("."));
const GENERATED = opt("--generated", "./generated");
const verbose = args.includes("--verbose");
const DEPTH_CAP = 12;

// ---------- token matching (cross-language Java->TS correspondence stays heuristic) ----------
const STOP = new Set("a an the is are be to of and or in on at with for from into as by it its this that actual expected value result get set should must page test assert equals true false null size await async const let return new".split(" "));
const camel = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").toLowerCase().split(" ").filter(Boolean);
const tokens = (s) => new Set(camel(s).filter(w => (w.length > 2 && !STOP.has(w)) || /^\d+$/.test(w)));
const literalWords = (s) => { const o = new Set(); for (const m of s.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/g)) camel(m[1] || m[2] || m[3]).forEach(w => { if (w.length > 2 && !STOP.has(w)) o.add(w); }); return o; };
// Java embeds the OPERATION in the subject (`actualUrl.contains(x)`); TypeScript puts it in the
// MATCHER (`expect(actualUrl).toContain(x)`). Comparing subject/expected alone therefore drops the
// operation on the TS side and a correct translation scores as a LOST must-pin. So: fold the matcher
// name into the generated token set, strip its "to" prefix, and stem trailing plurals so
// contains<->toContain and equals<->toEqual line up. Deliberately conservative — this only ADDS
// tokens; it must not become permissive enough to match an assertion that genuinely lost the intent
// (regression-tested against a translation with the oracle dropped).
const stem = (w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const stemSet = (set) => new Set([...set].map(stem));
// Known cross-language correspondences the token overlap cannot see on its own.
const MATCHER_SYNONYMS = {
  contain: ["contain"], equal: ["equal"], be: ["equal"],
  havetext: ["text", "gettext"], havelength: ["empty", "length", "size"],
  haveurl: ["url", "currenturl"], bevisible: ["displayed", "visible"],
  behidden: ["displayed", "visible"], havecount: ["count", "size"],
  havevalue: ["value"], haveattribute: ["attribute"],
};
function matcherTokens(a) {
  if (!a.matcher) return [];
  const raw = a.matcher.replace(/^(to|not|resolves|rejects)\./i, "").replace(/^to/, "");
  const key = raw.toLowerCase();
  const out = camel(raw).filter(w => w.length > 2 && !STOP.has(w));
  if (MATCHER_SYNONYMS[key]) out.push(...MATCHER_SYNONYMS[key]);
  return out;
}
// An oracle whose subject AND expected are generic local names — Assert.assertEquals(actual,
// expected), Java's most common idiom — produces an EMPTY signature set, because every token is a
// stopword. The required overlap is >=1, so NO assertion can ever match it: the gate reports
// "must-pin LOST" against correct, live code, and flags that same code as an "over-assertion" (the
// tell). Un-stopping "actual"/"expected" would make them meaningful in EVERY suite, loosening
// matching everywhere and risking masked losses. So the gate admits the limit instead: an
// unscoreable oracle is REPORTED (NEEDS-HUMAN), never counted as lost. A gate that says "I cannot
// score this" is honest; one that says "you lost a must-pin" when you did not is lying — and worse,
// it teaches agents to contort correct code to appease it (SauceDemo's run did exactly that).
function isUnscoreable(o) {
  const sig = new Set([...tokens(o.subject), ...tokens(o.expected)]);
  const lit = literalWords(`${o.subject} ${o.expected}`);
  return sig.size === 0 && lit.size === 0;
}
function assnMatchesOracle(a, o) {
  const sig = stemSet(new Set([...tokens(o.subject), ...tokens(o.expected)]));
  const lit = literalWords(`${o.subject} ${o.expected}`);
  const at = stemSet(new Set([...tokens(a.subject), ...tokens(a.expected), ...matcherTokens(a)]));
  const al = literalWords(`${a.subject} ${a.expected}`);
  if (lit.size) { const inter = [...lit].filter(w => al.has(w)); if (inter.length >= Math.max(1, Math.floor(lit.size / 2))) return true; }
  const overlap = [...sig].filter(w => at.has(w)).length;
  return overlap >= Math.max(1, Math.min(2, sig.size));
}

// ---------- expect detection ----------
function isExpectMatcherCall(call) {
  if (!Node.isPropertyAccessExpression(call.getExpression())) return false;
  let e = call.getExpression();
  while (Node.isPropertyAccessExpression(e) || Node.isCallExpression(e)) e = e.getExpression();
  return Node.isIdentifier(e) && e.getText() === "expect";
}
function expectParts(matcherCall) {
  const pa = matcherCall.getExpression();
  const matcher = pa.getName ? pa.getName() : "";
  let inner = pa.getExpression();
  while (Node.isPropertyAccessExpression(inner)) inner = inner.getExpression();
  const subjectNode = Node.isCallExpression(inner) ? inner.getArguments()[0] : undefined;
  const expectedNode = matcherCall.getArguments()[0];
  return { subject: subjectNode ? subjectNode.getText() : "", matcher, expectedNode, expected: expectedNode ? expectedNode.getText() : "" };
}
function isFrozen(a) {
  const n = a.expectedNode; if (!n) return false;
  return Node.isNumericLiteral(n) || Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)
    || (Node.isPrefixUnaryExpression(n) && Node.isNumericLiteral(n.getOperand()));
}

// ---------- callable resolution (in-project only) ----------
function resolveCallable(call) {
  const sym = call.getExpression().getSymbol?.();
  const decls = sym?.getDeclarations?.() ?? [];
  return decls.find(d => !d.getSourceFile().getFilePath().includes("node_modules")
    && (Node.isMethodDeclaration(d) || Node.isFunctionDeclaration(d) || Node.isFunctionExpression(d)
      || Node.isArrowFunction(d) || Node.isMethodSignature(d) || Node.isGetAccessorDeclaration(d)));
}

// ---------- global call graph ----------
const reachedBy = new Map();   // declNode -> Set(testId)   (only methods reached via following)
const stats = { followed: 0, blind: 0, maxDepth: 0 };
const blindList = [];

// walk a body for one test, collecting assertions + populating the call graph
function walk(body, testId, chain, containingDecl, visited, out) {
  if (!body || chain.length > DEPTH_CAP) return;
  stats.maxDepth = Math.max(stats.maxDepth, chain.length);
  body.forEachDescendant(n => {
    if (!Node.isCallExpression(n)) return;
    if (isExpectMatcherCall(n)) {
      const p = expectParts(n);
      out.push({ ...p, file: n.getSourceFile().getBaseName(), line: n.getStartLineNumber(),
        text: n.getText().replace(/\s+/g, " ").slice(0, 80), containing: containingDecl, chain: [...chain] });
      return;
    }
    const decl = resolveCallable(n);
    if (!decl) return;                         // external / std API -> not a blind spot
    if (!reachedBy.has(decl)) reachedBy.set(decl, new Set());
    reachedBy.get(decl).add(testId);
    const bn = decl.getBody?.();
    if (!bn) {                                 // interface / abstract / overload -> can't follow
      stats.blind++; blindList.push(`${decl.getName?.() || "?"} @ ${decl.getSourceFile().getBaseName()} (no body: interface/abstract)`);
      return;
    }
    if (!visited.has(decl)) {
      visited.add(decl); stats.followed++;
      walk(bn, testId, [...chain, decl.getName?.() || "anon"], decl, visited, out);
    }
  });
}

// ---------- @source & test discovery ----------
function getSourceTag(testCall) {
  let stmt = testCall;
  while (stmt && !Node.isExpressionStatement(stmt)) stmt = stmt.getParent();
  for (const r of ((stmt || testCall).getLeadingCommentRanges?.() ?? [])) {
    const m = r.getText().match(/@source:\s*([\w.]+)/); if (m) return m[1];
  }
  return null;
}
const NAV_RE = /\.(goto|navigateTo)$|\.login/;
function detectDataLoopSmell(testBody) {
  let smell = null;
  testBody.forEachDescendant(n => {
    if (smell) return;
    if (Node.isForStatement(n) || Node.isForOfStatement(n) || Node.isForInStatement(n)) {
      const stmt = n.getStatement?.(); let hit = null;
      stmt?.forEachDescendant(m => { if (hit) return;
        if (Node.isNewExpression(m) && /LoginPage/.test(m.getExpression().getText())) hit = m;
        if (Node.isCallExpression(m) && NAV_RE.test(m.getExpression().getText())) hit = m; });
      if (hit) smell = { line: n.getStartLineNumber(), text: n.getText().split("{")[0].replace(/\s+/g, " ").trim().slice(0, 60) };
    }
  });
  return smell;
}

// ---------- load & PASS 1: walk every test ----------
const project = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: false, noEmit: true, skipLibCheck: true } });
project.addSourceFilesAtPaths(`${GENERATED}/**/*.ts`);

const bySource = new Map();
let testCount = 0, untagged = 0;
for (const sf of project.getSourceFiles()) {
  sf.forEachDescendant(n => {
    if (!Node.isCallExpression(n)) return;
    const name = n.getExpression().getText();
    if (BDD) { if (!/^(Given|When|Then|And|But)$/.test(name)) return; }
    else if (name !== "test" && !/^test\.(only|skip|fixme)$/.test(name)) return;
    const cb = n.getArguments().find(a => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
    if (!cb) return;
    testCount++;
    const sid = getSourceTag(n);
    const testId = sid || `UNTAGGED#${testCount}`;
    const body = cb.getBody();
    const asserts = [];
    walk(body, testId, [sid ? sid.split(".").pop() : (BDD ? "step" : "test")], null, new Set(), asserts);  // containing=null => unit body (never shared)
    const smell = detectDataLoopSmell(body);
    if (!sid) { untagged++; return; }
    if (!bySource.has(sid)) bySource.set(sid, { assertions: [], smell: null, tests: 0 });
    const e = bySource.get(sid);
    e.assertions.push(...asserts); e.smell = e.smell || smell; e.tests++;
  });
}

// ---------- PASS 2: mark shared (>=2 distinct tests reach the containing method) & score ----------
const isShared = (a) => a.containing && (reachedBy.get(a.containing)?.size || 0) >= 2;
const records = JSON.parse(fs.readFileSync(ORACLES, "utf8"));
let mpTotal = 0, mpFound = 0, unscoreableTotal = 0;
const verdicts = { PASS: 0, "NEEDS-HUMAN": 0, BLOCK: 0 };
const emitRows = [];   // structured mirror of each printed verdict row, for --emit
const outOfScope = { deferred: [], skipped: [] };
const sharedBucket = new Map();  // "file:line" -> {text, tests:Set, chain}

console.log(`AST parity gate v3 (ts-morph, call-graph)${BDD ? "  [BDD mode — scoring step definitions]" : ""}  ·  ${testCount} ${BDD ? "step definition(s)" : "tests"}, ${untagged} untagged`);
console.log(`Call-following: ${stats.followed} in-project methods followed, max depth ${stats.maxDepth}, ${stats.blind} blind spot(s)\n`);
console.log(`${(BDD ? "source step definition" : "source test").padEnd(46)}${"must-pin".padStart(9)}${(BDD ? "per-step" : "per-test").padStart(9)}  verdict     notes`);
console.log("-".repeat(112));

for (const r of records) {
  // Out of this batch? Report it, don't score it. A deferred class is not a lost oracle.
  if (SCOPE && !SCOPE.inScope.has(SCOPE.methodLevel ? r.id : classOf(r.id))) {
    const cls = classOf(r.id);
    if (SCOPE.skipped.has(cls)) outOfScope.skipped.push({ id: r.id, reason: SCOPE.skipped.get(cls) });
    else outOfScope.deferred.push(r.id);
    continue;
  }
  const mpAll = r.oracles.filter(o => o.recovery === "must_pin");
  const mpUnscoreable = mpAll.filter(isUnscoreable);
  const mp = mpAll.filter(o => !isUnscoreable(o));
  mpTotal += mp.length;
  unscoreableTotal += mpUnscoreable.length;
  const g = bySource.get(r.id);
  const notes = [];
  if (!g) { const v = mp.length ? "BLOCK" : "NEEDS-HUMAN"; verdicts[v]++;
    emitRows.push({ id: r.id, mpFound: 0, mpTotal: mp.length, perTest: null, oracleCount: r.oracle_count, verdict: v, notes: [`no generated ${BDD ? "step definition" : "test"} (check @source tag)`] });
    console.log(`${r.id.padEnd(46)}${("0/" + mp.length).padStart(9)}${"-".padStart(9)}  ${v.padEnd(11)} no generated ${BDD ? "step definition" : "test"} (check @source tag)`); continue; }

  for (const a of g.assertions) a.shared = isShared(a);
  let found = 0, frozen = 0;
  for (const o of mp) { const hit = g.assertions.find(a => assnMatchesOracle(a, o)); if (hit) { found++; if (o.type === "computed" && isFrozen(hit)) frozen++; } }
  mpFound += found;

  const perTest = g.assertions.filter(a => !a.shared);
  const sharedUntraced = g.assertions.filter(a => a.shared && !r.oracles.some(o => assnMatchesOracle(a, o)));
  // An unscoreable oracle can NEVER match any assertion (empty signature set) — so the assertion
  // that faithfully implements it is guaranteed to land here and be billed as an "over-assertion".
  // That is the same finding the unscoreable notice already reports, said twice in contradictory
  // language: "you asserted something the source didn't" is exactly wrong for code that implements
  // a source oracle. Discount one untraceable assertion per unscoreable must-pin. The notice still
  // sends the human to that method, so nothing is hidden.
  const untraceableAll = perTest.filter(a => !r.oracles.some(o => assnMatchesOracle(a, o)));
  const untraceable = mpUnscoreable.length ? untraceableAll.slice(mpUnscoreable.length) : untraceableAll;
  for (const a of sharedUntraced) { const k = `${a.file}:${a.line}`; if (!sharedBucket.has(k)) sharedBucket.set(k, { text: a.text, tests: new Set(), chain: a.chain }); sharedBucket.get(k).tests.add(r.id); }

  let verdict;
  if (mp.length && found < mp.length) { verdict = "BLOCK"; notes.push(`${mp.length - found} must-pin LOST`); }
  else if (frozen) { verdict = "BLOCK"; notes.push(`${frozen} computed frozen to literal`); }
  else if (perTest.length < r.oracle_count) { verdict = "NEEDS-HUMAN"; notes.push(`fewer ${BDD ? "per-step" : "per-test"} asserts (${perTest.length}<${r.oracle_count})`); }
  else verdict = "PASS";

  if (mpUnscoreable.length) {
    notes.push(`${mpUnscoreable.length} unscoreable must-pin (subject/expected are generic names \u2014 gate cannot score it; VERIFY BY EYE)`);
    if (verdict === "PASS") verdict = "NEEDS-HUMAN";
  }
  if (g.smell) { notes.push(`data-row loop w/ navigation @L${g.smell.line} (isolation risk)`); if (verdict === "PASS") verdict = "NEEDS-HUMAN"; }
  if (untraceable.length) { const u = untraceable[0]; notes.push(`${untraceable.length} over-assertion(s) [${u.file}:${u.line} via ${u.chain.join(" \u2192 ")}]`); if (verdict === "PASS") verdict = "NEEDS-HUMAN"; }

  // PHRASING-MISMATCH TELL. A must-pin reported LOST *together with* an unmatched assertion that
  // SHARES TOKENS with it is the signature of a phrasing difference, not a real loss: Java carries
  // the operation in the SUBJECT (`!x.isEmpty()`), TypeScript in the MATCHER (`.not.toHaveLength(0)`).
  // A genuine drop leaves no such assertion behind. We deliberately do NOT loosen the verdict — the
  // gate's worth is that a BLOCK means something, and widening the oracle's token set to cover every
  // enterprise idiom is an endless list that makes matching more permissive EVERYWHERE (a false BLOCK
  // costs one agent iteration; a masked loss ships a broken test). But the gate must not ASSERT a
  // falsehood either: saying "you lost a must-pin" when the code is faithful teaches agents to
  // contort correct code until the grader goes quiet. So: keep the BLOCK, and say what we actually
  // know. NOTE the label is "PHRASING-OR-LOSS", not "AMBIGUOUS": the BDD step-binder already uses
  // AMBIGUOUS for a Gherkin step matching SEVERAL step definitions, which is a hard stop (exit 15).
  // Two meanings for one word in the same agent manual is how an agent mistakes a note for a stop — which is that we CANNOT distinguish these two cases. Verified: `expect(products.length)
  // .toBe(5)` against `!products.isEmpty()` is a genuine loss and produces the identical signature,
  // so the note must present both readings, not lead with the benign one.
  // Fire on ANY oracle the matcher could not align — not just must-pins. The same phrasing gap
  // produces a BLOCK when the oracle is a must-pin and a bare "over-assertion" (NEEDS-HUMAN) when it
  // is a derive; both are the same defect and both deserve the same explanation. Verified: an
  // `isEmpty()` oracle against `.length > 0` code gives the identical token miss either way, and
  // the compoundness of the expression is irrelevant (`!isEmpty(log)` inside the same compound
  // boolean matches fine).
  const unmatchedOracles = r.oracles.filter(o => !isUnscoreable(o) && !perTest.some(a => assnMatchesOracle(a, o)));
  if (unmatchedOracles.length && untraceable.length) {
    const shares = unmatchedOracles.some(o => {
      const sig = stemSet(new Set([...tokens(o.subject), ...tokens(o.expected)]));
      return untraceable.some(a => {
        const at = stemSet(new Set([...tokens(a.subject), ...tokens(a.expected), ...matcherTokens(a)]));
        return [...sig].some(w => at.has(w));
      });
    });
    if (shares) notes.push(`PHRASING-OR-LOSS: the over-assertion shares tokens with an oracle the matcher could not align. The gate CANNOT tell these two apart \u2014 (a) a PHRASING mismatch on faithful code (Java carries the operation in the SUBJECT, \`!x.isEmpty()\`; TS carries it in the MATCHER, \`.not.toHaveLength(0)\`), or (b) a REAL difference where another assertion was written instead (\`expect(x.length).toBe(5)\`). Read the assertion against the source oracle and decide. If faithful, move the operation into the matcher and the gate will score it.`);
  }
  if (sharedUntraced.length) notes.push(`(+${sharedUntraced.length} shared, attributed once)`);

  verdicts[verdict]++;
  emitRows.push({ id: r.id, mpFound: found, mpTotal: mp.length, perTest: perTest.length, oracleCount: r.oracle_count, verdict, notes: [...notes] });
  console.log(`${r.id.padEnd(46)}${(found + "/" + mp.length).padStart(9)}${(perTest.length + "/" + r.oracle_count).padStart(9)}  ${verdict.padEnd(11)} ${notes.join("; ")}`);
}

console.log("-".repeat(112));
const rate = mpTotal ? Math.round((100 * mpFound) / mpTotal) : 100;
console.log(mpTotal === 0
  ? `\nHEADLINE  must-pin recovery: n/a \u2014 no must-pin oracles in scope (nothing external/computed to lose here)`
  : `\nHEADLINE  must-pin recovery: ${mpFound}/${mpTotal} = ${rate}%   (found by following calls to any depth)`);
if (unscoreableTotal) console.log(`          + ${unscoreableTotal} unscoreable must-pin(s) NOT counted above \u2014 generic subject/expected names give the matcher no tokens. Reported, not failed: verify those by eye.`);
console.log(`Verdicts  PASS ${verdicts.PASS} | NEEDS-HUMAN ${verdicts["NEEDS-HUMAN"]} | BLOCK ${verdicts.BLOCK}`);
if (sharedBucket.size) {
  console.log(`\nShared-helper assertions (attributed once, review the METHOD not each test): ${sharedBucket.size} distinct`);
  for (const [loc, v] of sharedBucket) console.log(`   ${loc}  reached by ${v.tests.size} ${BDD ? "step definitions" : "tests"}  ·  ${v.text}`);
}
if (stats.blind && verbose) { console.log(`\nBlind spots (dynamic dispatch / interface — impl not resolved):`); [...new Set(blindList)].forEach(b => console.log(`   ${b}`)); }
if (SCOPE) {
  const scoredN = verdicts.PASS + verdicts["NEEDS-HUMAN"] + verdicts.BLOCK;
  console.log(`\nBatch scope (from ${path.basename(SCOPE_FILE)}): scored ${scoredN} \u00b7 deferred ${outOfScope.deferred.length} \u00b7 skipped ${outOfScope.skipped.length}`);
  if (SCOPE.already.size) console.log(`  Re-verified from earlier batches (the migrated suite is ONE project and is checked as a whole): ${[...SCOPE.already].join(", ")}`);
  if (SCOPE.methodLevel) console.log(`  (BDD: scoped per step-def METHOD — one step class can serve several features with different method subsets.)`);
  if (outOfScope.deferred.length) console.log(`  DEFERRED (not migrated yet \u2014 a later batch): ${[...new Set(outOfScope.deferred.map(x => SCOPE.methodLevel ? x : classOf(x)))].join(", ")}`);
  for (const sk of outOfScope.skipped) console.log(`  SKIPPED  ${sk.id} \u2014 ${sk.reason}`);
  console.log(`  The must-pin recovery above covers everything migrated SO FAR (this batch + earlier batches).`);
}
if (EMIT) {
  const payload = {
    mode: BDD ? "bdd" : "testng",
    headline: { mpFound, mpTotal, rate, unscoreable: unscoreableTotal,
      verdicts: { PASS: verdicts.PASS, "NEEDS-HUMAN": verdicts["NEEDS-HUMAN"], BLOCK: verdicts.BLOCK },
      tests: testCount, untagged, followed: stats.followed, blind: stats.blind, maxDepth: stats.maxDepth },
    tests: emitRows,
    sharedHelpers: [...sharedBucket].map(([loc, v]) => ({ loc, tests: v.tests.size, text: v.text })),
    scope: SCOPE ? { deferred: [...new Set(outOfScope.deferred.map(x => SCOPE.methodLevel ? x : classOf(x)))],
      skipped: outOfScope.skipped.map(s => ({ id: s.id, reason: s.reason })), already: [...SCOPE.already] } : null,
  };
  try { fs.writeFileSync(EMIT, JSON.stringify(payload, null, 2)); console.log(`\n(verdicts written to ${EMIT})`); }
  catch (e) { console.error(`could not write --emit ${EMIT}: ${e.message}`); }
}
console.log(`\nStatic gate only. Dynamic gate (${BDD ? "npx bddgen + " : ""}npx tsc --noEmit + npx playwright test) remains the definitive backstop.`);
