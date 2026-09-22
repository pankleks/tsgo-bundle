const
    { spawnSync } = require("node:child_process"),
    { fs, path } = require("./util.cjs"),
    { orderedSources } = require("./order.cjs"),
    { bundle } = require("./merge.cjs"),
    { scanInputs, loadState, compilerStamp, isUpToDate, snapshotWithHashes, saveState } = require("./state.cjs");

const STATE_VERSION = 1;

function bundlerVersion() {
    return require("../package.json").version;
}

function compilerVersion(compiler) {
    try {
        return require(compilerPackage(compiler)).version;
    }
    catch {
        return "unknown";
    }
}

function compilerPackage(compiler) {
    const normalized = compiler.split(path.sep).join("/");
    const marker = "node_modules/";
    const index = normalized.lastIndexOf(marker);
    if (index === -1)
        return null;
    const rest = normalized.slice(index + marker.length).split("/");
    const name = rest[0].startsWith("@") ? rest[0] + "/" + rest[1] : rest[0];
    return name + "/package.json";
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
    const
        root = options.root || process.cwd(),
        compiler = options.compiler,
        stateFile = path.resolve(root, config.stateFile || ".build/buildstate.json"),
        stamp = compilerStamp(compilerVersion(compiler), bundlerVersion()),
        state = loadState(stateFile, STATE_VERSION) || { version: STATE_VERSION, compiler: stamp, projects: {} };
    for (const project of selectedProjects(config.projects, options.only)) {
        const scanStarted = Date.now();
        const inputs = scanInputs(project, root);
        console.log(`[${project.name}] scan: ${((Date.now() - scanStarted) / 1000).toFixed(1)}s`);
        if (!options.force && isUpToDate(project, state, inputs, stamp, root)) {
            console.log(`[${project.name}] up to date, skipping.`);
            continue;
        }
        if (options.force) {
            fs.rmSync(path.join(root, project.outDir), { recursive: true, force: true });
            if (project.tsbuildinfo != null)
                fs.rmSync(path.join(root, project.tsbuildinfo), { force: true });
        }
        console.log(`Building ${project.name} with tsgo`);
        const
            started = Date.now(),
            elapsed = (label, from) => console.log(`[${project.name}] ${label}: ${((Date.now() - from) / 1000).toFixed(1)}s (total ${((Date.now() - started) / 1000).toFixed(1)}s)`);
        let checkpoint = Date.now();
        const result = spawnSync(process.execPath, [compiler, "-p", project.tsconfig], { cwd: root, stdio: "inherit" });
        elapsed("tsgo emit", checkpoint);
        if (result.error)
            throw result.error;
        // Configs usually keep noEmitOnError false like legacy tsc builds, so
        // outputs are still emitted alongside errors. Bundle them to keep
        // artifacts fresh, but propagate the failure afterwards.
        const failed = result.status !== 0;
        checkpoint = Date.now();
        const sources = orderedSources(project, compiler, root);
        elapsed(`order (${sources.length} files)`, checkpoint);
        checkpoint = Date.now();
        bundle(project, sources, ".js", path.join(root, project.js), root);
        elapsed("bundle js", checkpoint);
        if (project.dts != null) {
            checkpoint = Date.now();
            bundle(project, sources, ".d.ts", path.join(root, project.dts), root);
            elapsed("bundle d.ts", checkpoint);
        }
        state.compiler = stamp;
        state.projects[project.name] = snapshotWithHashes(inputs);
        saveState(stateFile, state);
        elapsed("done", started);
        if (failed)
            throw new Error(`tsgo failed for ${project.name} (exit ${result.status})`);
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

function watch(config, options) {
    let timer;
    // fs.watch { recursive: true } only works on macOS and Windows, so watch
    // every subdirectory individually. Directories created after startup are
    // picked up on restart.
    function watchTree(directory, onChange) {
        onChange(directory);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === ".build" || entry.name.startsWith("."))
                continue;
            if (entry.isDirectory())
                watchTree(path.join(directory, entry.name), onChange);
        }
    }
    const
        schedule = () => {
            clearTimeout(timer);
            timer = setTimeout(() => run(config, options), 150);
        },
        watched = new Set();
    for (const project of selectedProjects(config.projects, options.only))
        // Test files may live in a second tree (rootDir), watch both.
        for (const directory of [project.projectDir, project.rootDir])
            watchTree(path.join(options.root || process.cwd(), directory), watchedDirectory => {
                if (watched.has(watchedDirectory))
                    return;
                watched.add(watchedDirectory);
                fs.watch(watchedDirectory, (event, filename) => {
                    if (!filename || filename.endsWith(".d.ts") || !(filename.endsWith(".ts") || filename.endsWith(".json")))
                        return;
                    schedule();
                });
            });
    console.log("Watching TypeScript sources and project configurations...");
}

module.exports = { STATE_VERSION, bundlerVersion, selectedProjects, validateConfig, build, run, watch };
