const
    { fs, path } = require("./util.cjs"),
    { configInputs } = require("./config-inputs.cjs");

function containsPath(directory, file) {
    const relative = path.relative(directory, file);
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function isSourceFile(file, testOnly) {
    return file.endsWith(".ts") && (!testOnly || file.endsWith(".test.ts") || file.endsWith(".d.ts"));
}

// One description of inputs for both the cache scan and watch subscriptions.
function inputModel(project, root, dependencies = [], tolerateConfigErrors = false) {
    const
        tsconfig = path.resolve(root, project.tsconfig),
        files = new Set([tsconfig, ...(project.extraFiles || []), ...dependencies].map(file => path.resolve(root, file))),
        directories = new Set();
    try {
        configInputs(tsconfig, file => files.add(file));
    }
    catch (error) {
        if (!tolerateConfigErrors)
            throw error;
        // Keep watching configs already visited so fixing invalid JSON recovers.
    }
    for (const file of [tsconfig, ...dependencies.map(file => path.resolve(root, file))]) {
        let directory = path.dirname(file);
        while (!directories.has(directory)) {
            directories.add(directory);
            files.add(path.join(directory, "package.json"));
            const parent = path.dirname(directory);
            if (parent === directory)
                break;
            directory = parent;
        }
    }
    for (const name of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"])
        files.add(path.resolve(root, name));
    return {
        files,
        scans: project.scanDirs.map(scan => ({ dir: path.resolve(root, scan.dir), testOnly: scan.testOnly === true })),
        outDir: path.resolve(root, project.outDir),
        outputs: new Set([project.js, project.dts, project.tsbuildinfo].filter(file => file != null).flatMap(file => [path.resolve(root, file), path.resolve(root, file) + ".map"])),
    };
}

function isScannedPath(model, scan, file) {
    if (!containsPath(scan.dir, file) || containsPath(model.outDir, file) || model.outputs.has(file))
        return false;
    return !path.relative(scan.dir, file).split(path.sep).some(part => part === "node_modules" || part.startsWith("."));
}

function affectsInputs(model, event) {
    const file = path.resolve(event.path);
    // Explicit dependencies are honored even in hidden/output/node_modules trees.
    for (const input of model.files)
        if (input === file || (event.type !== "update" && containsPath(file, input)))
            return true;
    return model.scans.some(scan => {
        if (event.type !== "update" && containsPath(file, scan.dir))
            return true;
        if (!isScannedPath(model, scan, file))
            return false;
        if (isSourceFile(file, scan.testOnly))
            return true;
        // Directory additions/renames can arrive without individual child events.
        return event.type === "delete" || (event.type === "create" && fs.statSync(file, { throwIfNoEntry: false })?.isDirectory() === true);
    });
}

module.exports = { containsPath, isSourceFile, inputModel, isScannedPath, affectsInputs };
