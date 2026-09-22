import { describe, test, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import helpers from "./helpers.cjs";
import buildLib from "../lib/build.cjs";
import resolverLib from "../lib/resolve-compiler.cjs";

const
    { mkWorkspace, rmWorkspace } = helpers,
    { build } = buildLib,
    compiler = resolverLib.resolveCompiler(process.cwd());

function fixture() {
    return mkWorkspace({
        "src/a.ts": "namespace App { export const answer = 42; }",
        "src/nested/b.ts": "namespace App { export const other = 1; }",
        "emit/stale.txt": "old emit",
        "tsconfig.json": JSON.stringify({
            compilerOptions: { target: "es2020", types: [], rootDir: "src", outDir: "emit", sourceMap: true },
            include: ["src/**/*.ts"],
        }),
    });
}

function config(overrides) {
    return { projects: [{
        name: "P", tsconfig: "tsconfig.json", projectDir: "src", rootDir: "src",
        outDir: "emit", js: "dist/bundle.js", scanDirs: [{ dir: "src" }], ...overrides,
    }] };
}

function expectProtected(root, cfg, options = {}) {
    // Never let a regression in a destructive-path test delete outside the fixture.
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("Unexpected deletion"); });
    try {
        expect(() => build(cfg, { root, compiler, force: true, ...options })).toThrow(/Unsafe --force/);
        expect(remove).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toContain("answer = 42");
        expect(fs.readFileSync(path.join(root, "emit/stale.txt"), "utf8")).toBe("old emit");
        expect(fs.existsSync(path.join(root, ".build/buildstate.json"))).toBe(false);
    }
    finally {
        remove.mockRestore();
    }
}

describe("force safety", () => {
    test.each([".", "..", "src", "src/..", "src/nested", ".git/objects"])("rejects outDir %s before deleting anything", outDir => {
        const root = fixture();
        try {
            expectProtected(root, config({ outDir }));
        }
        finally {
            rmWorkspace(root);
        }
    });

    test("protects source files even when TypeScript excludes the misconfigured outDir", () => {
        const root = fixture();
        try {
            const file = path.join(root, "tsconfig.json"), tsconfig = JSON.parse(fs.readFileSync(file, "utf8"));
            tsconfig.compilerOptions.outDir = "src/nested";
            fs.writeFileSync(file, JSON.stringify(tsconfig));
            expectProtected(root, config({ outDir: "src/nested" }));
        }
        finally {
            rmWorkspace(root);
        }
    });

    test.each(["src/a.ts", "tsconfig.json", "src"])("rejects tsbuildinfo pointing at %s", tsbuildinfo => {
        const root = fixture();
        try {
            expectProtected(root, config({ tsbuildinfo }));
        }
        finally {
            rmWorkspace(root);
        }
    });

    test("protects inherited configs and extra inputs inside an output directory", () => {
        const root = fixture();
        try {
            fs.writeFileSync(path.join(root, "emit/base.json"), "{}");
            const file = path.join(root, "tsconfig.json"), tsconfig = JSON.parse(fs.readFileSync(file, "utf8"));
            tsconfig.extends = "./emit/base.json";
            fs.writeFileSync(file, JSON.stringify(tsconfig));
            expectProtected(root, config());
            delete tsconfig.extends;
            fs.writeFileSync(file, JSON.stringify(tsconfig));
            expectProtected(root, config({ extraFiles: ["emit/stale.txt"] }));
            expectProtected(root, config(), { config: "emit/bundle.config.cjs" });
        }
        finally {
            rmWorkspace(root);
        }
    });

    test("validates all deletions before starting the first selected project", () => {
        const root = fixture();
        try {
            const cfg = config();
            cfg.projects.push({ ...cfg.projects[0], name: "Other", outDir: "." });
            expectProtected(root, cfg);
            cfg.projects[1].outDir = "other-emit";
            cfg.projects[1].projectDir = "emit";
            expectProtected(root, cfg, { only: ["P"] });
        }
        finally {
            rmWorkspace(root);
        }
    });

    test("resolves junctions and missing descendants before comparing paths", () => {
        const root = fixture();
        try {
            fs.symlinkSync(path.join(root, "src"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
            expectProtected(root, config({ outDir: "alias" }));
            expectProtected(root, config({ outDir: "alias/future", scanDirs: [{ dir: "src/future" }] }));
        }
        finally {
            rmWorkspace(root);
        }
    });

    test("a dedicated output directory is cleared and rebuilt", { timeout: 30000 }, () => {
        const root = fixture();
        try {
            build(config(), { root, compiler, force: true });
            expect(fs.existsSync(path.join(root, "emit/stale.txt"))).toBe(false);
            expect(fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8")).toContain("answer = 42");
            expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toContain("answer = 42");
        }
        finally {
            rmWorkspace(root);
        }
    });
});
