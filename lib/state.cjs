const { fs, path, stamp, hashFile, writeChanged } = require("./util.cjs");

function isSourceFile(file, testOnly) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts"))
        return false;
    return !testOnly || file.endsWith(".test.ts");
}

// Fast up-to-date check (like tsc -b): snapshot mtimes/sizes of every program
// input. Skips the tsgo invocation entirely when nothing changed.
function scanInputs(project, root) {
    const files = {};
    const collect = (directory, testOnly) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === ".build" || entry.name.startsWith("."))
                continue;
            const full = path.join(directory, entry.name);
            if (entry.isDirectory())
                collect(full, testOnly);
            else if (isSourceFile(full, testOnly))
                files[full] = stamp(full);
        }
    };
    for (const scan of project.scanDirs)
        collect(path.join(root, scan.dir), scan.testOnly === true);
    for (const extra of project.extraFiles || [])
        files[path.join(root, extra)] = stamp(path.join(root, extra));
    return files;
}

function loadState(stateFile, version) {
    try {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (state.version === version)
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

function outputsExist(project, root) {
    const files = [path.join(root, project.js), path.join(root, project.js) + ".map"];
    if (project.mapStyle === "inline")
        files.pop();
    if (project.dts != null)
        files.push(path.join(root, project.dts), path.join(root, project.dts) + ".map");
    return files.every(file => fs.existsSync(file));
}

function isUpToDate(project, state, inputs, stamp, root) {
    const previous = state != null && state.compiler === stamp ? state.projects[project.name] : null;
    if (previous == null || !outputsExist(project, root))
        return false;
    const
        oldFiles = Object.keys(previous),
        newFiles = Object.keys(inputs);
    if (oldFiles.length !== newFiles.length)
        return false;
    // Fast path on mtime+size (like make); content hash only when they differ
    // (like tsc), so mere touches without content change still skip.
    return newFiles.every(file => {
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

function snapshotWithHashes(inputs) {
    const snapshot = {};
    for (const file of Object.keys(inputs)) {
        const current = inputs[file];
        snapshot[file] = current == null ? null : [current[0], current[1], hashFile(file)];
    }
    return snapshot;
}

function saveState(stateFile, state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeChanged(stateFile, JSON.stringify(state));
}

module.exports = { isSourceFile, scanInputs, loadState, compilerStamp, outputsExist, isUpToDate, snapshotWithHashes, saveState };
