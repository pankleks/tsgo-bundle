const
    { spawnSync } = require("node:child_process"),
    { fs, path, relativeTo, stripComments } = require("./util.cjs");

// Follow the same reference-before-referrer ordering used by script projects.
// Heritage (extends) edges must additionally hold: a class cannot extend a
// value that evaluates later. Reference cycles are broken by dropping
// non-heritage edges; a heritage-only cycle is unorderable -> loud failure.
function orderedSources(project, compiler, root, log) {
    const
        result = spawnSync(process.execPath, [compiler, "-p", project.tsconfig, "--listFilesOnly"], { cwd: root, encoding: "utf8" });
    if (result.error)
        throw result.error;
    if (result.status !== 0)
        throw new Error(result.stdout + result.stderr);
    const
        sources = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.endsWith(".ts") && !line.endsWith(".d.ts") && line.startsWith(root)).map(file => path.resolve(file)),
        included = new Set(sources),
        texts = new Map(sources.map(file => [file, stripComments(fs.readFileSync(file, "utf8"))])),
        graph = new Map();
    for (const file of sources) {
        const deps = [];
        for (const match of texts.get(file).matchAll(/^\s*\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["'][^>]*>/gm)) {
            const dependency = path.resolve(path.dirname(file), match[1]);
            if (included.has(dependency)) {
                if (dependency !== file && !deps.includes(dependency))
                    deps.push(dependency);
            }
            else if (!dependency.endsWith(".d.ts"))
                throw new Error(`Reference outside ${project.name}: ${dependency}`);
        }
        graph.set(file, deps);
    }
    const heritage = heritageEdges(sources, texts);
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
    for (const file of sources) {
        const
            text = texts.get(file),
            namespaces = [...text.matchAll(/namespace\s+([\w.]+)\s*\{/g)].map(match => match[1]);
        for (const match of text.matchAll(/export\s+(?:abstract\s+)?class\s+([A-Za-z_]\w*)/g))
            for (const namespace of namespaces.length > 0 ? namespaces : [""]) {
                const key = namespace + "|" + match[1];
                if (!table.has(key))
                    table.set(key, new Set());
                table.get(key).add(file);
            }
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
    const
        table = programExports(sources, texts),
        edges = new Map();
    for (const file of sources) {
        const
            text = texts.get(file),
            namespaces = [...text.matchAll(/namespace\s+([\w.]+)\s*\{/g)].map(match => match[1]),
            targets = new Set();
        // Class heritage only (extends after the class name). Generic
        // constraints (<T extends ...>) and conditional types are type-only
        // and erased, so they impose no chunk order.
        for (const match of text.matchAll(/(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_]\w*\s*(?:<[^;{}]*>)?\s+extends\s+([\w.]+)(?=\s*(?:<|\{|implements))/g)) {
            const name = match[1];
            let target = null;
            if (name.includes(".")) {
                const dot = name.lastIndexOf(".");
                target = resolveExport(table, name.slice(0, dot), name.slice(dot + 1));
            }
            else {
                for (const namespace of namespaces) {
                    target = resolveExport(table, namespace, name);
                    if (target != null)
                        break;
                }
                if (target == null)
                    target = resolveExport(table, null, name);
            }
            if (target != null && target !== file)
                targets.add(target);
        }
        edges.set(file, targets);
    }
    return edges;
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

module.exports = { orderedSources, heritageEdges, programExports, resolveExport, stronglyConnected, breakCycles };
