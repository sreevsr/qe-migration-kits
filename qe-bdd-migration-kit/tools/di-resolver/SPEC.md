# di-resolver — SPEC (NEW, deterministic)
Input: the suite's manager/context .java files (TestContext, PageObjectManager, ScenarioContext,
DriverManager) + step-def constructors.
Output: a fixture plan: { page_objects:[HomePage, CartPage, ...] (from PageObjectManager.getX()),
scenario_context: true/false, driver: "page", hooks:[...] }.
How: detect the PicoContainer/constructor-DI pattern; enumerate PageObjectManager.getX() factory
methods -> one fixture each; detect ScenarioContext -> state fixture. Emit into pack 00 so the agent
builds fixtures.ts once.
Boundary: PicoContainer/constructor-DI only; Spring/Guice -> flag as unsupported (REVIEW).
No LLM.

## Two DI styles (validated on real suites)
- **Style A — PicoContainer constructor-DI** (saipradeepcs): TestContext + PageObjectManager.getX()
  lazy singletons + ScenarioContext -> a fixture per page object, a scenarioContext fixture, `page`.
- **Style B — static ThreadLocal driver factory** (colleague's CucumberSeleniumFramework): no
  context object; `DriverFactory.getDriver()` + `new XxxPage(...)` in step classes -> a fixture per
  distinct page type + the built-in `page`. Driver-lifecycle hooks are DELETED (Playwright owns the
  lifecycle); screenshot-on-failure hooks -> playwright.config `screenshot: 'only-on-failure'`.
Spring/Guice -> reported as `unsupported`, never guessed.
Hooks are keyed by FILE (two classes can share a simple name across packages — seen in the wild).
