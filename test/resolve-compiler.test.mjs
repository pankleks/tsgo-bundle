import { describe, test, expect } from "vitest";
import path from "node:path";
import resolverLib from "../lib/resolve-compiler.cjs";

const { resolveCompiler } = resolverLib;

describe("resolveCompiler", () => {
    test("resolves the stable TypeScript tsc binary", () => {
        const compiler = resolveCompiler(process.cwd()).split(path.sep).join("/");
        expect(compiler).toMatch(/\/node_modules\/typescript\/bin\/tsc$/);
    });
});
