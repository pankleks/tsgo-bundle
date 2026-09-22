import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import helpers from "./helpers.cjs";
import stateLib from "../lib/state.cjs";
import buildLib from "../lib/build.cjs";

const
    { mkWorkspace, rmWorkspace } = helpers,
    { scanInputs, loadState, isUpToDate, projectFingerprint, snapshotWithHashes, saveState, outputsExist } = stateLib,
    { selectedProjects, validateConfig } = buildLib;

const project = overrides => ({
    name: "S", tsconfig: "tsconfig.json", projectDir: ".", rootDir: ".", outDir: "out",
    js: "dist/bundle.js", dts: null, mapStyle: "external",
    scanDirs: [{ dir: "." }], extraFiles: ["tsconfig.json"], ...overrides,
});

describe("state", () => {
    test("save/load roundtrip, corrupt file means rebuild", () => {
        const root = mkWorkspace({ "a.ts": `namespace N { export const a = 1; }\n` });
        const stateFile = path.join(root, "state.json");
        expect(loadState(stateFile, 1)).toBe(null);
        fs.writeFileSync(stateFile, "not json{{{");
        expect(loadState(stateFile, 1)).toBe(null);
        fs.writeFileSync(stateFile, JSON.stringify({ version: 999, projects: {} }));
        expect(loadState(stateFile, 1)).toBe(null);
        saveState(stateFile, { version: 1, compiler: "x", projects: { S: {} } });
        expect(loadState(stateFile, 1).compiler).toBe("x");
        rmWorkspace(root);
    });

    test("unchanged and touched inputs skip, changed inputs rebuild", () => {
        const
            root = mkWorkspace({ "a.ts": `namespace N { export const a = 1; }\n` }),
            proj = project(),
            stamp = "test-stamp";
        fs.mkdirSync(path.join(root, "dist"), { recursive: true });
        fs.writeFileSync(path.join(root, proj.js), "x");
        fs.writeFileSync(path.join(root, proj.js + ".map"), "x");
        const snapshot = snapshotWithHashes(scanInputs(proj, root));
        const state = { version: 2, projects: { S: { compiler: stamp, config: projectFingerprint(proj), inputs: snapshot } } };
        expect(isUpToDate(proj, state, scanInputs(proj, root), stamp, root)).toBe(true);

        // Touch without content change still skips (hash-checked like tsc).
        const now = new Date(Date.now() + 5000);
        fs.utimesSync(path.join(root, "a.ts"), now, now);
        expect(isUpToDate(proj, state, scanInputs(proj, root), stamp, root)).toBe(true);

        // Real change rebuilds.
        fs.writeFileSync(path.join(root, "a.ts"), `namespace N { export const a = 2; }\n`);
        expect(isUpToDate(proj, state, scanInputs(proj, root), stamp, root)).toBe(false);
        rmWorkspace(root);
    });

    test("added/deleted files, missing outputs and compiler change rebuild", () => {
        const
            root = mkWorkspace({ "a.ts": `namespace N { export const a = 1; }\n` }),
            proj = project(),
            stamp = "test-stamp";
        fs.mkdirSync(path.join(root, "dist"), { recursive: true });
        fs.writeFileSync(path.join(root, proj.js), "x");
        fs.writeFileSync(path.join(root, proj.js + ".map"), "x");
        const state = { version: 2, projects: { S: { compiler: stamp, config: projectFingerprint(proj), inputs: snapshotWithHashes(scanInputs(proj, root)) } } };
        expect(outputsExist(proj, root)).toBe(true);

        fs.writeFileSync(path.join(root, "b.ts"), `namespace N { export const b = 1; }\n`);
        expect(isUpToDate(proj, state, scanInputs(proj, root), stamp, root)).toBe(false);

        fs.rmSync(path.join(root, "b.ts"));
        expect(isUpToDate(proj, state, scanInputs(proj, root), stamp, root)).toBe(true);
        expect(isUpToDate(proj, state, scanInputs(proj, root), "other", root)).toBe(false);
        fs.rmSync(path.join(root, "a.ts"));
        expect(isUpToDate(proj, state, scanInputs(proj, root), stamp, root)).toBe(false);

        fs.rmSync(path.join(root, proj.js + ".map"));
        expect(isUpToDate(proj, state, scanInputs(proj, root), stamp, root)).toBe(false);
        expect(outputsExist(proj, root)).toBe(false);

        rmWorkspace(root);
    });

    test("project settings invalidate independently of input content", () => {
        const root = mkWorkspace({ "a.ts": "class A {}", "dist/bundle.js": "x", "dist/bundle.js.map": "x" });
        try {
            const proj = project(), inputs = scanInputs(proj, root);
            const state = { projects: { S: { compiler: "stamp", config: projectFingerprint(proj), inputs: snapshotWithHashes(inputs) } } };
            expect(isUpToDate(proj, state, inputs, "stamp", root)).toBe(true);
            for (const change of [{ sourcesContent: true }, { mapStyle: "inline" }, { rootDir: "src" }, { outDir: "new-out" }])
                expect(isUpToDate({ ...proj, ...change }, state, inputs, "stamp", root)).toBe(false);
            expect(projectFingerprint(Object.fromEntries(Object.entries(proj).reverse()))).toBe(projectFingerprint(proj));
        }
        finally {
            rmWorkspace(root);
        }
    });

    test("scan tracks declarations and inherited JSONC configs but excludes own outputs", () => {
        const root = mkWorkspace({
            "tsconfig.json": '\uFEFF{ /* comment */ "extends": ["./base", "./second.json",], }',
            "base.json": '{ "extends": "./shared.json", "compilerOptions": { "sourceRoot": "https://example.com/*literal*/", }, }',
            "second.json": '{ "compilerOptions": {}, // comment\n }',
            "shared.json": '{}',
            "types.d.ts": "declare const value: number;",
            "out/a.d.ts": "declare const emitted: number;",
            "dist/bundle.d.ts": "declare const bundled: number;",
        });
        try {
            const inputs = scanInputs(project({ extraFiles: [], dts: "dist/bundle.d.ts" }), root);
            for (const file of ["tsconfig.json", "base.json", "second.json", "shared.json", "types.d.ts"])
                expect(inputs[path.join(root, file)]).toBeTruthy();
            expect(Object.hasOwn(inputs, path.join(root, "out/a.d.ts"))).toBe(false);
            expect(Object.hasOwn(inputs, path.join(root, "dist/bundle.d.ts"))).toBe(false);
        }
        finally {
            rmWorkspace(root);
        }
    });

    test("scan resolves package extends and tracks the package manifest", () => {
        const root = mkWorkspace({
            "tsconfig.json": '{ "extends": ["@test/config", "other/base"] }',
            "node_modules/@test/config/package.json": '{ "tsconfig": "configs/base.json" }',
            "node_modules/@test/config/configs/base.json": '{ "extends": "./shared" }',
            "node_modules/@test/config/configs/shared.json": '{}',
            "node_modules/other/base.json": '{}',
        });
        try {
            const inputs = scanInputs(project({ extraFiles: [] }), root);
            for (const file of ["node_modules/@test/config/package.json", "node_modules/@test/config/configs/base.json", "node_modules/@test/config/configs/shared.json", "node_modules/other/base.json"])
                expect(inputs[path.join(root, file)]).toBeTruthy();
        }
        finally {
            rmWorkspace(root);
        }
    });
});

describe("config", () => {
    test("selectedProjects filters and rejects unknown names", () => {
        const projects = [{ name: "A" }, { name: "B" }];
        expect(selectedProjects(projects, null).length).toBe(2);
        expect(selectedProjects(projects, ["B"]).map(p => p.name)).toEqual(["B"]);
        expect(() => selectedProjects(projects, ["C"])).toThrow(/Unknown project\(s\): C/);
    });

    test("validateConfig rejects empty, duplicate and incomplete projects", () => {
        const complete = name => ({ name, tsconfig: "t", projectDir: ".", rootDir: ".", outDir: "o", js: "j", scanDirs: [{ dir: "." }] });
        expect(() => validateConfig(null)).toThrow(/at least one project/);
        expect(() => validateConfig({ projects: [] })).toThrow(/at least one project/);
        expect(() => validateConfig({ projects: [complete("A"), complete("A")] })).toThrow(/Duplicate project name/);
        expect(() => validateConfig({ projects: [{ name: "A" }] })).toThrow(/missing required field/);
    });
});
