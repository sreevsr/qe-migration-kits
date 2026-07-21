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
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.ReturnStmt;
import com.github.javaparser.resolution.declarations.ResolvedMethodDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedValueDeclaration;
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
import java.util.*;
import java.util.stream.Stream;

/**
 * Phase 3 — ORIGIN-TRACING classifier.
 * One mechanism classifies every assertion by tracing where its value comes from:
 *   LITERAL   -> ui_literal   (derive)
 *   APP_READ  -> ui_state     (derive)
 *   EXTERNAL  -> external     (must_pin)   [data file / API / config]
 *   COMPUTED  -> computed     (must_pin)   [ANY calculation, followed into custom methods]
 *   UNKNOWN   -> REVIEW        (fail-safe: never silently derive an unresolved value)
 *
 * Usage:  java -jar qe-extractor.jar <suite-root> [<classpath-file>]
 */
public class ExtractorPhase3 {

    static final Set<String> ASSERT_NAMES = Set.of(
            "assertEquals", "assertNotEquals", "assertTrue", "assertFalse", "assertNull",
            "assertNotNull", "assertSame", "assertNotSame", "assertArrayEquals", "assertThat", "fail");
    static final Set<String> FOLLOW_SKIP = Set.of("assertAll");
    static final int WALK_DEPTH = 15, TRACE_DEPTH = 8;

    enum Origin { EXTERNAL, COMPUTED, APP_READ, LITERAL, UNKNOWN }

    record Assertion(MethodCallExpr call, String relation, String subject, String expected, List<String> chain, MethodDeclaration test) {}

    public static void main(String[] args) throws Exception {
        if (args.length < 1) { System.err.println("usage: java -jar qe-extractor.jar <suite-root> [classpath-file]"); System.exit(2); }
        Path root = Path.of(args[0]);
        Path mainSrc = root.resolve("src/main/java"), testSrc = root.resolve("src/test/java");

        CombinedTypeSolver ts = new CombinedTypeSolver();
        if (Files.isDirectory(mainSrc)) ts.add(new JavaParserTypeSolver(mainSrc));
        if (Files.isDirectory(testSrc)) ts.add(new JavaParserTypeSolver(testSrc));
        int jars = 0;
        if (args.length >= 2) {
            List<URL> urls = new ArrayList<>();
            for (String entry : Files.readString(Path.of(args[1])).trim().split(";")) {
                entry = entry.trim();
                if (entry.isEmpty()) continue;
                File jf = new File(entry);
                if (jf.exists()) { urls.add(jf.toURI().toURL()); jars++; }
            }
            if (!urls.isEmpty()) ts.add(new ClassLoaderTypeSolver(new URLClassLoader(urls.toArray(new URL[0]), ExtractorPhase3.class.getClassLoader())));
        }
        ts.add(new ReflectionTypeSolver());
        StaticJavaParser.setConfiguration(new ParserConfiguration().setSymbolResolver(new JavaSymbolSolver(ts)));

        List<Path> testFiles = new ArrayList<>();
        if (Files.isDirectory(testSrc)) try (Stream<Path> w = Files.walk(testSrc)) {
            w.filter(p -> p.toString().endsWith(".java")).filter(p -> p.toString().replace('\\', '/').contains("/tests/")).forEach(testFiles::add);
        }

        int tests = 0, total = 0, mustPin = 0, review = 0;
        Map<Origin, Integer> byOrigin = new EnumMap<>(Origin.class);
        System.out.println("QE Extractor Phase 3  —  origin-tracing classification");
        System.out.printf("dependency jars: %d%s%n%n", jars, jars == 0 ? "  (WARN: no classpath -> resolution degraded)" : "");

        for (Path f : testFiles) {
            CompilationUnit cu = StaticJavaParser.parse(f);
            String cls = cu.getPrimaryTypeName().orElse(f.getFileName().toString());
            for (MethodDeclaration m : cu.findAll(MethodDeclaration.class)) {
                if (m.getAnnotationByName("Test").isEmpty()) continue;
                tests++;
                List<Assertion> found = new ArrayList<>();
                m.getBody().ifPresent(b -> walk(b, new ArrayList<>(List.of(m.getNameAsString())), new HashSet<>(), found, 0, m));
                System.out.printf("%s.%s%n", cls, m.getNameAsString());
                for (Assertion a : found) {
                    Origin o = classifyOrigin(a);
                    byOrigin.merge(o, 1, Integer::sum);
                    String type = switch (o) { case EXTERNAL -> "external"; case COMPUTED -> "computed"; case LITERAL -> "ui_literal"; case APP_READ -> "ui_state"; default -> "unknown"; };
                    String disp = (o == Origin.EXTERNAL || o == Origin.COMPUTED) ? "MUST-PIN" : (o == Origin.UNKNOWN ? "REVIEW" : "derive");
                    total++;
                    if (disp.equals("MUST-PIN")) mustPin++; else if (disp.equals("REVIEW")) review++;
                    String prov = a.chain().size() > 1 ? "  {" + String.join("\u2192", a.chain().subList(1, a.chain().size())) + "}" : "";
                    System.out.printf("    %-8s [%-10s] %s %s %s%s%n", disp, type, trunc(a.subject(), 32), a.relation(), trunc(a.expected(), 28), prov);
                }
            }
        }

        System.out.println("\n------------------------------------------------------------------------------");
        System.out.printf("Phase 3: %d tests, %d assertions  ->  %d MUST-PIN, %d derive, %d REVIEW%n",
                tests, total, mustPin, total - mustPin - review, review);
        System.out.printf("By origin: external=%d computed=%d | app_read=%d literal=%d | unknown=%d%n",
                byOrigin.getOrDefault(Origin.EXTERNAL, 0), byOrigin.getOrDefault(Origin.COMPUTED, 0),
                byOrigin.getOrDefault(Origin.APP_READ, 0), byOrigin.getOrDefault(Origin.LITERAL, 0), byOrigin.getOrDefault(Origin.UNKNOWN, 0));
        System.out.println("REVIEW = origin could not be traced -> human confirms (never silently derived).");
    }

    // ---------- classify an assertion by the strongest origin among its value expressions ----------
    static Origin classifyOrigin(Assertion a) {
        List<Expression> as = a.call().getArguments();
        Origin acc = Origin.UNKNOWN;
        int meaningful = "fail".equals(a.relation()) ? 0 : Math.min(as.size(), 2);
        for (int i = 0; i < meaningful; i++) acc = strongest(acc, trace(as.get(i), a.test(), new HashSet<>(), 0));
        // assertTrue/False: the predicate is arg0 (already traced above)
        return acc;
    }
    static Origin strongest(Origin a, Origin b) {
        for (Origin o : new Origin[]{Origin.EXTERNAL, Origin.COMPUTED, Origin.APP_READ, Origin.LITERAL})
            if (a == o || b == o) return o;
        return Origin.UNKNOWN;
    }

    // ---------- the origin tracer ----------
    static Origin trace(Expression e, MethodDeclaration test, Set<String> visited, int depth) {
        if (e == null || depth > TRACE_DEPTH) return Origin.UNKNOWN;
        if (e instanceof StringLiteralExpr || e instanceof IntegerLiteralExpr || e instanceof DoubleLiteralExpr
                || e instanceof LongLiteralExpr || e instanceof BooleanLiteralExpr || e instanceof CharLiteralExpr) return Origin.LITERAL;
        // reliable surface signals for external sources (robust even when deep resolution fails)
        String surf = e.toString();
        if (surf.matches("(?s).*(EnvironmentDataReader|ConfigReader\\.get|TestDataReader|RandomData|response\\.status|\\bbody\\.).*")) return Origin.EXTERNAL;
        if (e instanceof EnclosedExpr en) return trace(en.getInner(), test, visited, depth);
        if (e instanceof UnaryExpr u) return trace(u.getExpression(), test, visited, depth);
        if (e instanceof CastExpr c) return trace(c.getExpression(), test, visited, depth);
        if (e instanceof BinaryExpr b) {
            BinaryExpr.Operator op = b.getOperator();
            if (op == BinaryExpr.Operator.PLUS || op == BinaryExpr.Operator.MINUS || op == BinaryExpr.Operator.MULTIPLY
                    || op == BinaryExpr.Operator.DIVIDE || op == BinaryExpr.Operator.REMAINDER) return Origin.COMPUTED;
            return strongest(trace(b.getLeft(), test, visited, depth), trace(b.getRight(), test, visited, depth));
        }
        if (e instanceof NameExpr ne) return traceName(ne, test, visited, depth);
        if (e instanceof MethodCallExpr mc) return traceCall(mc, test, visited, depth);
        if (e instanceof FieldAccessExpr fa) return classifyType(safeType(fa));
        return Origin.UNKNOWN;
    }

    // a variable: data-provider content param -> EXTERNAL; else its initializer + any computed mutation
    static Origin traceName(NameExpr ne, MethodDeclaration test, Set<String> visited, int depth) {
        // data-provider content parameter of the @Test?
        boolean hasDP = test.getAnnotationByName("Test").map(a -> a.toString().contains("dataProvider")).orElse(false);
        if (hasDP) for (Parameter p : test.getParameters())
            if (p.getNameAsString().equals(ne.getNameAsString())) {
                String t = p.getTypeAsString();
                if (t.contains("List") || t.contains("[]") || t.contains("Collection") || t.contains("Map") || t.contains("String")) return Origin.EXTERNAL;
            }
        // resolve the local via AST ancestor search (robust; no reliance on symbol-solver toAst)
        Optional<MethodDeclaration> owner = ne.findAncestor(MethodDeclaration.class);
        if (owner.isPresent()) {
            MethodDeclaration md = owner.get();
            if (mutatedByComputation(md, ne.getNameAsString())) return Origin.COMPUTED;   // loop-total / sort
            for (VariableDeclarator vd : md.findAll(VariableDeclarator.class))
                if (vd.getNameAsString().equals(ne.getNameAsString()) && vd.getInitializer().isPresent())
                    return trace(vd.getInitializer().get(), test, visited, depth + 1);
            // a parameter of the enclosing helper (e.g. a page object passed in) -> app read
            for (Parameter p : md.getParameters())
                if (p.getNameAsString().equals(ne.getNameAsString()))
                    return p.getTypeAsString().matches(".*[A-Za-z]+Page") ? Origin.APP_READ : Origin.UNKNOWN;
        }
        return Origin.UNKNOWN;
    }

    static boolean mutatedByComputation(MethodDeclaration method, String var) {
        for (AssignExpr as : method.findAll(AssignExpr.class))
            if (as.getTarget().toString().equals(var) && trace(as.getValue(), method, new HashSet<>(), TRACE_DEPTH - 2) == Origin.COMPUTED) return true;
        for (MethodCallExpr c : method.findAll(MethodCallExpr.class)) {
            String n = c.getNameAsString(), txt = c.toString();
            if ((n.equals("sort")) && txt.contains(var)) return true;              // Collections.sort(var) or var.sort(...)
        }
        return false;
    }

    // a method call: categorise by what ultimately produces the value
    static Origin traceCall(MethodCallExpr mc, MethodDeclaration test, Set<String> visited, int depth) {
        String name = mc.getNameAsString();
        // size()/length() of anything is an observable COUNT, not the content itself -> derivable.
        // (body.size() is already caught as EXTERNAL by the surface signal before we get here.)
        if (name.equals("size") || name.equals("length")) return Origin.APP_READ;
        // Any read off a WebDriver / DriverFactory handle is an app interaction, never a computed
        // value. getPageSource() is a whole-page read; contains()/matches() on such a read is an
        // observational PRESENCE check ("is this text on screen") -> app_read. Anchor on the driver
        // handle in the call chain so this wins BEFORE we follow DriverFactory as an in-project method.
        String chain = mc.toString();
        if (chain.contains("getPageSource") || chain.contains("DriverFactory.getDriver")
                || chain.matches("(?s).*\\bdriver\\..*")) return Origin.APP_READ;
        String declType = "";
        try { declType = mc.resolve().declaringType().getQualifiedName(); } catch (Exception ignore) {}
        String lower = declType.toLowerCase();

        if (lower.contains("jackson") || declType.endsWith(".JsonNode") || lower.contains("restassured")
                || declType.endsWith("Response") || declType.contains("HttpResponse")
                || declType.matches(".*\\.(ConfigReader|EnvironmentDataReader|TestDataReader|RandomDataUtil|RandomData)")) return Origin.EXTERNAL;
        if (declType.equals("java.lang.Math")) return Origin.COMPUTED;
        if ((declType.equals("java.math.BigDecimal") || declType.equals("java.math.BigInteger"))
                && Set.of("add", "subtract", "multiply", "divide", "pow", "sqrt", "remainder", "mod", "negate").contains(name)) return Origin.COMPUTED;
        if (Set.of("sum", "average", "reduce", "summingDouble", "summingInt", "counting").contains(name)) return Origin.COMPUTED;
        if (lower.contains(".pages.") || declType.matches(".*\\.[A-Za-z]+Page$")
                || declType.contains("openqa.selenium")) return Origin.APP_READ;  // page object / UI element read

        // in-project method with a body -> follow its returns (handles custom calculators/readers/getters)
        try {
            ResolvedMethodDeclaration rmd = mc.resolve();
            String sig = rmd.getQualifiedSignature();
            Optional<Node> ast = rmd.toAst();
            if (ast.isPresent() && ast.get() instanceof MethodDeclaration md && md.getBody().isPresent() && !visited.contains(sig)) {
                visited.add(sig);
                Origin acc = Origin.UNKNOWN;
                for (ReturnStmt rs : md.findAll(ReturnStmt.class))
                    if (rs.getExpression().isPresent()) acc = strongest(acc, trace(rs.getExpression().get(), test, visited, depth + 1));
                if (acc != Origin.UNKNOWN) return acc;
            }
        } catch (Exception ignore) {}

        // fall back: strongest origin among receiver + arguments (e.g. getText().contains(dataItem))
        Origin acc = Origin.UNKNOWN;
        if (mc.getScope().isPresent()) acc = strongest(acc, trace(mc.getScope().get(), test, visited, depth + 1));
        for (Expression arg : mc.getArguments()) acc = strongest(acc, trace(arg, test, visited, depth + 1));
        return acc;
    }

    static Origin classifyType(String fqn) {
        if (fqn.contains("openqa.selenium") || fqn.matches(".*\\.[A-Za-z]+Page$")) return Origin.APP_READ;
        if (fqn.contains("jackson") || fqn.endsWith(".Response")) return Origin.EXTERNAL;
        return Origin.UNKNOWN;
    }
    static String safeType(Expression e) { try { return e.calculateResolvedType().describe(); } catch (Exception ex) { return ""; } }

    // ---------- assertion collection (same deep call-following as Phase 2) ----------
    static void walk(Node body, List<String> chain, Set<String> visited, List<Assertion> out, int depth, MethodDeclaration test) {
        if (body == null || depth > WALK_DEPTH) return;
        List<MethodCallExpr> calls = body.findAll(MethodCallExpr.class);
        for (MethodCallExpr call : calls) if (isAssertion(call)) out.add(makeAssertion(call, chain, test));
        for (MethodCallExpr call : calls) {
            if (isAssertion(call) || FOLLOW_SKIP.contains(call.getNameAsString())) continue;
            try {
                ResolvedMethodDeclaration rmd = call.resolve();
                String sig = rmd.getQualifiedSignature();
                if (visited.contains(sig)) continue;
                Optional<Node> ast = rmd.toAst();
                if (ast.isPresent() && ast.get() instanceof MethodDeclaration md && md.getBody().isPresent()) {
                    visited.add(sig);
                    List<String> child = new ArrayList<>(chain); child.add(md.getNameAsString());
                    walk(md.getBody().get(), child, visited, out, depth + 1, test);
                }
            } catch (Exception ignore) {}
        }
    }
    static boolean isAssertion(MethodCallExpr call) { return ASSERT_NAMES.contains(call.getNameAsString()); }
    static Assertion makeAssertion(MethodCallExpr call, List<String> chain, MethodDeclaration test) {
        String name = call.getNameAsString();
        List<Expression> as = call.getArguments();
        String subject = as.size() > 0 ? as.get(0).toString() : "";
        String expected, relation;
        switch (name) {
            case "assertTrue" -> { expected = "true"; relation = "is_true"; }
            case "assertFalse" -> { expected = "false"; relation = "is_false"; }
            case "assertNotNull" -> { expected = "notNull"; relation = "not_null"; }
            case "assertNull" -> { expected = "null"; relation = "is_null"; }
            case "fail" -> { subject = ""; expected = ""; relation = "fail"; }
            case "assertThat" -> { expected = as.size() > 1 ? as.get(1).toString() : ""; relation = "that"; }
            default -> { expected = as.size() > 1 ? as.get(1).toString() : ""; relation = "equals"; }
        }
        return new Assertion(call, relation, subject, expected, new ArrayList<>(chain), test);
    }
    static String trunc(String s, int n) { s = s.replaceAll("\\s+", " "); return s.length() <= n ? s : s.substring(0, n) + "\u2026"; }
}
