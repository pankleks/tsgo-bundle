import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import helpers from "./helpers.cjs";
import orderLib from "../lib/order.cjs";
import mergeLib from "../lib/merge.cjs";
import resolverLib from "../lib/resolve-compiler.cjs";
import { decode } from "@jridgewell/sourcemap-codec";

const
    { mkWorkspace, rmWorkspace } = helpers,
    { orderedSources } = orderLib,
    { bundle, assertGlobalScript, emittedFor } = mergeLib,
    { resolveCompiler } = resolverLib;

let compiler = null;
beforeAll(() => {
    compiler = resolveCompiler(process.cwd());
});

const SOURCES = {
    "a.ts": `namespace App {\n    export class Base {\n        greet() {\n            return "hi";\n        }\n    }\n}\n`,
    "b.ts": `/// <reference path="a.ts" />\nnamespace App {\n    export class Sub extends Base {\n        constructor() {\n            super();\n        }\n    }\n    export const answer = 41 + 1;\n}\n`,
    "c.ts": `/// <reference path="b.ts" />\nnamespace App {\n    export function run() {\n        return new Sub().greet() + App.answer;\n    }\n}\n`,
};

function tsconfig(extra) {
    return JSON.stringify({
        compilerOptions: {
            target: "es2020", types: [], outDir: "out", rootDir: ".",
            declaration: true, declarationMap: true, sourceMap: true,
            ...extra,
        },
        include: ["**/*.ts"],
    });
}

function emit(root) {
    fs.writeFileSync(path.join(root, "tsconfig.json"), tsconfig());
    const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
}

const baseProject = overrides => ({
    name: "M", tsconfig: "tsconfig.json", projectDir: ".", rootDir: ".", outDir: "out",
    js: "dist/bundle.js", dts: "dist/bundle.d.ts", mapStyle: "external",
    scanDirs: [{ dir: "." }], extraFiles: [], ...overrides,
});

function expectedChunks(root, project, order) {
    return order.map(source => {
        const emitted = path.join(root, project.outDir, path.relative(path.join(root, project.rootDir), source).replace(/\.ts$/, ".js"));
        const text = fs.readFileSync(emitted, "utf8").replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm, "");
        return text.endsWith("\n") ? text : text + "\n";
    });
}

// Every merged segment must equal its per-file segment shifted by chunk offset.
function expectFaithfulMap(root, project, order, jsFile, inlineMap) {
    const
        map = inlineMap || JSON.parse(fs.readFileSync(jsFile + ".map", "utf8")),
        merged = decode(map.mappings);
    let lineOffset = 0, checked = 0;
    for (const source of order) {
        const
            emitted = path.join(root, project.outDir, path.relative(path.join(root, project.rootDir), source).replace(/\.ts$/, ".js")),
            parsed = JSON.parse(fs.readFileSync(emitted + ".map", "utf8")),
            lines = decode(parsed.mappings),
            rebase = original => path.relative(path.dirname(jsFile), path.resolve(path.dirname(emitted), parsed.sourceRoot || "", original)).split(path.sep).join("/");
        for (let li = 0; li < lines.length; li++) {
            expect(merged[li + lineOffset].length).toBe(lines[li].length);
            for (let i = 0; i < lines[li].length; i++) {
                const [sa, sb] = [lines[li][i], merged[li + lineOffset][i]];
                const norm = (seg, sources, names) => seg.length === 1 ? seg : [seg[0], sources[seg[1]], seg[2], seg[3], ...(seg.length > 4 ? [names[seg[4]]] : [])];
                expect(norm(sb, map.sources, map.names)).toEqual(norm(sa, parsed.sources, parsed.names).map((v, k) => k === 1 ? rebase(parsed.sources[sa[1]]) : v));
                checked++;
            }
        }
        lineOffset += expectedChunks(root, project, [source])[0].split("\n").length - 1;
    }
    return checked;
}

describe("assertGlobalScript", () => {
    const cases = [
        ["export class", "export class Foo {}", true],
        ["export {}; marker", "export {};", true],
        ["export =", "export = Foo;", true],
        ["import from", "import x from \"y\";", true],
        ["import bare", "import \"y\";", true],
        ["export default", "export default 1;", true],
        ["export star", "export * from \"y\";", true],
        ["plain script", "\"use strict\";\nvar Pulsar;", false],
        ["commented export", "// export class Foo {}", false],
        ["block comment", "/*\nexport class Foo {}\n*/\nvar x = 1;", false],
        ["triple-slash ref", "/// <reference path=\"x\" />\nvar x = 1;", false],
        ["indented export", "(function (Pulsar) {\n    export class Foo {}\n})(Pulsar);", false],
        ["dynamic import", "const x = await import(\"y\");", false],
        ["property named export", "o.export = true;", false],
    ];
    for (const [label, text, throws] of cases)
        test(`guard ${throws ? "flags" : "passes"}: ${label}`, () => {
            const project = { name: "M" };
            if (throws)
                expect(() => assertGlobalScript(text, project, "/w/f.ts", "/w")).toThrow(/ES module syntax.*f\.ts/);
            else
                expect(() => assertGlobalScript(text, project, "/w/f.ts", "/w")).not.toThrow();
        });
});

describe("bundle", () => {
    let root = null;
    afterAll(() => {
        if (root != null)
            rmWorkspace(root);
    });

    test("js bundle is byte-identical concat with faithful map", { timeout: 120000 }, () => {
        root = mkWorkspace(SOURCES);
        emit(root);
        const
            project = baseProject(),
            order = orderedSources(project, compiler, root, () => { });
        bundle(project, order, ".js", path.join(root, project.js), root);
        const
            expected = expectedChunks(root, project, order).join("") + `//# sourceMappingURL=${path.basename(project.js)}.map\n`,
            actual = fs.readFileSync(path.join(root, project.js), "utf8");
        expect(actual).toBe(expected);
        expect(expectFaithfulMap(root, project, order, path.join(root, project.js))).toBeGreaterThan(10);
        rmWorkspace(root);
        root = null;
    });

    test("d.ts bundle merges declarations", { timeout: 120000 }, () => {
        root = mkWorkspace(SOURCES);
        emit(root);
        const
            project = baseProject(),
            order = orderedSources(project, compiler, root, () => { });
        bundle(project, order, ".d.ts", path.join(root, project.dts), root);
        const dts = fs.readFileSync(path.join(root, project.dts), "utf8");
        expect(dts).toContain("Sub");
        expect(dts).toContain("answer");
        expect(fs.existsSync(path.join(root, project.dts + ".map"))).toBe(true);
        rmWorkspace(root);
        root = null;
    });

    test("inline mapStyle embeds the map without a .map file", { timeout: 120000 }, () => {
        root = mkWorkspace(SOURCES);
        emit(root);
        const
            project = baseProject({ js: "dist/inline.js", mapStyle: "inline" }),
            order = orderedSources(project, compiler, root, () => { });
        bundle(project, order, ".js", path.join(root, project.js), root);
        const text = fs.readFileSync(path.join(root, project.js), "utf8");
        expect(text).toMatch(/^\/\/# sourceMappingURL=data:application\/json;base64,/m);
        expect(fs.existsSync(path.join(root, project.js + ".map"))).toBe(false);
        const map = JSON.parse(Buffer.from(text.match(/^\/\/# sourceMappingURL=data:application\/json;base64,(.+)$/m)[1], "base64").toString("utf8"));
        expect(map.sources.length).toBeGreaterThan(0);
        expect(expectFaithfulMap(root, project, order, path.join(root, project.js), map)).toBeGreaterThan(10);
        rmWorkspace(root);
        root = null;
    });

    test("module file fails the bundle loudly", { timeout: 120000 }, () => {
        root = mkWorkspace({ ...SOURCES, "m.ts": `export const x = 1;\n` });
        emit(root);
        const
            project = baseProject(),
            order = orderedSources(project, compiler, root, () => { });
        expect(() => bundle(project, order, ".js", path.join(root, project.js), root)).toThrow(/ES module syntax.*m\.ts/);
        rmWorkspace(root);
        root = null;
    });

    test("sourcesContent embeds on-disk sources when enabled, omitted otherwise", { timeout: 120000 }, () => {
        root = mkWorkspace(SOURCES);
        emit(root);
        const
            order = orderedSources(baseProject(), compiler, root, () => { }),
            withContent = path.join(root, "dist/content.js"),
            plain = path.join(root, "dist/plain.js");
        bundle(baseProject({ js: "dist/content.js", sourcesContent: true }), order, ".js", withContent, root);
        bundle(baseProject({ js: "dist/plain.js" }), order, ".js", plain, root);
        const
            embedded = JSON.parse(fs.readFileSync(withContent + ".map", "utf8")),
            omitted = JSON.parse(fs.readFileSync(plain + ".map", "utf8"));
        expect(embedded.sourcesContent).toHaveLength(embedded.sources.length);
        for (let i = 0; i < embedded.sources.length; i++)
            expect(embedded.sourcesContent[i]).toBe(fs.readFileSync(path.resolve(path.dirname(withContent), embedded.sources[i]), "utf8"));
        expect("sourcesContent" in omitted).toBe(false);
        rmWorkspace(root);
        root = null;
    });

    test("missing emit fails with a clear path", () => {
        expect(() => bundle(baseProject(), ["/w/missing.ts"], ".js", "/w/out.js", "/w")).toThrow(/Missing emit/);
    });

    test("emittedFor maps sources through rootDir", () => {
        const project = { outDir: "out", rootDir: "src" };
        expect(emittedFor(project, "/w/src/a/b.ts", ".js", "/w").split(path.sep).join("/")).toBe("/w/out/a/b.js");
    });
});
