const
    { spawnSync } = require("node:child_process"),
    { path, relativeTo } = require("./util.cjs"),
    { resolveCompiler } = require("./resolve-compiler.cjs");

// The compiler's native API is ESM. Keep it in a short-lived worker so the public
// CommonJS build API stays synchronous on every supported Node 22+ version.
function analyzeSyntax(sources, { root = process.cwd(), compiler = resolveCompiler(root), tsconfig, texts, heritage = true } = {}) {
    const result = spawnSync(process.execPath, [path.join(__dirname, "syntax-worker.mjs")], {
        cwd: root,
        encoding: "utf8",
        input: JSON.stringify({ root, compiler, tsconfig, sources, texts: texts == null ? null : Object.fromEntries(texts), heritage }),
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120000,
    });
    if (result.error != null)
        throw result.error;
    if (result.status !== 0)
        throw new Error(`TypeScript syntax analysis failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    return JSON.parse(result.stdout);
}

function assertAnalysisGlobal(analysis, project, root) {
    for (const file of analysis.files)
        if (file.module)
            throw new Error(`ES module syntax in ${project.name}: ${relativeTo(root, file.source)} is an external module (import/export or moduleDetection). Sources must remain global scripts.`);
}

function assertGlobalScript(text, project, source, root) {
    const analysis = analyzeSyntax([source], { texts: new Map([[source, text]]), heritage: false });
    assertAnalysisGlobal(analysis, project, root);
}

module.exports = { analyzeSyntax, assertAnalysisGlobal, assertGlobalScript };
