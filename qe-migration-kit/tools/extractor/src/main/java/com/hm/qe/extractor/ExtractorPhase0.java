package com.hm.qe.extractor;

// =============================================================================================
// SUPERSEDED — NOT THE SHIPPING CLASSIFIER. The pom's <mainClass> is ExtractorPhase4; this class
// is kept for history and is never executed. Changing it has NO effect, and a baseline will still
// pass — because nothing ran. If you are here to fix classification, go to ExtractorPhase4.java.
// =============================================================================================

import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.ArrayInitializerExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.MemberValuePair;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * Phase 0 of the production extractor.
 * Proves the toolchain: sets up cross-file symbol resolution, lists every @Test method
 * with its tags/description/dataProvider, and demonstrates that a call inside the test
 * resolves to its declaration (cross-file). No oracle extraction yet -- that's Phase 1.
 *
 * Usage:  java -jar qe-extractor.jar <suite-root>
 *   where <suite-root> contains src/main/java and src/test/java
 */
public class ExtractorPhase0 {

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: java -jar qe-extractor.jar <suite-root>");
            System.exit(2);
        }
        Path root = Path.of(args[0]);
        Path mainSrc = root.resolve("src/main/java");
        Path testSrc = root.resolve("src/test/java");

        // ---- type solver: JDK reflection + the suite's own source roots (cross-file) ----
        CombinedTypeSolver ts = new CombinedTypeSolver();
        ts.add(new ReflectionTypeSolver());
        if (Files.isDirectory(mainSrc)) ts.add(new JavaParserTypeSolver(mainSrc));
        if (Files.isDirectory(testSrc)) ts.add(new JavaParserTypeSolver(testSrc));
        StaticJavaParser.setConfiguration(
                new ParserConfiguration().setSymbolResolver(new JavaSymbolSolver(ts)));

        // ---- collect the test .java files ----
        List<Path> testFiles = new ArrayList<>();
        if (Files.isDirectory(testSrc)) {
            try (Stream<Path> walk = Files.walk(testSrc)) {
                walk.filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> p.toString().replace('\\', '/').contains("/tests/"))
                    .forEach(testFiles::add);
            }
        }

        int testCount = 0, resolved = 0, unresolved = 0;
        System.out.println("QE Extractor Phase 0  (JavaParser + SymbolSolver)");
        System.out.println("suite: " + root.toAbsolutePath());
        System.out.println("------------------------------------------------------------------------------");

        for (Path f : testFiles) {
            CompilationUnit cu = StaticJavaParser.parse(f);
            String cls = cu.getPrimaryTypeName().orElse(f.getFileName().toString());
            for (MethodDeclaration m : cu.findAll(MethodDeclaration.class)) {
                Optional<AnnotationExpr> testAnn = m.getAnnotationByName("Test");
                if (testAnn.isEmpty()) continue;
                testCount++;

                String tags = joinGroups(testAnn.get());
                String desc = stringMember(testAnn.get(), "description");
                String dp   = stringMember(testAnn.get(), "dataProvider");

                System.out.printf("%-52s tags=[%s]%s%s%n",
                        cls + "." + m.getNameAsString(),
                        tags,
                        dp.isEmpty() ? "" : "  dataProvider=" + dp,
                        desc.isEmpty() ? "" : "  \"" + trim(desc, 40) + "\"");

                // ---- prove cross-file resolution on the first call in the test body ----
                Optional<MethodCallExpr> firstCall = m.getBody()
                        .flatMap(b -> b.findFirst(MethodCallExpr.class));
                if (firstCall.isPresent()) {
                    try {
                        ResolvedMethodDeclaration rmd = firstCall.get().resolve();
                        resolved++;
                        System.out.printf("      \u21b3 resolved '%s(...)' -> %s%n",
                                firstCall.get().getNameAsString(), rmd.getQualifiedSignature());
                    } catch (Exception e) {
                        unresolved++;
                        System.out.printf("      \u21b3 could not resolve '%s(...)' (%s) -- likely needs a dependency jar (TestNG/Selenium)%n",
                                firstCall.get().getNameAsString(), e.getClass().getSimpleName());
                    }
                }
            }
        }

        System.out.println("------------------------------------------------------------------------------");
        System.out.printf("Phase 0: %d @Test methods; first-call resolution: %d resolved, %d unresolved.%n",
                testCount, resolved, unresolved);
        System.out.println("(Unresolved first-calls are usually external APIs. Project-internal calls -- page");
        System.out.println(" objects, helpers -- resolving is the proof that cross-file symbol resolution works.)");
    }

    // @Test(groups = {"a","b"}) -> "a, b"
    private static String joinGroups(AnnotationExpr ann) {
        if (!(ann instanceof NormalAnnotationExpr n)) return "";
        for (MemberValuePair p : n.getPairs()) {
            if (!p.getNameAsString().equals("groups")) continue;
            Expression v = p.getValue();
            List<String> out = new ArrayList<>();
            if (v instanceof ArrayInitializerExpr arr) {
                for (Expression e : arr.getValues())
                    if (e instanceof StringLiteralExpr s) out.add(s.getValue());
            } else if (v instanceof StringLiteralExpr s) {
                out.add(s.getValue());
            }
            return String.join(", ", out);
        }
        return "";
    }

    // @Test(description = "x") / @Test(dataProvider = "y") -> the string
    private static String stringMember(AnnotationExpr ann, String member) {
        if (!(ann instanceof NormalAnnotationExpr n)) return "";
        for (MemberValuePair p : n.getPairs())
            if (p.getNameAsString().equals(member) && p.getValue() instanceof StringLiteralExpr s)
                return s.getValue();
        return "";
    }

    private static String trim(String s, int n) { return s.length() <= n ? s : s.substring(0, n) + "\u2026"; }
}
