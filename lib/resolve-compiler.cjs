const
    fs = require("node:fs"),
    path = require("node:path");

const candidates = [
    ["@typescript/native-preview", "bin/tsgo"],
    ["typescript", "bin/tsgo"],
    ["typescript", "bin/tsc"],
];

function resolveCompiler(fromDirectory) {
    for (const [pkg, bin] of candidates) {
        let directory = null;
        try {
            directory = path.dirname(require.resolve(pkg + "/package.json", { paths: [fromDirectory, __dirname] }));
        }
        catch {
            continue;
        }
        const full = path.join(directory, bin);
        if (fs.existsSync(full))
            return full;
    }
    throw new Error("No TypeScript compiler found. Install \"@typescript/native-preview\" (or a future stable \"typescript\" with the native compiler).");
}

module.exports = { resolveCompiler };
