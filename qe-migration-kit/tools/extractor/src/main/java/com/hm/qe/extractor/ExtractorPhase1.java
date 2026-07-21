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
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Phase 1 — assertion detector with DEEP call-following + provenance.
 *
 * For each @Test, walks the call graph (test -> in-test helper -> page object -> util, to any
 * depth, cycle-safe) and collects every assertion, including ones nested inside helper methods
 * that a flat scan misses (e.g. the checkout maths inside verifyCheckoutTotals). Each assertion
 * records its provenance chain. No jars required: assertions are recognised by name and the
 * followed methods resolve from source.
 *
 * Usage:  java -jar qe-extractor.jar <suite-root>
 */
public class ExtractorPhase1 {

    // terminal assertion method names (TestNG Assert.*, custom AssertionUtil.*, soft asserts)
    static final Set<String> ASSERT_NAMES = Set.of(
            "assertEquals", "assertNotEquals", "assertTrue", "assertFalse", "assertNull",
            "assertNotNull", "assertSame", "assertNotSame", "assertArrayEquals", "assertThat", "fail");
    static final int DEPTH_CAP = 15;

    record Assertion(String relation, String subject, String expected, String file, int line, List<String> chain) {}

    public static void main(String[] args) throws Exception {
        if (args.length < 1) { System.err.println("usage: java -jar qe-extractor.jar <suite-root>"); System.exit(2); }
        Path root = Path.of(args[0]);
        Path mainSrc = root.resolve("src/main/java");
        Path testSrc = root.resolve("src/test/java");

        CombinedTypeSolver ts = new CombinedTypeSolver();
        ts.add(new ReflectionTypeSolver());
        if (Files.isDirectory(mainSrc)) ts.add(new JavaParserTypeSolver(mainSrc));
        if (Files.isDirectory(testSrc)) ts.add(new JavaParserTypeSolver(testSrc));
        StaticJavaParser.setConfiguration(new ParserConfiguration().setSymbolResolver(new JavaSymbolSolver(ts)));

        List<Path> testFiles = new ArrayList<>();
        if (Files.isDirectory(testSrc)) {
            try (Stream<Path> walk = Files.walk(testSrc)) {
                walk.filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> p.toString().replace('\\', '/').contains("/tests/"))
                    .forEach(testFiles::add);
            }
        }

        int testCount = 0, totalAsserts = 0, deepAsserts = 0;
        System.out.println("QE Extractor Phase 1  —  assertion detection with deep call-following\n");

        for (Path f : testFiles) {
            CompilationUnit cu = StaticJavaParser.parse(f);
            String cls = cu.getPrimaryTypeName().orElse(f.getFileName().toString());
            for (MethodDeclaration m : cu.findAll(MethodDeclaration.class)) {
                if (m.getAnnotationByName("Test").isEmpty()) continue;
                testCount++;
                List<Assertion> found = new ArrayList<>();
                m.getBody().ifPresent(b -> walk(b, new ArrayList<>(List.of(m.getNameAsString())), new HashSet<>(), found, 0));

                long deep = found.stream().filter(a -> a.chain().size() > 1).count();
                totalAsserts += found.size(); deepAsserts += deep;
                System.out.printf("%s.%s : %d assertion%s%s%n", cls, m.getNameAsString(), found.size(),
                        found.size() == 1 ? "" : "s", deep > 0 ? "  (" + deep + " found deep, via helpers)" : "");
                for (Assertion a : found) {
                    String where = a.chain().size() > 1 ? String.join(" \u2192 ", a.chain()) : "test-body";
                    String flag = a.chain().size() > 1 ? "   \u2190 DEEP" : "";
                    System.out.printf("    [%s] %s: %s %s %s%s%n", where, "assert", trunc(a.subject(), 42),
                            a.relation(), trunc(a.expected(), 42), flag);
                }
            }
        }

        System.out.println("\n------------------------------------------------------------------------------");
        System.out.printf("Phase 1: %d tests, %d assertions total, %d found DEEP (inside helper/page-object methods).%n",
                testCount, totalAsserts, deepAsserts);
        System.out.println("The DEEP ones are exactly what a flat/regex scan misses — e.g. the checkout maths");
        System.out.println("inside verifyCheckoutTotals. Classification (must-pin vs derive) comes in Phase 2.");
    }

    // walk a method body: record assertions here, follow in-project calls deeper
    static void walk(Node body, List<String> chain, Set<String> visited, List<Assertion> out, int depth) {
        if (body == null || depth > DEPTH_CAP) return;
        List<MethodCallExpr> calls = body.findAll(MethodCallExpr.class);
        for (MethodCallExpr call : calls) {
            if (isAssertion(call)) out.add(makeAssertion(call, chain));
        }
        for (MethodCallExpr call : calls) {
            if (isAssertion(call)) continue;
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
            } catch (Exception ignore) { /* external / unresolved -> not followable (honest blind spot) */ }
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
        int line = call.getBegin().map(p -> p.line).orElse(-1);
        String file = call.findCompilationUnit().flatMap(CompilationUnit::getStorage)
                .map(s -> s.getFileName()).orElse("?");
        return new Assertion(relation, subject, expected, file, line, new ArrayList<>(chain));
    }

    static String trunc(String s, int n) { s = s.replaceAll("\\s+", " "); return s.length() <= n ? s : s.substring(0, n) + "\u2026"; }
}
