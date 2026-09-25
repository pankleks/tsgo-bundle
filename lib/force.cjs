const
    { fs, path, realPath, isInside } = require("./util.cjs"),
    { commonJSInputs } = require("./config-inputs.cjs"),
    { programFiles } = require("./order.cjs"),
    { scanInputs } = require("./state.cjs");

// A tsbuildinfo path must never resolve to a directory or a protected input:
// deleting it would destroy sources or configs instead of compiler state.
function assertSafeTsbuildinfo(project, root, protectedPaths, label) {
    const buildinfo = path.resolve(root, project.tsbuildinfo);
    if (fs.statSync(buildinfo, { throwIfNoEntry: false })?.isDirectory() || protectedPaths.some(file => realPath(file) === realPath(buildinfo)))
        throw new Error(`${label} for ${project.name}: tsbuildinfo ${buildinfo} is a protected input or directory.`);
}

// Guard a tsbuildinfo wipe on a normal incremental build. Mirrors the first
// forceInputs pass (workspace roots, compiler, config and every project's
// static inputs, including unselected ones) plus this project's scanned
// inputs and fresh program files, which the second force pass would discover
// by rescanning. Both are needed: outputs (tsbuildinfo included) are masked
// from directory scans, while explicit program files are always recorded.
function assertNonForceTsbuildinfo(config, project, scanned, dependencies, options, root) {
    const
        resolved = path.resolve(root),
        directories = [resolved, path.join(resolved, ".git")],
        files = new Set([path.resolve(options.compiler)]);
    if (options.config != null)
        for (const file of commonJSInputs(path.resolve(resolved, options.config)))
            files.add(file);
    for (const other of config.projects) {
        for (const directory of [other.projectDir, other.rootDir, ...other.scanDirs.map(scan => scan.dir)])
            directories.push(path.resolve(resolved, directory));
        for (const file of [other.tsconfig, ...(other.extraFiles || [])])
            files.add(path.resolve(resolved, file));
    }
    for (const file of Object.keys(scanned))
        files.add(file);
    for (const file of dependencies)
        files.add(file);
    assertSafeTsbuildinfo(project, resolved, [...directories, ...files], "Unsafe build");
}

// Validate every selected deletion before any project is modified. Include
// unselected projects: --only must not make their sources disposable.
function forceInputs(config, projects, options) {
    const
        root = path.resolve(options.root || process.cwd()),
        directories = [root, path.join(root, ".git")],
        files = new Set([path.resolve(options.compiler)]),
        dependencies = new Map();
    if (options.config != null)
        for (const file of commonJSInputs(path.resolve(root, options.config)))
            files.add(file);
    for (const project of config.projects) {
        for (const directory of [project.projectDir, project.rootDir, ...project.scanDirs.map(scan => scan.dir)])
            directories.push(path.resolve(root, directory));
        for (const file of [project.tsconfig, ...(project.extraFiles || [])])
            files.add(path.resolve(root, file));
    }
    function check() {
        for (const project of projects) {
            const outDir = path.resolve(root, project.outDir);
            if (isInside(path.join(root, ".git"), outDir))
                throw new Error(`Unsafe --force for ${project.name}: outDir ${outDir} is inside repository metadata.`);
            for (const protectedPath of [...directories, ...files])
                if (isInside(outDir, protectedPath))
                    throw new Error(`Unsafe --force for ${project.name}: outDir ${outDir} contains protected input ${protectedPath}.`);
            if (project.tsbuildinfo != null)
                assertSafeTsbuildinfo(project, root, [...directories, ...files], "Unsafe --force");
        }
    }
    check();
    function checkSourceFiles(directory, project) {
        if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
            return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory())
                checkSourceFiles(file, project);
            else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\.(?:ts|mts|cts)$/.test(entry.name))
                throw new Error(`Unsafe --force for ${project.name}: outDir contains source file ${file}.`);
        }
    }
    // The compiler normally excludes its outDir. A typo must not make existing
    // source files disappear from both the input list and this safety check.
    for (const project of projects)
        checkSourceFiles(path.resolve(root, project.outDir), project);
    for (const project of config.projects) {
        const inputs = programFiles(project, options.compiler, root);
        dependencies.set(project.name, inputs);
        for (const file of Object.keys(scanInputs(project, root, inputs)))
            files.add(file);
    }
    check();
    return dependencies;
}

module.exports = { forceInputs, assertSafeTsbuildinfo, assertNonForceTsbuildinfo };
