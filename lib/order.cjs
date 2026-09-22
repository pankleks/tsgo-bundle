const
    { spawnSync } = require("node:child_process"),
    { path, relativeTo, insidePath } = require("./util.cjs"),
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

// Follow the same reference-before-referrer ordering used by script projects.
// Heritage (extends) edges must additionally hold: a class cannot extend a
// value that evaluates later. Reference cycles are broken by dropping
// non-heritage edges; a heritage-only cycle is unorderable -> loud failure.
function orderedSources(project, compiler, root, log, files = programFiles(project, compiler, root)) {
    const
        sources = files.filter(file => file.endsWith(".ts") && !file.endsWith(".d.ts")).map(file => insidePath(root, file)).filter(file => file != null),
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

module.exports = { programFiles, orderedSources, heritageEdges, programExports, resolveExport, stronglyConnected, breakCycles };
