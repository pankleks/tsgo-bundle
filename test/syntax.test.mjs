import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import helpers from "./helpers.cjs";
import buildLib from "../lib/build.cjs";
import orderLib from "../lib/order.cjs";
import resolver from "../lib/resolve-compiler.cjs";

const compiler = resolver.resolveCompiler(process.cwd());

function workspace(files, options = {}) {
    const root = helpers.mkWorkspace({ ...files, "tsconfig.json": JSON.stringify({
        compilerOptions: { target: "es2020", types: [], rootDir: ".", outDir: "out", sourceMap: true, ...options },
        include: ["*.ts"], exclude: ["out", "dist"],
    }) });
    const config = { projects: [{ name: "P", tsconfig: "tsconfig.json", projectDir: ".", rootDir: ".", outDir: "out", js: "dist/bundle.js", scanDirs: [{ dir: "." }] }] };
    return { root, config };
}

describe("compiler syntax and executable bundles", () => {
    test.each([
        ["global classes", { "a.ts": "class Sub extends Base {}", "z.ts": "class Base { value = 42; }" }, "new Sub().value"],
        ["nested qualified namespaces", { "a.ts": "namespace Result { export class Sub extends A.B.Base {} }", "z.ts": "namespace A { export namespace B { export class Base { value = 42; } } }" }, "new Result.Sub().value"],
        ["separate namespace scopes", { "a.ts": "namespace A { export class Sub extends Base {} } namespace B { export class Sub extends Base {} }", "y.ts": "namespace A { export class Base { value = 20; } }", "z.ts": "namespace B { export class Base { value = 22; } }" }, "new A.Sub().value + new B.Sub().value"],
        ["lexical shadowing", { "a.ts": "namespace A { class Base { value = 42; } export class Sub extends Base {} }", "z.ts": "namespace A { export class Base { value = 99; } }" }, "new A.Sub().value"],
        ["Unicode and generic heritage", { "a.ts": "namespace A { export class Sub<T extends { x: number }> extends Żółć<T> {} }", "z.ts": "namespace A { export class Żółć<T> { value = 42; } }" }, "new A.Sub().value"],
        ["class expressions", { "a.ts": "namespace A { export const Sub = class extends Base {}; }", "z.ts": "namespace A { export class Base { value = 42; } }" }, "new A.Sub().value"],
        ["internal aliases", { "a.ts": "namespace A { export class Sub extends Alias {} }", "b.ts": "namespace A { export import Alias = B.Base; }", "z.ts": "namespace B { export class Base { value = 42; } }" }, "new A.Sub().value"],
        ["literal fake syntax", { "a.ts": "const text = `\nexport hello\n/// <reference path=\"missing.ts\" />\nnamespace Fake { export class Sub extends Base {} }`; class Sub extends Base {}", "z.ts": "class Base { value = 42; }" }, "new Sub().value"],
    ])("runs %s", (label, files, expression) => {
        const { root, config } = workspace(files);
        try {
            buildLib.build(config, { root, compiler });
            const context = vm.createContext({});
            vm.runInContext(fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8"), context);
            expect(vm.runInContext(expression, context)).toBe(42);
        }
        finally {
            helpers.rmWorkspace(root);
        }
    }, 30000);

    test.each([
        ["CommonJS", "export const value = 1;", { module: "commonjs" }],
        ["type-only export", "type Local = number; export type { Local };", {}],
        ["forced module detection", "const value = 1;", { moduleDetection: "force" }],
    ])("rejects %s before writing a bundle", (label, source, options) => {
        const { root, config } = workspace({ "a.ts": source }, options);
        try {
            expect(() => buildLib.build(config, { root, compiler })).toThrow(/ES module syntax/);
            expect(fs.existsSync(path.join(root, "dist/bundle.js"))).toBe(false);
        }
        finally {
            helpers.rmWorkspace(root);
        }
    }, 30000);

    test("rejects dynamic heritage with an actionable diagnostic", () => {
        const sources = ["/w/a.ts"];
        expect(() => orderLib.heritageEdges(sources, new Map([[sources[0], "class Sub extends mixin(Base) {}"]]))).toThrow(/Unsupported class heritage.*dynamic\/mixin/);
    });
});
