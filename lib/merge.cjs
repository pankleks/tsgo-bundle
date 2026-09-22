const
    { decode, encode } = require("@jridgewell/sourcemap-codec"),
    { fs, path, relativeTo, stripComments, writeChanged } = require("./util.cjs");

function emittedFor(project, source, extension, root) {
    return path.join(root, project.outDir, path.relative(path.join(root, project.rootDir), source).replace(/\.ts$/, extension));
}

// Global-script projects concatenate plain-text emit. A single top-level
// import/export turns its file into a module, which silently breaks the
// bundle at runtime - fail the build loudly instead.
function assertGlobalScript(text, project, source, root) {
    if (/^(import|export)\s/m.test(stripComments(text)))
        throw new Error(`ES module syntax in ${project.name}: ${relativeTo(root, source)} has a top-level import/export. Remove it or the concatenated bundle breaks at runtime.`);
}

function bundle(project, sources, extension, output, root) {
    const
        sourcesTable = [],
        sourceIndexes = new Map(),
        namesTable = [],
        nameIndexes = new Map(),
        merged = [],
        chunks = [];
    let lineOffset = 0;

    const intern = (table, indexes, value) => {
        let index = indexes.get(value);
        if (index === undefined) {
            index = table.length;
            table.push(value);
            indexes.set(value, index);
        }
        return index;
    };

    for (const source of sources) {
        const
            emitted = emittedFor(project, source, extension, root);
        if (!fs.existsSync(emitted))
            throw new Error(`Missing emit for ${relativeTo(root, source)} (expected ${relativeTo(root, emitted)}).`);
        const
            text = fs.readFileSync(emitted, "utf8").replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, ""),
            chunk = text.endsWith("\n") ? text : text + "\n",
            parsed = JSON.parse(fs.readFileSync(emitted + ".map", "utf8")),
            // Rebase once per file instead of once per segment.
            translatedSources = parsed.sources.map(original => path.relative(path.dirname(output), path.resolve(path.dirname(emitted), parsed.sourceRoot || "", original)).split(path.sep).join("/")),
            lines = decode(parsed.mappings);
        if (extension === ".js")
            assertGlobalScript(text, project, source, root);
        for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            for (const seg of line) {
                if (seg.length === 1)
                    continue;
                seg[1] = intern(sourcesTable, sourceIndexes, translatedSources[seg[1]]);
                if (seg.length === 5)
                    seg[4] = intern(namesTable, nameIndexes, parsed.names[seg[4]]);
            }
            merged[li + lineOffset] = line;
        }
        chunks.push(chunk);
        lineOffset += chunk.split("\n").length - 1;
    }

    for (let i = 0; i < merged.length; i++)
        if (merged[i] === undefined)
            merged[i] = [];
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const encoded = JSON.stringify({ version: 3, file: path.basename(output), names: namesTable, sources: sourcesTable, mappings: encode(merged), ignoreList: [] });
    // Library maps stay inline so the distributed scripts are self-contained.
    if (extension === ".js" && project.mapStyle === "inline") {
        chunks.push("//# sourceMappingURL=data:application/json;base64," + Buffer.from(encoded).toString("base64") + "\n");
        writeChanged(output, chunks.join(""));
    }
    else {
        writeChanged(output + ".map", encoded);
        chunks.push("//# sourceMappingURL=" + path.basename(output) + ".map\n");
        writeChanged(output, chunks.join(""));
    }
}

module.exports = { emittedFor, assertGlobalScript, bundle };
