const
    { spawnSync } = require("node:child_process"),
    { fs, path, relativeTo, realPath } = require("./util.cjs"),
    { analyzeSyntax, assertAnalysisGlobal } = require("./syntax.cjs");

function programFiles(project, compiler, root) {
    const
        result = spawnSync(process.execPath, [compiler, "-p", project.tsconfig, "--listFilesOnly"], { cwd: root, encoding: "utf8" });
    if (result.error)
        throw result.error;
    if (result.status !== 0)
        throw new Error(result.stdout + result.stderr);
    return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => path.isAbsolute(line)).map(file => path.resolve(file));
}

// A stale declaration emit next to its source (Foo.d.ts beside Foo.ts) is
// picked up by "**/*.ts" and breaks tsc with a cryptic TS2300 duplicate
// identifier. Fail fast with an actionable message instead. One fused pass
// resolves inside-paths once (realpath is a syscall per file) and feeds the
// ordering filter too; results are memoized per file-list identity so the
// pre-emit check in build plus the ordering check share the work.
const classificationCache = new WeakMap();

function classifyProgram(files, root) {
    const cached = classificationCache.get(files);
    if (cached != null && cached.root === root)
        return cached;
    const
        rootReal = realPath(root),
        reals = new Map(),
        seen = new Map(),
        sources = new Set(),
        pending = [],
        inside = file => {
            let resolved = seen.get(file);
            if (resolved === undefined) {
                let real = reals.get(file);
                if (real === undefined) {
                    real = realPath(file);
                    reals.set(file, real);
                }
                // Mirrors insidePath with a memoized root; keep in sync.
                const relative = path.relative(rootReal, real);
                resolved = relative === "" || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative) ? null : path.resolve(root, relative);
                seen.set(file, resolved);
            }
            return resolved;
        };
    for (const file of files) {
        const resolved = inside(file);
        if (resolved == null || !resolved.endsWith(".ts"))
            continue;
        if (resolved.endsWith(".d.ts"))
            pending.push(resolved);
        else
            sources.add(resolved);
    }
    const
        shadows = [],
        excluded = [];
    for (const resolved of pending) {
        const sibling = resolved.replace(/\.d\.ts$/, ".ts");
        if (sources.has(sibling))
            shadows.push([sibling, resolved]);
        else if (fs.existsSync(sibling))
            excluded.push([sibling, resolved]);
    }
    const classification = { root, sources: [...sources], shadows, excluded };
    classificationCache.set(files, classification);
    return classification;
}

function shadowDeclarations(files, root) {
    return classifyProgram(files, root).shadows;
}

// A .d.ts in the program whose sibling .ts exists on disk but is missing
// from the program means the source was excluded (e.g. a lowercase
// "**/*.test.ts" exclude matching Data.Test.ts) while its stale emit slips
// in via "include". Without the "files" rescue this builds silently with
// stale declarations and a missing source, which is worse than a loud TS2300.
function excludedSiblings(files, root) {
    return classifyProgram(files, root).excluded;
}

function assertNoShadowDeclarations(files, project, root) {
    const
        classification = classifyProgram(files, root),
        shadows = classification.shadows,
        excluded = classification.excluded;
    if (shadows.length === 0 && excluded.length === 0)
        return;
    const list = [
        ...shadows.map(([source, shadow]) => `${relativeTo(root, source)} shadowed by ${relativeTo(root, shadow)}`),
        ...excluded.map(([source, shadow]) => `${relativeTo(root, source)} excluded from the program but shadowed by ${relativeTo(root, shadow)} on disk`),
    ].join("\n");
    throw new Error(`Stale declaration emit in ${project.name}:\n` + list + `\nDelete stale *.js/*.js.map/*.d.ts/*.d.ts.map siblings outside outDir/_Public, keep only *.ts sources, then rebuild with --force. Check tsconfig include/exclude/files too (e.g. a lowercase "**/*.test.ts" exclude matching capital-Test entities like Data.Test.ts on case-insensitive systems).`);
}

// Follow the same reference-before-referrer ordering used by script projects.
// Heritage (extends) edges must additionally hold: a class cannot extend a
// value that evaluates later. Reference cycles are broken by dropping
// non-heritage edges; a heritage-only cycle is unorderable -> loud failure.
function orderedSources(project, compiler, root, log, files = programFiles(project, compiler, root)) {
    assertNoShadowDeclarations(files, project, root);
    const
        sources = classifyProgram(files, root).sources,
        included = new Set(sources),
        analysis = analyzeSyntax(sources, { root, compiler, tsconfig: project.tsconfig }),
        records = new Map(analysis.files.map(file => [file.source, file])),
        graph = new Map();
    assertAnalysisGlobal(analysis, project, root);
    for (const file of sources) {
        const deps = [];
        for (const reference of records.get(file).references) {
            const dependency = path.resolve(path.dirname(file), reference);
            if (included.has(dependency)) {
                if (dependency !== file && !deps.includes(dependency))
                    deps.push(dependency);
            }
            else if (!dependency.endsWith(".d.ts"))
                throw new Error(`Reference outside ${project.name}: ${dependency}`);
        }
        graph.set(file, deps);
    }
    const heritage = new Map(analysis.files.map(file => [file.source, new Set(file.targets)]));
    // Heritage targets missing a reference edge rely on luck today; make the
    // need explicit so the sort honors it.
    for (const [file, targets] of heritage)
        for (const target of targets)
            if (!graph.get(file).includes(target))
                graph.get(file).push(target);
    for (const [file, dep] of breakCycles(graph, heritage, project.name, root))
        (log || console.log)(`[${project.name}] cycle: ignoring ordering hint ${relativeTo(root, file)} -> ${relativeTo(root, dep)}`);
    const
        visited = new Set(),
        ordered = [];

    function visit(file) {
        if (visited.has(file))
            return;
        visited.add(file);
        for (const dependency of graph.get(file))
            visit(dependency);
        ordered.push(file);
    }

    for (const file of sources)
        visit(file);
    const
        position = new Map(ordered.map((file, i) => [file, i])),
        unorderable = [];
    for (const [file, targets] of heritage)
        for (const target of targets)
            if (position.get(target) > position.get(file))
                unorderable.push(`${relativeTo(root, file)} extends ${relativeTo(root, target)} but bundles after it.`);
    if (unorderable.length > 0)
        throw new Error(`Unorderable heritage in ${project.name}:\n` + unorderable.join("\n"));
    return ordered;
}

function programExports(sources, texts) {
    const table = new Map();
    for (const entry of analyzeSyntax(sources, { texts }).classes) {
        const key = entry.namespace + "|" + entry.name;
        if (!table.has(key))
            table.set(key, new Set());
        table.get(key).add(entry.source);
    }
    return table;
}

function resolveExport(table, namespace, name) {
    if (namespace != null) {
        const candidates = table.get(namespace + "|" + name);
        return candidates != null && candidates.size === 1 ? [...candidates][0] : null;
    }
    let found = null, count = 0;
    for (const [key, candidates] of table) {
        if (candidates.size === 1 && key.endsWith("|" + name)) {
            count++;
            found = [...candidates][0];
        }
    }
    return count === 1 ? found : null;
}

// file -> Set of files defining a base class it extends (eval-time order needs).
function heritageEdges(sources, texts) {
    return new Map(analyzeSyntax(sources, { texts }).files.map(file => [file.source, new Set(file.targets)]));
}

function stronglyConnected(graph) {
    const
        index = new Map(),
        low = new Map(),
        stack = [],
        onStack = new Set(),
        result = [];
    let counter = 0;
    function visit(node) {
        index.set(node, counter);
        low.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
        for (const dep of graph.get(node)) {
            if (!index.has(dep)) {
                visit(dep);
                low.set(node, Math.min(low.get(node), low.get(dep)));
            }
            else if (onStack.has(dep))
                low.set(node, Math.min(low.get(node), index.get(dep)));
        }
        if (low.get(node) === index.get(node)) {
            const scc = [];
            let member;
            do {
                member = stack.pop();
                onStack.delete(member);
                scc.push(member);
            } while (member !== node);
            if (scc.length > 1)
                result.push(scc);
        }
    }
    for (const node of graph.keys())
        if (!index.has(node))
            visit(node);
    return result;
}

// Drop non-heritage edges inside cycles so the remaining graph orders every
// extends-target before its subclass. Returns dropped [file, dep] pairs.
function breakCycles(graph, heritage, name, root) {
    const dropped = [];
    for (;;) {
        const cycles = stronglyConnected(graph);
        if (cycles.length === 0)
            return dropped;
        let progress = false;
        for (const scc of cycles) {
            const inScc = new Set(scc);
            for (const file of scc)
                for (const dep of [...graph.get(file)]) {
                    if (!inScc.has(dep))
                        continue;
                    const needs = heritage.get(file);
                    if (!(needs != null && needs.has(dep))) {
                        graph.set(file, graph.get(file).filter(d => d !== dep));
                        dropped.push([file, dep]);
                        progress = true;
                    }
                }
        }
        if (!progress) {
            const unorderable = stronglyConnected(graph)[0].map(file => relativeTo(root, file)).join(" -> ");
            throw new Error(`Circular class heritage cannot be ordered in ${name}: ${unorderable}.`);
        }
    }
}

module.exports = { programFiles, shadowDeclarations, excludedSiblings, assertNoShadowDeclarations, orderedSources, heritageEdges, programExports, resolveExport, stronglyConnected, breakCycles };
