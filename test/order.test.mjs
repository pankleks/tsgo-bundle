import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import helpers from "./helpers.cjs";
import orderLib from "../lib/order.cjs";
import resolverLib from "../lib/resolve-compiler.cjs";

const
    { mkWorkspace, writeTsconfig, rmWorkspace } = helpers,
    { orderedSources, shadowDeclarations, excludedSiblings, assertNoShadowDeclarations, heritageEdges, breakCycles, stronglyConnected } = orderLib,
    { resolveCompiler } = resolverLib;

let compiler = null;
beforeAll(() => {
    compiler = resolveCompiler(process.cwd());
});

const project = name => ({ name, tsconfig: "tsconfig.json" });
const rel = (root, files) => files.map(file => path.relative(root, file).split(path.sep).join("/"));
const silent = () => { };

describe("orderedSources", () => {
    let root = null;
    afterAll(() => {
        if (root != null)
            rmWorkspace(root);
    });

    test("linear reference chain orders dependencies first", { timeout: 30000 }, () => {
        root = mkWorkspace({
            "c.ts": `/// <reference path="b.ts" />\nnamespace N { export const c = N.b + 1; }\n`,
            "b.ts": `/// <reference path="a.ts" />\nnamespace N { export const b = N.a + 1; }\n`,
            "a.ts": `namespace N { export const a = 1; }\n`,
        });
        writeTsconfig(root);
        expect(rel(root, orderedSources(project("P"), compiler, root, silent))).toEqual(["a.ts", "b.ts", "c.ts"]);
        rmWorkspace(root);
        root = null;
    });

    test("heritage without any reference edge is still ordered", { timeout: 30000 }, () => {
        root = mkWorkspace({
            "a-sub.ts": `namespace App { export class Sub extends Base {} }\n`,
            "z-base.ts": `namespace App { export class Base {} }\n`,
        });
        writeTsconfig(root);
        expect(rel(root, orderedSources(project("P"), compiler, root, silent))).toEqual(["z-base.ts", "a-sub.ts"]);
        rmWorkspace(root);
        root = null;
    });

    test("filename order does not matter, references do", { timeout: 30000 }, () => {
        root = mkWorkspace({
            "Planck/ADerived.ts": '/// <reference path="ZBase.ts"/>\nnamespace Planck { export class TestDerived extends TestBase {} }\n',
            "Planck/ZBase.ts": `namespace Planck { export class TestBase { value = 42; } }\n`,
        });
        writeTsconfig(root);
        expect(rel(root, orderedSources(project("P"), compiler, root, silent))).toEqual(["Planck/ZBase.ts", "Planck/ADerived.ts"]);
        rmWorkspace(root);
        root = null;
    });

    test("reference cycle breaks towards heritage, drops the dead hint", { timeout: 30000 }, () => {        root = mkWorkspace({
            "entity.ts": `///<reference path="base.ts"/>\nnamespace D { export class Project extends UnitBase {} }\n`,
            "base.ts": `///<reference path="entity.ts"/>\nnamespace D { export class UnitBase {} }\n`,
        });
        writeTsconfig(root);
        const logs = [];
        const ordered = rel(root, orderedSources(project("P"), compiler, root, message => logs.push(message)));
        expect(ordered).toEqual(["base.ts", "entity.ts"]);
        expect(logs.some(message => message.includes("base.ts") && message.includes("entity.ts"))).toBe(true);
        rmWorkspace(root);
        root = null;
    });

    test("heritage-only cycle fails loudly", { timeout: 30000 }, () => {
        root = mkWorkspace({
            "a.ts": `namespace D { export class A extends B {} }\n`,
            "b.ts": `namespace D { export class B extends A {} }\n`,
        });
        writeTsconfig(root);
        expect(() => orderedSources(project("P"), compiler, root, silent)).toThrow(/Circular class heritage/);
        rmWorkspace(root);
        root = null;
    });

    test("reference outside the program fails loudly", { timeout: 30000 }, () => {
        root = mkWorkspace({
            "a.ts": `/// <reference path="../elsewhere/b.ts" />\nnamespace N { export const a = 1; }\n`,
        });
        writeTsconfig(root);
        expect(() => orderedSources(project("P"), compiler, root, silent)).toThrow(/Reference outside/);
        rmWorkspace(root);
        root = null;
    });

    test("stale declaration emit beside its source fails fast", { timeout: 30000 }, () => {
        // Mirrors the real-world trigger (e.g. an entity file like Data.Test.ts
        // colliding with the lowercase "**/*.test.ts" test-file exclude, which
        // matches case-insensitively on Windows/macOS): the source survives only
        // via "files" while its stale sibling slips in via "include" and tsc
        // lists both. Lowercase names keep this deterministic on case-sensitive
        // systems too, where "files" is the only way the source stays listed.
        root = mkWorkspace({
            "data.test.ts": `namespace Pulsar.Data { export class Test { a: number = 1; } }\n`,
            "data.test.d.ts": `declare namespace Pulsar.Data { class Test { a: number; } }\n`,
        });
        fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "es2020", types: [] },
            include: ["**/*.ts"],
            files: ["./data.test.ts"],
            exclude: ["**/*.test.ts"],
        }));
        expect(() => orderedSources(project("P"), compiler, root, silent)).toThrow(/Stale declaration emit in P.*data\.test\.ts shadowed by data\.test\.d\.ts/s);
        rmWorkspace(root);
        root = null;
    });
});

describe("shadowDeclarations", () => {
    let root = null;
    afterAll(() => {
        if (root != null)
            rmWorkspace(root);
    });

    test("reports Foo.ts shadowed by Foo.d.ts", () => {
        root = mkWorkspace({
            "a.ts": `namespace App { export class Base {} }\n`,
            "a.d.ts": `declare namespace App { class Base {} }\n`,
        });
        const files = [path.join(root, "a.ts"), path.join(root, "a.d.ts")];
        expect(shadowDeclarations(files, root)).toEqual([[path.join(root, "a.ts"), path.join(root, "a.d.ts")]]);
        expect(() => assertNoShadowDeclarations(files, project("P"), root)).toThrow(/Stale declaration emit in P.*a\.ts shadowed by a\.d\.ts/s);
        rmWorkspace(root);
        root = null;
    });

    test("repeated checks of the same file list reuse the cached classification", () => {
        root = mkWorkspace({
            "a.ts": `namespace App { export class Base {} }\n`,
            "a.d.ts": `declare namespace App { class Base {} }\n`,
            "types/api.d.ts": `declare const value: number;\n`,
        });
        const
            expected = [[path.join(root, "a.ts"), path.join(root, "a.d.ts")]],
            files = [path.join(root, "a.ts"), path.join(root, "a.d.ts"), path.join(root, "types/api.d.ts")];
        expect(shadowDeclarations(files, root)).toEqual(expected);
        expect(shadowDeclarations(files, root)).toEqual(expected);
        expect(excludedSiblings(files, root)).toEqual([]);
        expect(excludedSiblings(files, root)).toEqual([]);
        expect(() => assertNoShadowDeclarations(files, project("P"), root)).toThrow(/Stale declaration emit in P/s);
        rmWorkspace(root);
        root = null;
    });

    test("standalone declarations without a sibling source are fine", () => {
        root = mkWorkspace({
            "a.ts": `namespace App { export class Base {} }\n`,
            "types/api.d.ts": `declare const value: number;\n`,
        });
        const files = [path.join(root, "a.ts"), path.join(root, "types/api.d.ts")];
        expect(shadowDeclarations(files, root)).toEqual([]);
        expect(() => assertNoShadowDeclarations(files, project("P"), root)).not.toThrow();
        rmWorkspace(root);
        root = null;
    });

    test("files outside the workspace are ignored", () => {
        root = mkWorkspace({
            "a.ts": `namespace App { export class Base {} }\n`,
        });
        const outside = path.resolve(root, "..", "outside-a.ts");
        expect(shadowDeclarations([path.join(root, "a.ts"), outside], root)).toEqual([]);
        rmWorkspace(root);
        root = null;
    });

    test("source excluded but stale emit listed fails fast", () => {
        root = mkWorkspace({
            "Data.Test.ts": `namespace Pulsar.Data { export class Test { a: number = 1; } }\n`,
            "Data.Test.d.ts": `declare namespace Pulsar.Data { class Test { a: number; } }\n`,
        });
        const onlyDeclaration = [path.join(root, "Data.Test.d.ts")];
        expect(shadowDeclarations(onlyDeclaration, root)).toEqual([]);
        expect(excludedSiblings(onlyDeclaration, root)).toEqual([[path.join(root, "Data.Test.ts"), path.join(root, "Data.Test.d.ts")]]);
        expect(() => assertNoShadowDeclarations(onlyDeclaration, project("P"), root)).toThrow(/excluded from the program but shadowed by/s);
        rmWorkspace(root);
        root = null;
    });

    test("orderedSources fails fast when the source is excluded and only its stale emit is listed", { timeout: 30000 }, () => {
        // Lowercase names so the "**/*.test.ts" exclude matches on every
        // platform: tsc then lists only the stale emit while the source exists
        // on disk, and the guard reports the silent drop.
        root = mkWorkspace({
            "data.test.ts": `namespace Pulsar.Data { export class Test { a: number = 1; } }\n`,
            "data.test.d.ts": `declare namespace Pulsar.Data { class Test { a: number; } }\n`,
        });
        fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "es2020", types: [] },
            include: ["**/*.ts"],
            exclude: ["**/*.test.ts"],
        }));
        expect(() => orderedSources(project("P"), compiler, root, silent)).toThrow(/excluded from the program but shadowed by/s);
        rmWorkspace(root);
        root = null;
    });
});

describe("heritageEdges", () => {
    test("ignores generic constraints, implements and type-only positions", () => {
        const
            files = ["/w/picker.ts", "/w/selector.ts"],
            texts = new Map([
                [files[0], `namespace App { abstract class Base<T extends object, R extends Grid<T>> extends Planck.Bound {} export class Picker extends Base<A, Grid> {} }`],
                [files[1], `namespace App { export class Grid<T> {} }`],
            ]);
        const edges = heritageEdges(files, texts);
        // Only the real heritage (Picker -> Planck.Bound is external, Base is same-file).
        expect([...edges.get(files[0])]).toEqual([]);
        expect([...edges.get(files[1])]).toEqual([]);
    });

    test("resolves bare and qualified base names", () => {
        const
            files = ["/w/sub.ts", "/w/base.ts", "/w/other.ts"],
            texts = new Map([
                [files[0], `namespace App { export class Sub extends Base {} export class Sub2 extends Lib.Base {} }`],
                [files[1], `namespace App { export class Base {} }`],
                [files[2], `namespace Lib { export class Base {} }`],
            ]);
        const edges = heritageEdges(files, texts);
        expect([...edges.get(files[0])].sort()).toEqual([files[1], files[2]].sort());
    });

    test("ambiguous base names produce no edge (safe fallback)", () => {
        const
            files = ["/w/sub.ts", "/w/a.ts", "/w/b.ts"],
            texts = new Map([
                [files[0], `namespace App { export class Sub extends Base {} }`],
                [files[1], `namespace Other { export class Base {} }`],
                [files[2], `namespace Third { export class Base {} }`],
            ]);
        const edges = heritageEdges(files, texts);
        expect([...edges.get(files[0])]).toEqual([]);
    });
});

describe("breakCycles", () => {
    test("drops only non-heritage edges inside a cycle", () => {
        const
            graph = new Map([["a", ["b"]], ["b", ["a"]]]),
            heritage = new Map([["a", new Set(["b"])], ["b", new Set()]]);
        expect(breakCycles(graph, heritage, "P", "/root")).toEqual([["b", "a"]]);
        expect(graph.get("a")).toEqual(["b"]);
        expect(graph.get("b")).toEqual([]);
    });

    test("heritage-only cycle throws with file list", () => {
        const
            graph = new Map([["a", ["b"]], ["b", ["a"]]]),
            heritage = new Map([["a", new Set(["b"])], ["b", new Set(["a"])]]);
        expect(() => breakCycles(graph, heritage, "P", "/root")).toThrow(/Circular class heritage.*a.*b/);
    });

    test("stronglyConnected finds multi-file cycles", () => {
        const
            graph = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]], ["d", []]]),
            sccs = stronglyConnected(graph);
        expect(sccs).toHaveLength(1);
        expect(new Set(sccs[0])).toEqual(new Set(["a", "b", "c"]));
    });
});
