// Fixture workspaces in tmp (never committed, no writes to the repo).
const
    fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path");

function mkWorkspace(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsgo-bundle-test-"));
    for (const [rel, content] of Object.entries(files))
        fs.writeFileSync(path.join(root, rel), content);
    return root;
}

function writeTsconfig(root, extra) {
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2020", types: [], ...extra },
        include: ["**/*.ts"],
    }));
}

function rmWorkspace(root) {
    fs.rmSync(root, { recursive: true, force: true });
}

module.exports = { mkWorkspace, writeTsconfig, rmWorkspace };
