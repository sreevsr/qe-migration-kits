#!/usr/bin/env node
/**
 * di-resolver.mjs — detect the Cucumber DI/state-sharing pattern and emit a Playwright FIXTURE PLAN.
 * Deterministic, no LLM.
 *
 *   node di-resolver.mjs --repo <suite-root> [--out fixture-plan.json]
 *
 * Recognizes the common PicoContainer/constructor-DI shape:
 *   TestContext          -> holds the managers; injected into every step class ctor
 *   PageObjectManager    -> lazy-singleton getX() factories  -> one fixture per page object
 *   ScenarioContext      -> between-steps K/V bag            -> a state fixture
 *   DriverManager/WebDriver -> Playwright's built-in `page` fixture (free)
 *
 * Emits a plan the agent implements ONCE as fixtures.ts. Anything it cannot recognize is reported
 * as `unsupported` (never guessed) — e.g. Spring/Guice DI.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function findJavaFiles(root) {
  const out = [];
  (function walk(d) {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!["target", "node_modules", ".git", "build"].includes(e.name)) walk(p); }
      else if (e.name.endsWith(".java")) out.push(p);
    }
  })(root);
  return out;
}

const rel = (root, f) => path.relative(root, f).replace(/\\/g, "/");

/** PageObjectManager: public XxxPage getXxxPage() { return (x==null)? x = new XxxPage(driver) : x; } */
function parsePageObjectManager(src) {
  const factories = [];
  const re = /public\s+(\w+)\s+(get\w+)\s*\(\s*\)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const [, type, method, body] = m;
    const lazy = /==\s*null/.test(body) && /new\s+\w+\s*\(/.test(body);
    factories.push({ page_object: type, factory: method, lazy_singleton: lazy });
  }
  return factories;
}

/** ScenarioContext: a K/V bag — setContext/getContext/isContains over a Map/HashMap */
function looksLikeScenarioContext(src) {
  return /(HashMap|Map)\s*</.test(src) && /(setContext|getContext|isContains)/.test(src);
}

/** step classes that take the context by constructor injection */
function findInjectedStepClasses(files, root, contextClass) {
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const cls = (src.match(/class\s+(\w+)/) || [])[1];
    if (!cls) continue;
    const ctor = new RegExp(`public\\s+${cls}\\s*\\(\\s*${contextClass}\\s+\\w+\\s*\\)`);
    if (ctor.test(src)) {
      const uses = [...src.matchAll(/getPageObjectManager\(\)\.(get\w+)\(\)/g)].map(x => x[1]);
      hits.push({ class: cls, file: rel(root, f), pulls: [...new Set(uses)] });
    }
  }
  return hits;
}


/** Style B: a static ThreadLocal<WebDriver> factory (DriverFactory.getDriver()) — very common. */
function looksLikeStaticDriverFactory(src) {
  const threadLocal = /static\s+ThreadLocal\s*<\s*WebDriver\s*>/.test(src);
  const staticGetter = /public\s+static\s+WebDriver\s+getDriver\s*\(/.test(src);
  return threadLocal || staticGetter;
}

/** Style B: step classes instantiate pages directly -> new DemoPage(DriverFactory.getDriver()) */
function findDirectPageInstantiations(files, root) {
  const byClass = [];
  const types = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const cls = (src.match(/class\s+(\w+)/) || [])[1];
    if (!cls) continue;
    if (!/@(Given|When|Then)\s*\(/.test(src)) continue;          // step classes only
    const news = [...src.matchAll(/new\s+(\w*Page)\s*\(/g)].map(m => m[1]);
    const direct = /(\w+)\.getDriver\s*\(\s*\)\s*\./.test(src);  // e.g. DriverFactory.getDriver().getTitle()
    if (news.length || direct) {
      const uniq = [...new Set(news)];
      uniq.forEach(t => types.add(t));
      byClass.push({ class: cls, file: rel(root, f), instantiates: uniq, uses_driver_directly: direct });
    }
  }
  return { byClass, types: [...types] };
}

function resolve(root) {
  const files = findJavaFiles(root);
  const plan = {
    di_style: null, context_class: null, page_objects: [], scenario_context: false,
    driver: null, injected_step_classes: [], direct_page_step_classes: [], hooks: [],
    unsupported: [], fixtures: [], notes: []
  };

  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const cls = (src.match(/class\s+(\w+)/) || [])[1];
    if (!cls) continue;

    if (/Spring|@Autowired|Guice|@Inject/.test(src)) {
      plan.unsupported.push({ class: cls, file: rel(root, f), reason: "Spring/Guice DI — resolver supports PicoContainer/constructor-DI only" });
    }
    if (/class\s+PageObjectManager/.test(src)) {
      plan.page_objects = parsePageObjectManager(src);
    }
    if (/class\s+ScenarioContext/.test(src) && looksLikeScenarioContext(src)) {
      plan.scenario_context = true;
    }
    if (/class\s+DriverManager/.test(src) || /WebDriver\s+getDriver\s*\(/.test(src)) {
      plan.driver = { java: cls, maps_to: "page (Playwright built-in fixture)" };
      if (looksLikeStaticDriverFactory(src)) plan.driver.style = "static ThreadLocal factory";
    }
    if (/class\s+TestContext/.test(src) || (/getPageObjectManager\s*\(/.test(src) && /class\s+\w*Context/.test(src))) {
      plan.context_class = cls;
      plan.di_style = "constructor-DI (PicoContainer-style TestContext)";
    }
    // cucumber hooks
    if (/@(Before|After)\s*(\(|\s)/.test(src)) {
      const tagged = [...src.matchAll(/@(Before|After)\s*\(\s*["']([^"']+)["']\s*\)/g)].map(x => ({ type: x[1], tag: x[2] }));
      const plain = /@(Before|After)\s*\n/.test(src) || /@(Before|After)\s*$/m.test(src);
      const lifecycle = /(initDriver|quitDriver|closeDriver|driver\.quit|new\s+ChromeDriver)/.test(src);
      const screenshot = /(TakesScreenshot|getScreenshotAs|scenario\.attach)/.test(src);
      plan.hooks.push({
        id: rel(root, f), class: cls, file: rel(root, f), tagged, has_untagged: plain,
        driver_lifecycle: lifecycle, screenshot_on_failure: screenshot,
        maps_to: lifecycle
          ? "DELETE — Playwright owns the browser lifecycle"
          : (screenshot ? "DELETE — use screenshot: 'only-on-failure' in playwright.config.ts" : "translate to a fixture / beforeEach-afterEach")
      });
    }
  }

  if (plan.context_class) plan.injected_step_classes = findInjectedStepClasses(files, root, plan.context_class);

  // ---- Style B: no TestContext/PageObjectManager; a static ThreadLocal driver + direct `new XxxPage(...)`
  if (!plan.context_class) {
    const direct = findDirectPageInstantiations(files, root);
    if (direct.types.length || (plan.driver && plan.driver.style)) {
      plan.di_style = "static-driver-factory + direct page instantiation";
      plan.direct_page_step_classes = direct.byClass;
      plan.page_objects = direct.types.map(t => ({ page_object: t, factory: null, lazy_singleton: false }));
      if (direct.byClass.some(c => c.uses_driver_directly))
        plan.notes.push("Some step classes call getDriver() directly (e.g. getDriver().getTitle()) -> translate to direct `page.` calls.");
    }
  }

  // ---- build the fixture plan the agent implements as fixtures.ts ----
  for (const po of plan.page_objects) {
    const name = po.page_object.charAt(0).toLowerCase() + po.page_object.slice(1);
    plan.fixtures.push({
      fixture: name, type: po.page_object,
      from: po.factory ? `PageObjectManager.${po.factory}()` : `new ${po.page_object}(driver) in step classes`,
      impl: `${name}: async ({ page }, use) => { await use(new ${po.page_object}(page)); }`
    });
  }
  if (plan.scenario_context) {
    plan.fixtures.push({
      fixture: "scenarioContext", type: "ScenarioContext", from: "ScenarioContext (between-steps K/V)",
      impl: "scenarioContext: async ({}, use) => { await use(new ScenarioContext()); }"
    });
  }
  if (plan.driver) {
    plan.fixtures.push({
      fixture: "page", type: "Page", from: `${plan.driver.java} / WebDriver`,
      impl: "(built-in — Playwright provides one `page` per scenario; no fixture needed)"
    });
  }
  return plan;
}

// ---- CLI ---- (guarded so the module can be imported without executing/exiting)
function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const repo = opt("--repo", ""), outPath = opt("--out", "");
  if (!repo) { console.error("usage: node di-resolver.mjs --repo <suite-root> [--out fixture-plan.json]"); process.exit(2); }

  const plan = resolve(path.resolve(repo));
  const json = JSON.stringify(plan, null, 2);
  if (outPath) fs.writeFileSync(outPath, json);
  console.error(
    `di-resolver: ${plan.di_style || "NO DI PATTERN DETECTED"}` +
    ` · context=${plan.context_class || "-"}` +
    ` · page-object fixtures=${plan.page_objects.length}` +
    ` · scenarioContext=${plan.scenario_context}` +
    ` · injected step classes=${plan.injected_step_classes.length}` +
    ` · hooks=${plan.hooks.length}` +
    (plan.unsupported.length ? ` · UNSUPPORTED=${plan.unsupported.length}` : "")
  );
  if (!outPath) console.log(json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { resolve, parsePageObjectManager };
