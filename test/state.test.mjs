import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import helpers from "./helpers.cjs";
import stateLib from "../lib/state.cjs";
import buildLib from "../lib/build.cjs";

const
    { mkWorkspace, writeTsconfig, rmWorkspace } = helpers,
    { scanInputs, loadState, isUpToDate, snapshotWithHashes, saveState, outputsExist } = stateLib,
    { selectedProjects, validateConfig } = buildLib;

const project = overrides => ({
    name: "S", projectDir: ".", rootDir: ".", outDir: "out",
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
        const state = { version: 1, compiler: stamp, projects: { S: snapshot } };
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
        const state = { version: 1, compiler: stamp, projects: { S: snapshotWithHashes(scanInputs(proj, root)) } };
        expect(outputsExist(proj, root)).toBe(true);

        fs.writeFileSync(path.join(root, "b.ts"), `namespace N { export const b = 1; }\n`);
        expect(isUpToDate(proj, state, scanInputs(proj, root), stamp, root)).toBe(false);

        fs.rmSync(path.join(root, proj.js + ".map"));
        expect(isUpToDate(proj, state, scanInputs(proj, root), stamp, root)).toBe(false);
        expect(outputsExist(proj, root)).toBe(false);

        expect(isUpToDate(proj, { ...state, compiler: "other" }, scanInputs(proj, root), stamp, root)).toBe(false);
        rmWorkspace(root);
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
