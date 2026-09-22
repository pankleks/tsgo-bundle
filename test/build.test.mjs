import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import helpers from "./helpers.cjs";
import buildLib from "../lib/build.cjs";
import resolverLib from "../lib/resolve-compiler.cjs";

const
    { mkWorkspace, rmWorkspace } = helpers,
    { build, STATE_VERSION } = buildLib,
    { resolveCompiler } = resolverLib;

let compiler = null;
beforeAll(() => {
    compiler = resolveCompiler(process.cwd());
});

const SOURCES = {
    "b.ts": `/// <reference path="a.ts" />\nnamespace App {\n    export class Sub extends Base {}\n}\n`,
    "a.ts": `namespace App {\n    export class Base {}\n}\n`,
};

function config(root, extraOptions) {
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "es2020", types: [], outDir: "out", rootDir: ".",
            declaration: true, declarationMap: true, sourceMap: true,
            ...extraOptions,
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
    test("reuses declarations for implementation-only changes but refreshes changed or damaged artifacts", { timeout: 30000 }, () => {
        const workspace = mkWorkspace({ "a.ts": "namespace App { export function value(): number { return 111; } }" });
        const cfg = config(workspace), options = { root: workspace, compiler }, logs = vi.spyOn(console, "log").mockImplementation(() => { });
        const source = path.join(workspace, "a.ts"), output = path.join(workspace, "dist/bundle.d.ts");
        try {
            build(cfg, options);
            logs.mockClear();
            fs.writeFileSync(source, "namespace App { export function value(): number { return 222; } }");
            build(cfg, options);
            expect(logs.mock.calls.flat().some(line => line.includes("bundle d.ts (unchanged, reused)"))).toBe(true);
            expect(fs.readFileSync(path.join(workspace, "dist/bundle.js"), "utf8")).toContain("return 222");
            fs.writeFileSync(output, "damaged");
            fs.writeFileSync(source, "namespace App { export function value(): number { return 333; } }");
            build(cfg, options);
            expect(fs.readFileSync(output, "utf8")).toContain("value(): number");
            fs.writeFileSync(source, "namespace App { export function value(): string { return 'changed'; } }");
            build(cfg, options);
            expect(fs.readFileSync(output, "utf8")).toContain("value(): string");
            cfg.projects[0].sourcesContent = true;
            build(cfg, options);
            logs.mockClear();
            fs.writeFileSync(source, "namespace App { export function value(): string { return 'updated source'; } }");
            build(cfg, options);
            expect(logs.mock.calls.flat().some(line => line.includes("unchanged, reused"))).toBe(false);
            expect(JSON.parse(fs.readFileSync(output + ".map", "utf8")).sourcesContent.join("")).toContain("updated source");
        }
        finally {
            logs.mockRestore();
            rmWorkspace(workspace);
        }
    });
    let root = null;
    afterAll(() => {
        if (root != null)
            rmWorkspace(root);
    });

    test("compiler error keeps failing until fixed (emit despite errors)", { timeout: 180000 }, () => {
        root = mkWorkspace(SOURCES);
        const options = { root, compiler, only: [], watch: false, force: true };
        build(config(root), options);
        const js = path.join(root, "dist/bundle.js"), before = fs.readFileSync(js, "utf8");
        fs.writeFileSync(path.join(root, "bad.ts"), `namespace App {\n    export const bad: number = "nope";\n}\n`);
        const retry = { root, compiler, only: [], watch: false, force: false };
        expect(() => build(config(root), retry)).toThrow(/tsc failed for M/);
        expect(fs.readFileSync(js, "utf8")).toContain('App.bad = "nope"');
        expect(JSON.parse(fs.readFileSync(path.join(root, ".build-state/buildstate.json"), "utf8")).projects.M).toBeUndefined();
        // A still-broken build must fail again, never silently skip as green.
        expect(() => build(config(root), retry)).toThrow(/tsc failed for M/);
        fs.rmSync(path.join(root, "bad.ts"));
        build(config(root), retry);
        expect(fs.readFileSync(js, "utf8")).toBe(before);
        rmWorkspace(root);
        root = null;
    }, 180000);

    test("compiler error with noEmitOnError keeps last bundles", { timeout: 180000 }, () => {
        root = mkWorkspace(SOURCES);
        const options = { root, compiler, only: [], watch: false, force: true };
        build(config(root, { noEmitOnError: true }), options);
        const
            js = path.join(root, "dist/bundle.js"),
            before = fs.readFileSync(js, "utf8");
        fs.writeFileSync(path.join(root, "bad.ts"), `namespace App {\n    export const bad: number = "nope";\n}\n`);
        const retry = { root, compiler, only: [], watch: false, force: false };
        // Nothing is emitted on error, so the bundle step reports the missing
        // emit instead of the tsc failure; either way it must stay loud.
        expect(() => build(config(root, { noEmitOnError: true }), retry)).toThrow(/tsc failed for M|Missing emit/);
        expect(fs.readFileSync(js, "utf8")).toBe(before);
        fs.rmSync(path.join(root, "bad.ts"));
        build(config(root, { noEmitOnError: true }), retry);
        expect(fs.readFileSync(js, "utf8")).toBe(before);
        rmWorkspace(root);
        root = null;
    }, 180000);

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

    test("compiler invalidation stays per project across --only builds", { timeout: 30000 }, () => {
        root = mkWorkspace(SOURCES);
        const cfg = config(root), options = { root, compiler }, logs = vi.spyOn(console, "log").mockImplementation(() => { });
        cfg.projects.push({ ...cfg.projects[0], name: "B", js: "dist/b.js", dts: "dist/b.d.ts" });
        try {
            build(cfg, options);
            const stateFile = path.join(root, cfg.stateFile), state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            expect(state.version).toBe(STATE_VERSION);
            state.projects.M.compiler = "old";
            state.projects.B.compiler = "old";
            fs.writeFileSync(stateFile, JSON.stringify(state));
            build(cfg, { ...options, only: ["M"] });
            expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).projects.B.compiler).toBe("old");
            logs.mockClear();
            build(cfg, options);
            expect(logs.mock.calls.flat()).toContain("[M] up to date, skipping.");
            expect(logs.mock.calls.flat()).toContain("Building B with TypeScript");
            expect(logs.mock.calls.flat()).not.toContain("[B] up to date, skipping.");
            logs.mockClear();
            build(cfg, options);
            expect(logs.mock.calls.flat()).toContain("[B] up to date, skipping.");
        }
        finally {
            logs.mockRestore();
            rmWorkspace(root);
            root = null;
        }
    });

    test("sourcesContent and mapStyle changes refresh artifacts", { timeout: 30000 }, () => {
        root = mkWorkspace(SOURCES);
        const cfg = config(root), options = { root, compiler };
        build(cfg, options);
        cfg.projects[0].sourcesContent = true;
        build(cfg, options);
        const map = JSON.parse(fs.readFileSync(path.join(root, "dist/bundle.js.map"), "utf8"));
        expect(map.sourcesContent).toContain(SOURCES["a.ts"]);
        cfg.projects[0].mapStyle = "inline";
        build(cfg, options);
        expect(fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8")).toContain("sourceMappingURL=data:application/json;base64,");
        rmWorkspace(root);
        root = null;
    });

    test("tsconfig and inherited config changes rebuild without extraFiles", { timeout: 30000 }, () => {
        root = mkWorkspace({ "a.ts": '// retained-comment\nnamespace App { export const greeting = "hello"; }' });
        const cfg = config(root), options = { root, compiler };
        cfg.projects[0].extraFiles = [];
        const tsconfigFile = path.join(root, "tsconfig.json"), tsconfig = JSON.parse(fs.readFileSync(tsconfigFile, "utf8"));
        tsconfig.extends = "./base.json";
        fs.writeFileSync(tsconfigFile, JSON.stringify(tsconfig));
        fs.writeFileSync(path.join(root, "base.json"), '{ "compilerOptions": { "removeComments": false } }');
        build(cfg, options);
        expect(fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8")).toContain("retained-comment");
        fs.writeFileSync(path.join(root, "base.json"), '{ "compilerOptions": { "removeComments": true } }');
        build(cfg, options);
        expect(fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8")).not.toContain("retained-comment");
        tsconfig.compilerOptions.removeComments = false;
        fs.writeFileSync(tsconfigFile, JSON.stringify(tsconfig));
        build(cfg, options);
        expect(fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8")).toContain("retained-comment");
        rmWorkspace(root);
        root = null;
    });

    test("compiler-discovered declarations outside scanDirs invalidate the cache", { timeout: 30000 }, () => {
        root = mkWorkspace({
            "src/a.ts": '/// <reference path="../types/api.d.ts" />\nnamespace App { export const value: ApiValue = 123; }',
            "types/api.d.ts": "type ApiValue = number;",
        });
        const cfg = config(root), options = { root, compiler };
        cfg.projects[0].scanDirs = [{ dir: "src" }];
        build(cfg, options);
        const state = JSON.parse(fs.readFileSync(path.join(root, cfg.stateFile), "utf8"));
        expect(state.projects.M.dependencies).toContain(path.join(root, "types/api.d.ts"));
        fs.writeFileSync(path.join(root, "types/api.d.ts"), "type ApiValue = string;");
        expect(() => build(cfg, options)).toThrow(/tsc failed/);
        rmWorkspace(root);
        root = null;
    });

    test("package metadata redirects declarations and invalidates the cache", { timeout: 30000 }, () => {
        root = mkWorkspace({
            "a.ts": "namespace App { export const value: ApiValue = 123; }",
            "node_modules/api/package.json": '{ "name": "api", "types": "number.d.ts" }',
            "node_modules/api/number.d.ts": "type ApiValue = number;",
            "node_modules/api/string.d.ts": "type ApiValue = string;",
        });
        const cfg = config(root, { types: ["api"] }), options = { root, compiler };
        build(cfg, options);
        fs.writeFileSync(path.join(root, "node_modules/api/package.json"), '{ "name": "api", "types": "string.d.ts" }');
        expect(() => build(cfg, options)).toThrow(/tsc failed/);
        rmWorkspace(root);
        root = null;
    });

    test("edits during a build are not cached as already emitted", { timeout: 30000 }, () => {
        root = mkWorkspace(SOURCES);
        const cfg = config(root), options = { root, compiler };
        const logs = vi.spyOn(console, "log").mockImplementation(message => {
            if (message.startsWith("[M] tsc emit:"))
                fs.writeFileSync(path.join(root, "a.ts"), SOURCES["a.ts"].replace("export class Base {}", "export class Base { changed = 1; }"));
        });
        try {
            build(cfg, options);
            expect(JSON.parse(fs.readFileSync(path.join(root, cfg.stateFile), "utf8")).projects.M).toBeUndefined();
            expect(fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8")).not.toContain("changed");
            logs.mockImplementation(() => { });
            build(cfg, options);
            expect(fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8")).toContain("changed");
        }
        finally {
            logs.mockRestore();
            rmWorkspace(root);
            root = null;
        }
    });
});
