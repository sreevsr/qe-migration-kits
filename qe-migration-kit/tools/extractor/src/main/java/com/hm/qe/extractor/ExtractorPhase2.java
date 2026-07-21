package com.hm.qe.extractor;

// =============================================================================================
// SUPERSEDED — NOT THE SHIPPING CLASSIFIER. The pom's <mainClass> is ExtractorPhase4; this class
// is kept for history and is never executed. Changing it has NO effect, and a baseline will still
// pass — because nothing ran. If you are here to fix classification, go to ExtractorPhase4.java.
// =============================================================================================

import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.BinaryExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ClassLoaderTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;

import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Phase 2 — type-driven classification.
 * Wires the suite's real dependency jars (from `mvn dependency:build-classpath`) into the type
 * solver, then classifies each assertion by RESOLVED TYPE:
 *   external  (JsonNode / Response / config-&-data readers)         -> must_pin
 *   computed  (BigDecimal arithmetic / collection-order verification)-> must_pin
 *   ui_literal(compared against a string/number literal)            -> planner_can_derive
 *   ui_state  (boolean / observable count, default)                 -> planner_can_derive
 * Also fixes the soft-assertion noise Phase 1 surfaced (assertAll is a flush, not a check).
 *
 * Usage:  java -jar qe-extractor.jar <suite-root> [<classpath-file>]
 */
public class ExtractorPhase2 {

    static final Set<String> ASSERT_NAMES = Set.of(
            "assertEquals", "assertNotEquals", "assertTrue", "assertFalse", "assertNull",
            "assertNotNull", "assertSame", "assertNotSame", "assertArrayEquals", "assertThat", "fail");
    static final Set<String> FOLLOW_SKIP = Set.of("assertAll"); // soft-assert flush; not a check
    static final int DEPTH_CAP = 15;

    record Assertion(MethodCallExpr call, String relation, String subject, String expected, List<String> chain) {}

    public static void main(String[] args) throws Exception {
        if (args.length < 1) { System.err.println("usage: java -jar qe-extractor.jar <suite-root> [classpath-file]"); System.exit(2); }
        Path root = Path.of(args[0]);
        Path mainSrc = root.resolve("src/main/java");
        Path testSrc = root.resolve("src/test/java");

        CombinedTypeSolver ts = new CombinedTypeSolver();
        if (Files.isDirectory(mainSrc)) ts.add(new JavaParserTypeSolver(mainSrc));
        if (Files.isDirectory(testSrc)) ts.add(new JavaParserTypeSolver(testSrc));
        int jars = 0;
        if (args.length >= 2) {
            List<URL> urls = new ArrayList<>();
            String cp = Files.readString(Path.of(args[1])).trim();
            for (String entry : cp.split(";")) {                    // Windows classpath separator
                entry = entry.trim();
                if (entry.isEmpty()) continue;
                File jf = new File(entry);
                if (jf.exists()) { urls.add(jf.toURI().toURL()); jars++; }
            }
            if (!urls.isEmpty()) {
                URLClassLoader depsCl = new URLClassLoader(urls.toArray(new URL[0]), ExtractorPhase2.class.getClassLoader());
                ts.add(new ClassLoaderTypeSolver(depsCl));
            }
        }
        ts.add(new ReflectionTypeSolver());
        StaticJavaParser.setConfiguration(new ParserConfiguration().setSymbolResolver(new JavaSymbolSolver(ts)));

        List<Path> testFiles = new ArrayList<>();
        if (Files.isDirectory(testSrc)) {
            try (Stream<Path> walk = Files.walk(testSrc)) {
                walk.filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> p.toString().replace('\\', '/').contains("/tests/"))
                    .forEach(testFiles::add);
            }
        }

        int tests = 0, total = 0, mustPin = 0;
        int cExternal = 0, cComputed = 0, cLiteral = 0, cState = 0;
        System.out.println("QE Extractor Phase 2  —  type-driven classification");
        System.out.printf("dependency jars wired into type solver: %d%s%n%n", jars, jars == 0 ? "  (WARN: no classpath file given -> name-based fallback)" : "");

        for (Path f : testFiles) {
            CompilationUnit cu = StaticJavaParser.parse(f);
            String cls = cu.getPrimaryTypeName().orElse(f.getFileName().toString());
            for (MethodDeclaration m : cu.findAll(MethodDeclaration.class)) {
                if (m.getAnnotationByName("Test").isEmpty()) continue;
                tests++;
                List<Assertion> found = new ArrayList<>();
                m.getBody().ifPresent(b -> walk(b, new ArrayList<>(List.of(m.getNameAsString())), new HashSet<>(), found, 0));

                System.out.printf("%s.%s%n", cls, m.getNameAsString());
                for (Assertion a : found) {
                    String type = classify(a.call(), a.relation(), m);
                    String recovery = (type.equals("computed") || type.equals("external")) ? "must_pin" : "planner_can_derive";
                    total++;
                    if (recovery.equals("must_pin")) mustPin++;
                    switch (type) { case "external" -> cExternal++; case "computed" -> cComputed++; case "ui_literal" -> cLiteral++; default -> cState++; }
                    String depth = a.chain().size() > 1 ? "  {" + String.join("\u2192", a.chain().subList(1, a.chain().size())) + "}" : "";
                    System.out.printf("    %-9s %-18s %s %s %s%s%n",
                            recovery.equals("must_pin") ? "MUST-PIN" : "derive",
                            "[" + type + "]", trunc(a.subject(), 34), a.relation(), trunc(a.expected(), 30), depth);
                }
            }
        }

        System.out.println("\n------------------------------------------------------------------------------");
        System.out.printf("Phase 2: %d tests, %d assertions, %d MUST-PIN.%n", tests, total, mustPin);
        System.out.printf("By type:  external=%d  computed=%d  |  ui_literal=%d  ui_state=%d%n", cExternal, cComputed, cLiteral, cState);
        System.out.println("(external + computed = must_pin; ui_literal + ui_state = planner_can_derive)");
    }

    // ---------- classification (precedence: external > computed > ui_literal > ui_state) ----------
    static String classify(MethodCallExpr call, String relation, MethodDeclaration enclosingTest) {
        List<Expression> as = call.getArguments();
        Expression subj = as.size() > 0 ? as.get(0) : null;
        Expression exp  = as.size() > 1 ? as.get(1) : null;

        // 1. EXTERNAL: expected value from an I/O source (API, config) or a data-provider-supplied list
        if (isExternalSource(subj) || isExternalSource(exp)) return "external";
        if (isDataDriven(subj, enclosingTest) || isDataDriven(exp, enclosingTest)) return "external";

        // 2. COMPUTED: arithmetic, or an expectation derived by transformation (sorted/reduce/"expected*")
        if (isArithmetic(subj) || isArithmetic(exp) || isDerived(subj) || isDerived(exp)) return "computed";

        // 3. UI_LITERAL: compared against a STRING literal on the EXPECTED side (text check)
        if (isUiLiteral(relation, subj, exp)) return "ui_literal";

        // 4. UI_STATE: booleans, visibility, observable counts (default)
        return "ui_state";
    }

    // Jackson / RestAssured Response, and the suite's config/data readers, referenced in the expression
    static boolean isExternalSource(Expression e) {
        if (e == null) return false;
        if (e.toString().matches("(?s).*(EnvironmentDataReader|ConfigReader\\.get|TestDataReader|RandomData|response\\.status|\\bbody\\.).*")) return true;
        for (MethodCallExpr c : e.findAll(MethodCallExpr.class)) {
            String t = resolvedScopeType(c);
            if (t.contains("JsonNode") || t.contains("fasterxml.jackson") || t.endsWith(".Response") || t.contains("restassured")) return true;
        }
        return false;
    }

    // expected value is a CONTENT parameter supplied by this test's @DataProvider (not app-derivable)
    static boolean isDataDriven(Expression e, MethodDeclaration test) {
        if (e == null || test == null || !(e instanceof com.github.javaparser.ast.expr.NameExpr ne)) return false;
        boolean hasDP = test.getAnnotationByName("Test").map(a -> a.toString().contains("dataProvider")).orElse(false);
        if (!hasDP) return false;
        for (com.github.javaparser.ast.body.Parameter p : test.getParameters()) {
            if (!p.getNameAsString().equals(ne.getNameAsString())) continue;
            String t = p.getTypeAsString();                // content types only, not numeric counts
            return t.contains("List") || t.contains("[]") || t.contains("Collection") || t.contains("Map") || t.contains("String");
        }
        return false;
    }

    static boolean isArithmetic(Expression e) {
        if (e == null) return false;
        if (e instanceof BinaryExpr be) {
            BinaryExpr.Operator op = be.getOperator();
            if (op == BinaryExpr.Operator.PLUS || op == BinaryExpr.Operator.MINUS
                    || op == BinaryExpr.Operator.MULTIPLY || op == BinaryExpr.Operator.DIVIDE) return true;
        }
        for (MethodCallExpr c : e.findAll(MethodCallExpr.class)) {
            String n = c.getNameAsString();
            if (n.equals("add") || n.equals("subtract") || n.equals("multiply") || n.equals("divide")) return true;
        }
        return false;
    }

    // an expectation produced by a transformation: a sorted/reduced copy, or a var named expected*/sorted*
    static boolean isDerived(Expression e) {
        if (e == null) return false;
        for (MethodCallExpr c : e.findAll(MethodCallExpr.class)) {
            String n = c.getNameAsString();
            if (n.equals("sorted") || n.equals("reduce") || n.equals("sort")) return true;
        }
        return e instanceof com.github.javaparser.ast.expr.NameExpr n && n.getNameAsString().matches("(?i)(expected|sorted).*");
    }

    // ui_literal ONLY when the EXPECTED value is a string literal, or a text predicate on the subject
    static boolean isUiLiteral(String relation, Expression subj, Expression exp) {
        if (relation.equals("equals") && exp instanceof StringLiteralExpr) return true;
        if ((relation.equals("is_true") || relation.equals("is_false")) && subj != null) {
            for (MethodCallExpr c : subj.findAll(MethodCallExpr.class)) {
                String n = c.getNameAsString();
                if ((n.equals("contains") || n.equals("matches") || n.equals("equals") || n.equals("equalsIgnoreCase")
                        || n.equals("startsWith") || n.equals("endsWith"))
                        && c.getArguments().stream().anyMatch(a -> a instanceof StringLiteralExpr)) return true;
            }
        }
        return false;
    }

    static String resolvedScopeType(MethodCallExpr c) {
        try {
            if (c.getScope().isPresent()) return c.getScope().get().calculateResolvedType().describe();
        } catch (Exception ignore) {}
        return "";
    }

    // ---------- walk (same deep call-following as Phase 1, minus the assertAll flush) ----------
    static void walk(Node body, List<String> chain, Set<String> visited, List<Assertion> out, int depth) {
        if (body == null || depth > DEPTH_CAP) return;
        List<MethodCallExpr> calls = body.findAll(MethodCallExpr.class);
        for (MethodCallExpr call : calls)
            if (isAssertion(call)) out.add(makeAssertion(call, chain));
        for (MethodCallExpr call : calls) {
            if (isAssertion(call) || FOLLOW_SKIP.contains(call.getNameAsString())) continue;
            try {
                ResolvedMethodDeclaration rmd = call.resolve();
                String sig = rmd.getQualifiedSignature();
                if (visited.contains(sig)) continue;
                Optional<Node> ast = rmd.toAst();
                if (ast.isPresent() && ast.get() instanceof MethodDeclaration md && md.getBody().isPresent()) {
                    visited.add(sig);
                    List<String> child = new ArrayList<>(chain);
                    child.add(md.getNameAsString());
                    walk(md.getBody().get(), child, visited, out, depth + 1);
                }
            } catch (Exception ignore) { /* external/unresolved -> not followable */ }
        }
    }

    static boolean isAssertion(MethodCallExpr call) { return ASSERT_NAMES.contains(call.getNameAsString()); }

    static Assertion makeAssertion(MethodCallExpr call, List<String> chain) {
        String name = call.getNameAsString();
        List<Expression> as = call.getArguments();
        String subject = as.size() > 0 ? as.get(0).toString() : "";
        String expected, relation;
        switch (name) {
            case "assertTrue"    -> { expected = "true";  relation = "is_true"; }
            case "assertFalse"   -> { expected = "false"; relation = "is_false"; }
            case "assertNotNull" -> { expected = "notNull"; relation = "not_null"; }
            case "assertNull"    -> { expected = "null"; relation = "is_null"; }
            case "fail"          -> { subject = ""; expected = ""; relation = "fail"; }
            case "assertThat"    -> { expected = as.size() > 1 ? as.get(1).toString() : ""; relation = "that"; }
            default              -> { expected = as.size() > 1 ? as.get(1).toString() : ""; relation = "equals"; }
        }
        return new Assertion(call, relation, subject, expected, new ArrayList<>(chain));
    }

    static String trunc(String s, int n) { s = s.replaceAll("\\s+", " "); return s.length() <= n ? s : s.substring(0, n) + "\u2026"; }
}
