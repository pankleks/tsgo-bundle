const
    { spawnSync } = require("node:child_process"),
    { fs, path } = require("./util.cjs"),
    { programFiles, assertNoShadowDeclarations, orderedSources } = require("./order.cjs"),
    { bundle } = require("./merge.cjs"),
    { forceInputs, assertNonForceTsbuildinfo } = require("./force.cjs"),
    { declarationInputs, canReuseDeclarations, declarationSnapshot } = require("./declaration-cache.cjs"),
    { scanInputs, loadState, compilerStamp, projectFingerprint, isUpToDate, inputsMatch, snapshotWithHashes, saveState } = require("./state.cjs");

const STATE_VERSION = 2;

function bundlerVersion() {
    return require("../package.json").version;
}

function compilerVersion(compiler) {
    try {
        return JSON.parse(fs.readFileSync(compilerPackage(compiler), "utf8")).version;
    }
    catch {
        return "unknown";
    }
}

function compilerPackage(compiler) {
    return path.resolve(path.dirname(compiler), "..", "package.json");
}

function selectedProjects(projects, only) {
    if (only == null || only.length === 0)
        return projects;
    const selected = projects.filter(project => only.includes(project.name));
    const missing = only.filter(name => !projects.some(project => project.name === name));
    if (missing.length > 0)
        throw new Error(`Unknown project(s): ${missing.join(", ")}. Available: ${projects.map(project => project.name).join(", ")}.`);
    return selected;
}

function validateConfig(config) {
    if (config == null || !Array.isArray(config.projects) || config.projects.length === 0)
        throw new Error("Config must export { projects: [...] } with at least one project.");
    const names = new Set();
    for (const project of config.projects) {
        for (const field of ["name", "tsconfig", "projectDir", "rootDir", "outDir", "js", "scanDirs"])
            if (project[field] == null || (Array.isArray(project[field]) && project[field].length === 0))
                throw new Error(`Project ${project.name || "?"} is missing required field "${field}".`);
        if (names.has(project.name))
            throw new Error(`Duplicate project name "${project.name}".`);
        names.add(project.name);
    }
    return config;
}

function build(config, options) {
    validateConfig(config);
    const
        root = options.root || process.cwd(),
        compiler = options.compiler,
        stateFile = path.resolve(root, config.stateFile || ".build/buildstate.json"),
        stamp = compilerStamp(compilerVersion(compiler), bundlerVersion()) + "|" + path.resolve(compiler),
        state = loadState(stateFile, STATE_VERSION) || { version: STATE_VERSION, projects: {} },
        projects = selectedProjects(config.projects, options.only),
        forced = options.force ? forceInputs(config, projects, options) : null;
    for (const project of projects) {
        const previous = options.force ? null : state.projects[project.name];
        const scanStarted = Date.now();
        const inputs = scanInputs(project, root, state.projects[project.name]?.dependencies);
        console.log(`[${project.name}] scan: ${((Date.now() - scanStarted) / 1000).toFixed(1)}s`);
        if (!options.force && isUpToDate(project, state, inputs, stamp, root)) {
            if (options.onInputs != null)
                options.onInputs(project, state.projects[project.name].dependencies);
            console.log(`[${project.name}] up to date, skipping.`);
            continue;
        }
        // Persist invalidation before touching emit or bundles. A failed build
        // may have overwritten artifacts, even if sources later revert exactly.
        delete state.projects[project.name];
        saveState(stateFile, state);
        if (options.force)
            fs.rmSync(path.resolve(root, project.outDir), { recursive: true, force: true });
        console.log(`Building ${project.name} with TypeScript`);
        const
            started = Date.now(),
            elapsed = (label, from) => console.log(`[${project.name}] ${label}: ${((Date.now() - from) / 1000).toFixed(1)}s (total ${((Date.now() - started) / 1000).toFixed(1)}s)`);
        let checkpoint = Date.now();
        const dependencies = forced?.get(project.name) || programFiles(project, compiler, root);
        assertNoShadowDeclarations(dependencies, project, root);
        if (options.onInputs != null)
            options.onInputs(project, dependencies);
        const snapshot = snapshotWithHashes(scanInputs(project, root, dependencies), previous?.inputs);
        elapsed("inputs", checkpoint);
        checkpoint = Date.now();
        if (project.tsbuildinfo != null) {
            // TypeScript 7 incremental builds can exit 0 without re-reporting
            // semantic errors in unchanged files (a narrowed signature surfaces
            // only at its unchanged callers); that false success would then be
            // cached as up to date. Always start the compiler without its
            // buildinfo so every rebuild fully type-checks (--force targets
            // are already validated, other runs are checked here against
            // scanned inputs and the fresh program file list).
            if (!options.force)
                assertNonForceTsbuildinfo(config, project, inputs, dependencies, options, root);
            fs.rmSync(path.resolve(root, project.tsbuildinfo), { force: true });
        }
        const result = spawnSync(process.execPath, [compiler, "-p", project.tsconfig], { cwd: root, stdio: "inherit" });
        elapsed("tsc emit", checkpoint);
        if (result.error)
            throw result.error;
        // Configs usually keep noEmitOnError false like legacy tsc builds, so
        // outputs are still emitted alongside errors. Bundle them to keep
        // artifacts fresh, but propagate the failure afterwards.
        const failed = result.status !== 0;
        checkpoint = Date.now();
        const sources = orderedSources(project, compiler, root, undefined, dependencies);
        elapsed(`order (${sources.length} files)`, checkpoint);
        checkpoint = Date.now();
        bundle(project, sources, ".js", path.join(root, project.js), root, true);
        elapsed("bundle js", checkpoint);
        let declarations;
        if (project.dts != null) {
            checkpoint = Date.now();
            const
                emittedInputs = declarationInputs(project, sources, root),
                cached = previous?.compiler === stamp && previous?.config === projectFingerprint(project) ? previous.declarations : null;
            let emittedHashes;
            if (canReuseDeclarations(project, sources, emittedInputs, cached, root))
                elapsed("bundle d.ts (unchanged, reused)", checkpoint);
            else {
                emittedHashes = bundle(project, sources, ".d.ts", path.join(root, project.dts), root, true);
                elapsed("bundle d.ts", checkpoint);
            }
            declarations = declarationSnapshot(project, sources, emittedInputs, cached, root, emittedHashes);
        }
        elapsed("done", started);
        if (failed)
            throw new Error(`tsc failed for ${project.name} (exit ${result.status})`);
        // Never associate post-build source content with earlier compiler output.
        // An edit during the build leaves the project invalid for the next run.
        if (inputsMatch(snapshot, scanInputs(project, root, dependencies))) {
            state.projects[project.name] = { compiler: stamp, config: projectFingerprint(project), dependencies, inputs: snapshot, declarations };
            saveState(stateFile, state);
        }
    }
}

function run(config, options) {
    try {
        build(validateConfig(config), options);
        console.log("Build complete.");
    }
    catch (error) {
        console.error(error.message);
        if (!options.watch)
            process.exitCode = 1;
    }
}

async function watch(config, options) {
    return require("./watch.cjs").watch(config, options);
}

module.exports = { STATE_VERSION, bundlerVersion, selectedProjects, validateConfig, build, run, watch };
