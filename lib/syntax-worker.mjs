import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

async function analyze(request) {
    const
        compilerRequire = createRequire(path.resolve(request.compiler)),
        load = name => import(pathToFileURL(compilerRequire.resolve("typescript/unstable/" + name)).href),
        { API, SymbolFlags } = await load("sync"),
        { SyntaxKind: K, ModifierFlags: M } = await load("ast"),
        normalize = file => path.resolve(file).split(path.sep).join("/"),
        key = file => process.platform === "win32" ? normalize(file).toLowerCase() : normalize(file),
        names = new Map(request.sources.map(source => [key(source), source]));
    let config = request.tsconfig == null ? null : normalize(path.resolve(request.root, request.tsconfig)), virtual;
    if (config == null) {
        config = normalize(path.join(request.root, ".tsgo-bundle-analysis.json"));
        const { createVirtualFileSystem } = await load("fs");
        const files = Object.fromEntries(request.sources.map(source => [normalize(source), request.texts?.[source] ?? fs.readFileSync(source, "utf8")]));
        files[config] = JSON.stringify({ compilerOptions: { noLib: true, types: [], moduleDetection: "legacy", target: "esnext" }, files: request.sources.map(normalize) });
        virtual = createVirtualFileSystem(files);
    }
    const api = new API({ cwd: request.root, fs: virtual });
    try {
        const snapshot = api.updateSnapshot({ openProjects: [config] }), project = snapshot.getProject(config);
        if (project == null)
            throw new Error(`Could not load ${config}.`);
        const result = { files: [], classes: [] };
        function ambient(node) {
            for (let current = node; current != null && current.kind !== K.SourceFile; current = current.parent)
                if ((current.modifierFlags & M.Ambient) !== 0)
                    return true;
            return false;
        }
        function baseExpression(node) {
            while ([K.ParenthesizedExpression, K.AsExpression, K.TypeAssertionExpression, K.NonNullExpression, K.SatisfiesExpression].includes(node.kind))
                node = node.expression;
            return node;
        }
        function namedExpression(node) {
            return node.kind === K.Identifier || (node.kind === K.PropertyAccessExpression && namedExpression(node.expression));
        }
        function className(node) {
            if (node.kind !== K.ClassDeclaration || node.name == null)
                return null;
            const namespaces = [];
            let current = node.parent;
            while (current.kind !== K.SourceFile) {
                if (current.kind === K.ModuleDeclaration)
                    namespaces.unshift(current.name.text);
                else if (current.kind !== K.ModuleBlock)
                    return null;
                current = current.parent;
            }
            if (namespaces.length > 0 && (node.modifierFlags & M.Export) === 0)
                return null;
            return { namespace: namespaces.join("."), name: node.name.text };
        }
        for (const source of request.sources) {
            const file = project.program.getSourceFile(normalize(source));
            if (file == null)
                throw new Error(`Source is not in the compiler program: ${source}.`);
            const record = { source, module: !!file.externalModuleIndicator, references: file.referencedFiles.map(reference => reference.fileName), targets: [] };
            result.files.push(record);
            if (!request.heritage || record.module)
                continue;
            const stack = [file], bases = [], targets = new Set();
            while (stack.length > 0) {
                const node = stack.pop();
                if ((node.modifierFlags & M.Ambient) !== 0)
                    continue;
                if (node.kind === K.ImportEqualsDeclaration && node.moduleReference.kind !== K.ExternalModuleReference && !node.isTypeOnly)
                    bases.push(node.moduleReference);
                if (node.kind === K.ClassDeclaration || node.kind === K.ClassExpression) {
                    const name = className(node);
                    if (name != null)
                        result.classes.push({ source, ...name });
                    for (const clause of node.heritageClauses || []) {
                        if (clause.token !== K.ExtendsKeyword)
                            continue;
                        for (const type of clause.types) {
                            const expression = baseExpression(type.expression);
                            if (expression.kind === K.NullKeyword)
                                continue;
                            if (!namedExpression(expression)) {
                                const line = file.getLineAndCharacterOfPosition(expression.getStart()).line + 1;
                                throw new Error(`Unsupported class heritage in ${source}:${line}: ${type.expression.getText()}. Use a named base class or constructor; dynamic/mixin heritage cannot be ordered safely.`);
                            }
                            bases.push(expression);
                        }
                    }
                }
                node.forEachChild(child => { stack.push(child); });
            }
            // Batch symbol queries; the compiler handles namespace merging,
            // lexical shadowing, Unicode identifiers and qualified names.
            const symbols = bases.length === 0 ? [] : project.checker.getSymbolAtLocation(bases);
            function addDeclaration(handle) {
                if (handle == null)
                    return;
                const target = names.get(key(handle.path));
                if (target == null || target === source)
                    return;
                const declaration = handle.resolve(project);
                if (declaration != null && !ambient(declaration))
                    targets.add(target);
            }
            for (let symbol of symbols) {
                const seen = new Set();
                while (symbol != null && !seen.has(symbol.id)) {
                    seen.add(symbol.id);
                    if ((symbol.flags & SymbolFlags.Alias) === 0) {
                        addDeclaration(symbol.valueDeclaration);
                        break;
                    }
                    // An internal import alias has its own emitted initializer.
                    for (const declaration of symbol.declarations)
                        addDeclaration(declaration);
                    symbol = project.checker.getImmediateAliasedSymbol(symbol);
                }
            }
            record.targets = [...targets];
        }
        return result;
    }
    finally {
        api.close();
    }
}

try {
    const request = JSON.parse(fs.readFileSync(0, "utf8"));
    process.stdout.write(JSON.stringify(await analyze(request)));
}
catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
}
