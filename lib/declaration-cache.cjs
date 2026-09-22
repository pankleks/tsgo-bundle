const
    { path, stamp, hashFile } = require("./util.cjs"),
    { emittedFor } = require("./merge.cjs"),
    { inputsMatch, snapshotWithHashes } = require("./state.cjs");

function declarationInputs(project, sources, root) {
    const inputs = {};
    for (const source of sources) {
        const emitted = emittedFor(project, source, ".d.ts", root);
        inputs[emitted] = stamp(emitted);
        inputs[emitted + ".map"] = stamp(emitted + ".map");
    }
    return inputs;
}

function declarationOutputs(project, root) {
    const output = path.resolve(root, project.dts);
    return { [output]: hashFile(output), [output + ".map"]: hashFile(output + ".map") };
}

function canReuseDeclarations(project, sources, inputs, previous, root) {
    // Embedded source content can change without any declaration emit changing.
    if (project.sourcesContent === true || previous == null || JSON.stringify(sources) !== previous.order)
        return false;
    if (Object.values(inputs).some(value => value == null) || !inputsMatch(previous.inputs, inputs))
        return false;
    const outputs = declarationOutputs(project, root);
    return Object.entries(outputs).every(([file, hash]) => hash != null && hash === previous.outputs?.[file]);
}

function declarationSnapshot(project, sources, inputs, previous, root, emittedHashes) {
    return { order: JSON.stringify(sources), inputs: emittedHashes || snapshotWithHashes(inputs, previous?.inputs), outputs: declarationOutputs(project, root) };
}

module.exports = { declarationInputs, canReuseDeclarations, declarationSnapshot };
