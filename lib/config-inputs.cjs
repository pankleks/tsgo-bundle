const { fs, path } = require("./util.cjs");

function readConfig(file) {
    // Preserve strings (including URLs and escaped quotes) while removing
    // JSONC comments and trailing commas. Do not use the source-code stripper.
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")
        .replace(/"(?:[^"\\]|\\[\s\S])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : " ")
        .replace(/"(?:[^"\\]|\\[\s\S])*"|,(\s*[}\]])/g, (token, closing) => closing || token);
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new Error(`Invalid config ${file}: ${error.message}`);
    }
}

// Resolve relative and package-based extends, recording even missing candidates:
// a newly added, higher-priority config must invalidate the previous resolution.
function configInputs(tsconfig, onInput) {
    const files = new Set(), visited = new Set();
    const existing = file => {
        files.add(file);
        if (onInput != null)
            onInput(file);
        return fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
    };
    function jsonFile(file) {
        if (existing(file))
            return file;
        if (!file.endsWith(".json") && existing(file + ".json"))
            return file + ".json";
        return null;
    }
    function resolve(base, directory) {
        if (path.isAbsolute(base) || base.startsWith("."))
            return jsonFile(path.resolve(directory, base));
        const parts = base.split("/"), count = base.startsWith("@") ? 2 : 1;
        for (;;) {
            const packageDir = path.join(directory, "node_modules", ...parts.slice(0, count));
            if (parts.length > count) {
                const found = jsonFile(path.join(packageDir, ...parts.slice(count)));
                if (found != null)
                    return found;
            }
            else {
                const manifest = path.join(packageDir, "package.json");
                if (existing(manifest)) {
                    const target = readConfig(manifest).tsconfig;
                    if (typeof target === "string") {
                        const found = jsonFile(path.resolve(packageDir, target));
                        if (found != null)
                            return found;
                    }
                }
                const found = jsonFile(path.join(packageDir, "tsconfig.json"));
                if (found != null)
                    return found;
            }
            const parent = path.dirname(directory);
            if (parent === directory)
                return null;
            directory = parent;
        }
    }
    function visit(file) {
        if (visited.has(file))
            return;
        visited.add(file);
        if (!existing(file))
            return;
        const config = readConfig(file), bases = config.extends == null ? [] : [].concat(config.extends);
        for (const base of bases) {
            if (typeof base !== "string")
                throw new Error(`Invalid extends in ${file}.`);
            const resolved = resolve(base, path.dirname(file));
            if (resolved != null)
                visit(resolved);
        }
    }
    visit(path.resolve(tsconfig));
    return [...files];
}

function commonJSInputs(file) {
    const files = new Set();
    function visit(id) {
        if (files.has(id))
            return;
        files.add(id);
        for (const child of require.cache[id]?.children || [])
            visit(child.id);
    }
    visit(file);
    return files;
}

module.exports = { configInputs, commonJSInputs };
