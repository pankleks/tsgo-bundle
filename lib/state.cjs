const
    { createHash } = require("node:crypto"),
    { fs, path, stamp, hashFile, writeChanged } = require("./util.cjs"),
    { isSourceFile, inputModel, isScannedPath } = require("./inputs.cjs");

// Fast up-to-date check (like tsc -b): snapshot mtimes/sizes of every program
// input. Skips the tsc invocation entirely when nothing changed.
function scanInputs(project, root, dependencies = []) {
    const
        files = {},
        model = inputModel(project, root, dependencies);
    const collect = (directory, scan) => {
        if (!isScannedPath(model, scan, directory))
            return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (!isScannedPath(model, scan, full))
                continue;
            if (entry.isDirectory())
                collect(full, scan);
            else if (isSourceFile(full, scan.testOnly))
                files[full] = stamp(full);
        }
    };
    for (const scan of model.scans)
        collect(scan.dir, scan);
    for (const full of model.files) {
        // Config resolution probes may be directories, which are not hashable inputs.
        const stat = fs.statSync(full, { throwIfNoEntry: false });
        files[full] = stat?.isFile() ? [stat.mtimeMs, stat.size] : null;
    }
    return files;
}

function loadState(stateFile, version) {
    try {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (state != null && state.version === version && state.projects != null && typeof state.projects === "object" && !Array.isArray(state.projects))
            return state;
    }
    catch {
        // Missing or corrupt state means a full rebuild.
    }
    return null;
}

function compilerStamp(compilerVersion, bundlerVersion) {
    return compilerVersion + "|" + bundlerVersion;
}

function projectFingerprint(project) {
    function canonical(value) {
        if (Array.isArray(value))
            return value.map(canonical);
        if (value != null && typeof value === "object")
            return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
        return value;
    }
    return createHash("sha256").update(JSON.stringify(canonical(project))).digest("hex");
}

function outputsExist(project, root) {
    const files = [path.join(root, project.js), path.join(root, project.js) + ".map"];
    if (project.mapStyle === "inline")
        files.pop();
    if (project.dts != null)
        files.push(path.join(root, project.dts), path.join(root, project.dts) + ".map");
    return files.every(file => fs.existsSync(file));
}

function isUpToDate(project, state, inputs, stamp, root) {
    const previous = state?.projects?.[project.name];
    if (previous == null || previous.compiler !== stamp || previous.config !== projectFingerprint(project) || !outputsExist(project, root))
        return false;
    return inputsMatch(previous.inputs, inputs);
}

function inputsMatch(previous, inputs) {
    if (previous == null)
        return false;
    const
        oldFiles = Object.keys(previous),
        newFiles = Object.keys(inputs);
    if (oldFiles.length !== newFiles.length)
        return false;
    // Fast path on mtime+size (like make); content hash only when they differ
    // (like tsc), so mere touches without content change still skip.
    return newFiles.every(file => {
        if (!Object.hasOwn(previous, file))
            return false;
        const
            entry = previous[file],
            current = inputs[file];
        if (entry == null || current == null)
            return entry == null && current == null;
        if (entry[0] === current[0] && entry[1] === current[1])
            return true;
        return entry[2] != null && entry[2] === hashFile(file);
    });
}

function snapshotWithHashes(inputs, previous) {
    const snapshot = {};
    for (const file of Object.keys(inputs)) {
        const current = inputs[file], old = previous?.[file];
        // Same metadata fast path as inputsMatch; never reuse a failed hash.
        const reusable = current != null && old != null && old[2] != null && current[0] === old[0] && current[1] === old[1];
        snapshot[file] = current == null ? null : [current[0], current[1], reusable ? old[2] : hashFile(file)];
    }
    return snapshot;
}

function saveState(stateFile, state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeChanged(stateFile, JSON.stringify(state));
}

module.exports = { isSourceFile, scanInputs, loadState, compilerStamp, projectFingerprint, outputsExist, isUpToDate, inputsMatch, snapshotWithHashes, saveState };
