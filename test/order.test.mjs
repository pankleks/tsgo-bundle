import { describe, test, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import helpers from "./helpers.cjs";
import orderLib from "../lib/order.cjs";
import resolverLib from "../lib/resolve-compiler.cjs";

const
    { mkWorkspace, writeTsconfig, rmWorkspace } = helpers,
    { orderedSources, heritageEdges, breakCycles, stronglyConnected } = orderLib,
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
            "z-sub.ts": `namespace App { export class Sub extends Base {} }\n`,
            "a-base.ts": `namespace App { export class Base {} }\n`,
        });
        writeTsconfig(root);
        expect(rel(root, orderedSources(project("P"), compiler, root, silent))).toEqual(["a-base.ts", "z-sub.ts"]);
        rmWorkspace(root);
        root = null;
    });

    test("reference cycle breaks towards heritage, drops the dead hint", { timeout: 30000 }, () => {
        root = mkWorkspace({
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
