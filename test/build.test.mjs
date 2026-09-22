import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import helpers from "./helpers.cjs";
import buildLib from "../lib/build.cjs";
import resolverLib from "../lib/resolve-compiler.cjs";

const
    { mkWorkspace, rmWorkspace } = helpers,
    { build } = buildLib,
    { resolveCompiler } = resolverLib;

let compiler = null;
beforeAll(() => {
    compiler = resolveCompiler(process.cwd());
});

const SOURCES = {
    "b.ts": `/// <reference path="a.ts" />\nnamespace App {\n    export class Sub extends Base {}\n}\n`,
    "a.ts": `namespace App {\n    export class Base {}\n}\n`,
};

function config(root) {
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "es2020", types: [], outDir: "out", rootDir: ".",
            declaration: true, declarationMap: true, sourceMap: true,
        },
        include: ["**/*.ts"],
        // Bundled outputs live inside the workspace and must stay out of the
        // program (out/ is excluded automatically as outDir, dist/ is not).
        exclude: ["dist", "out"],
    }));
    return {
        stateFile: ".build-state/buildstate.json",
        projects: [{
            name: "M", tsconfig: "tsconfig.json", projectDir: ".", rootDir: ".",
            outDir: "out", js: "dist/bundle.js", dts: "dist/bundle.d.ts",
            mapStyle: "external", tsbuildinfo: "out.tsbuildinfo",
            scanDirs: [{ dir: "." }], extraFiles: ["tsconfig.json"],
        }],
    };
}

describe("build integration", () => {
    let root = null;
    afterAll(() => {
        if (root != null)
            rmWorkspace(root);
    });

    test("force build, skip, and rebuild on change", { timeout: 180000 }, () => {
        root = mkWorkspace(SOURCES);
        const options = { root, compiler, only: [], watch: false, force: true };
        build(config(root), options);
        const
            js = path.join(root, "dist/bundle.js"),
            dts = path.join(root, "dist/bundle.d.ts");
        expect(fs.existsSync(js)).toBe(true);
        expect(fs.existsSync(js + ".map")).toBe(true);
        expect(fs.existsSync(dts)).toBe(true);
        const text = fs.readFileSync(js, "utf8");
        expect(text.indexOf("Sub")).toBeGreaterThan(-1);
        // Base must evaluate before Sub (heritage order).
        expect(text.indexOf("App.Base = Base")).toBeLessThan(text.indexOf("extends App.Base"));

        const mtime = fs.statSync(js).mtimeMs;
        build(config(root), { ...options, force: false });
        expect(fs.statSync(js).mtimeMs).toBe(mtime);

        fs.writeFileSync(path.join(root, "a.ts"), SOURCES["a.ts"].replace("export class Base {}", "export class Base { x = 1; }"));
        build(config(root), { ...options, force: false });
        expect(fs.statSync(js).mtimeMs).toBeGreaterThan(mtime);
        rmWorkspace(root);
        root = null;
    }, 180000);
});
