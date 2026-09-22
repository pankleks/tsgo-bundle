import { describe, test, expect, beforeAll, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helpers from "./helpers.cjs";
import resolverLib from "../lib/resolve-compiler.cjs";
import buildLib from "../lib/build.cjs";

const
    { mkWorkspace, rmWorkspace } = helpers,
    { resolveCompiler } = resolverLib,
    repoRoot = fileURLToPath(new URL("../", import.meta.url)),
    cli = path.join(repoRoot, "bin/cli.cjs");

let compiler = null;
beforeAll(() => {
    compiler = resolveCompiler(process.cwd());
    expect(compiler).toBeTruthy();
});

function startWatch(workspace, args = []) {
    const child = spawn(process.execPath, [cli, "--watch", ...args], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", error => { output += error.message; });
    return {
        get output() { return output; },
        get completed() { return output.split("Build complete.").length - 1; },
        get status() {
            if (child.exitCode !== null)
                return `exited with code ${child.exitCode}`;
            if (child.signalCode !== null)
                return `killed by signal ${child.signalCode}`;
            return "still running";
        },
        async stop() {
            if (child.exitCode !== null || child.signalCode !== null)
                return;
            const closed = once(child, "close");
            child.kill();
            await closed;
        },
    };
}

describe("watch", () => {
    test("handles additions, edits, errors, recovery and deletion without rebuild loops", { timeout: 180000 }, async () => {
        const root = mkWorkspace({
            "a.ts": `namespace App {\n    export class Base {}\n}\n`,
            "tsconfig.json": JSON.stringify({
                compilerOptions: { target: "es2020", types: [], outDir: "out", rootDir: ".", sourceMap: true, noEmitOnError: true },
                include: ["**/*.ts"],
                exclude: ["dist", "out"],
            }),
            "tsgo-bundle.config.cjs": `module.exports = { projects: [{ name: "M", tsconfig: "tsconfig.json", projectDir: ".", rootDir: ".", outDir: "out", js: "dist/bundle.js", dts: null, mapStyle: "external", scanDirs: [{ dir: "." }], extraFiles: ["tsconfig.json", "tsgo-bundle.config.cjs"] }] };\n`,
        });
        const
            watcher = startWatch(root),
            probe = path.join(root, "probe.ts"),
            bundle = () => fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8"),
            waitForBuild = async (count, timeout) => expect.poll(() => watcher.completed, { timeout: timeout || 15000, message: "Watch did not finish rebuilding" }).toBeGreaterThanOrEqual(count),
            // One mutation only: retries would hide dropped filesystem events.
            settle = async (mutate, check) => {
                mutate();
                try {
                    await check();
                }
                catch (error) {
                    error.message += `\nWatcher child ${watcher.status}, output tail:\n${watcher.output.slice(-3000)}`;
                    throw error;
                }
            };
        try {
            await waitForBuild(1, 30000);
            let count = watcher.completed;
            await settle(
                () => fs.writeFileSync(probe, 'namespace App { export const watchProbe = "first"; }\n'),
                () => waitForBuild(count + 1),
            );
            expect(await bundle()).toContain('watchProbe = "first"');
            count = watcher.completed;
            await settle(
                () => fs.writeFileSync(probe, 'namespace App { export const watchProbe: number = "bad"; }\n'),
                () => expect.poll(() => watcher.output, { timeout: 15000 }).toContain("tsc failed for M"),
            );
            expect(await bundle()).toContain('watchProbe = "first"');
            count = watcher.completed;
            await settle(
                () => fs.writeFileSync(probe, 'namespace App { export const watchProbe = "fixed"; }\n'),
                () => waitForBuild(count + 1),
            );
            expect(await bundle()).toContain('watchProbe = "fixed"');
            count = watcher.completed;
            await settle(
                () => fs.rmSync(probe, { force: true }),
                () => waitForBuild(count + 1),
            );
            expect(await bundle()).not.toContain("watchProbe");
            count = watcher.completed;
            await new Promise(resolve => setTimeout(resolve, 1000));
            expect(watcher.completed).toBe(count);
        }
        finally {
            await watcher.stop();
            rmWorkspace(root);
        }
    }, 180000);

    test("shares cache inputs, refreshes dependencies and reloads CommonJS config", { timeout: 120000 }, async () => {
        const cfg = {
            projects: [{
                name: "M", tsconfig: "tsconfig.json", projectDir: "src", rootDir: "src",
                outDir: "generated", js: "dist/bundle.js", dts: null,
                scanDirs: [{ dir: "src" }, { dir: "../scan-types" }], extraFiles: ["../meta/build.txt"],
            }],
        };
        const configText = () => `module.exports = ${JSON.stringify(cfg)}; Object.assign(module.exports.projects[0], require('./options.cjs'));\n`;
        const root = mkWorkspace({
            "app/src/a.ts": '/// <reference path="../../deps/api.d.ts" />\n// retained-comment\nnamespace App { export const value = Flavor.Value; }',
            "app/tsconfig.json": JSON.stringify({
                extends: "../configs/base.json",
                compilerOptions: { target: "es2020", types: [], rootDir: "src", outDir: "generated", sourceMap: true },
                include: ["src/**/*.ts", "../scan-types/**/*.d.ts"],
            }),
            "app/tsgo-bundle.config.cjs": configText(),
            "app/options.cjs": "module.exports = { sourcesContent: false };",
            "configs/base.json": '{ "compilerOptions": { "removeComments": false } }',
            "deps/api.d.ts": "declare const enum Flavor { Value = 1 }",
            "deps/next.d.ts": "declare const enum Flavor { Value = 300 }",
            "meta/build.txt": "first",
            "scan-types/initial.d.ts": "interface Initial {}",
            "future-types/initial.d.ts": "interface Future {}",
        });
        const
            watcher = startWatch(path.join(root, "app")),
            bundle = () => fs.readFileSync(path.join(root, "app", cfg.projects[0].js), "utf8"),
            waitForBuild = count => expect.poll(() => watcher.completed, { timeout: 15000 }).toBeGreaterThanOrEqual(count),
            change = async (file, text) => {
                const count = watcher.completed, offset = watcher.output.length;
                fs.writeFileSync(path.join(root, file), text);
                await waitForBuild(count + 1);
                expect(watcher.output.slice(offset)).toContain("Building M with TypeScript");
            };
        try {
            await waitForBuild(1);
            await change("deps/api.d.ts", "declare const enum Flavor { Value = 200 }");
            expect(bundle()).toContain("200");
            await change("scan-types/added.d.ts", "interface Added {}");
            await change("meta/build.txt", "second");
            await change("configs/base.json", '{ "compilerOptions": { "removeComments": true } }');
            expect(bundle()).not.toContain("retained-comment");
            await change("app/src/a.ts", '/// <reference path="../../deps/next.d.ts" />\nnamespace App { export const value = Flavor.Value; }');
            expect(bundle()).toContain("300");
            await change("deps/next.d.ts", "declare const enum Flavor { Value = 400 }");
            expect(bundle()).toContain("400");
            await change("app/options.cjs", "module.exports = { sourcesContent: true };");
            expect(JSON.parse(fs.readFileSync(path.join(root, "app/dist/bundle.js.map"), "utf8")).sourcesContent).toHaveLength(1);

            const offset = watcher.output.length;
            fs.writeFileSync(path.join(root, "app/tsgo-bundle.config.cjs"), "module.exports = {");
            await expect.poll(() => watcher.output.slice(offset), { timeout: 15000 }).toContain("Unexpected end of input");
            cfg.projects[0].js = "dist/renamed.js";
            cfg.projects[0].mapStyle = "inline";
            await change("app/tsgo-bundle.config.cjs", configText());
            expect(bundle()).toContain("sourceMappingURL=data:application/json;base64,");

            // An invalid inherited config must remain watched until it is fixed.
            const configOffset = watcher.output.length;
            fs.writeFileSync(path.join(root, "configs/base.json"), "{");
            await expect.poll(() => watcher.output.slice(configOffset), { timeout: 15000 }).toContain("Invalid config");
            await change("configs/base.json", '{ "compilerOptions": { "removeComments": false } }');

            // A config reload must also replace the set of recursively watched roots.
            cfg.projects[0].scanDirs.push({ dir: "../future-types" });
            cfg.projects[0].extraFiles.push("../missing/nested/input.txt");
            await change("app/tsgo-bundle.config.cjs", configText());
            await change("future-types/new.d.ts", "interface NewFuture {}");
            fs.mkdirSync(path.join(root, "missing/nested"), { recursive: true });
            await change("missing/nested/input.txt", "new external input");

            const replaced = watcher.completed;
            fs.renameSync(path.join(root, "future-types"), path.join(root, "old-types"));
            fs.mkdirSync(path.join(root, "future-types"));
            fs.writeFileSync(path.join(root, "future-types/replaced.d.ts"), "interface Replacement {}");
            await waitForBuild(replaced + 1);
            await change("future-types/replaced.d.ts", "interface Replacement { value: string; }");

            const count = watcher.completed;
            await new Promise(resolve => setTimeout(resolve, 1000));
            expect(watcher.completed).toBe(count);
        }
        catch (error) {
            error.message += `\nWatcher child ${watcher.status}, output tail:\n${watcher.output.slice(-5000)}`;
            throw error;
        }
        finally {
            await watcher.stop();
            rmWorkspace(root);
        }
    });

    test("--watch --force cleans once and ignores generated declarations and build metadata", { timeout: 60000 }, async () => {
        const root = mkWorkspace({
            "src/a.ts": "namespace App { export const value = 1; }",
            "generated/stale.txt": "stale",
            "tsconfig.json": JSON.stringify({
                compilerOptions: {
                    target: "es2020", types: [], rootDir: "src", outDir: "generated", sourceMap: true,
                    declaration: true, declarationMap: true, incremental: true, tsBuildInfoFile: "generated/cache.json",
                },
                include: ["src/**/*.ts"],
            }),
            "tsgo-bundle.config.cjs": `module.exports = { projects: [{ name: "M", tsconfig: "tsconfig.json", projectDir: ".", rootDir: "src", outDir: "generated", js: "dist/bundle.js", dts: "dist/bundle.d.ts", tsbuildinfo: "generated/cache.json", scanDirs: [{ dir: "." }] }] };`,
        });
        const watcher = startWatch(root, ["--force"]);
        try {
            await expect.poll(() => watcher.completed, { timeout: 15000 }).toBeGreaterThanOrEqual(1);
            expect(fs.existsSync(path.join(root, "generated/stale.txt"))).toBe(false);
            const count = watcher.completed;
            fs.writeFileSync(path.join(root, "generated/keep.txt"), "keep");
            fs.writeFileSync(path.join(root, "src/a.ts"), "namespace App { export const value = 2; }");
            await expect.poll(() => watcher.completed, { timeout: 15000 }).toBeGreaterThanOrEqual(count + 1);
            expect(fs.readFileSync(path.join(root, "generated/keep.txt"), "utf8")).toBe("keep");
            expect(fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8")).toContain("value = 2");
            const completed = watcher.completed;
            await new Promise(resolve => setTimeout(resolve, 1500));
            expect(watcher.completed).toBe(completed);
        }
        catch (error) {
            error.message += `\nWatcher output:\n${watcher.output.slice(-5000)}`;
            throw error;
        }
        finally {
            await watcher.stop();
            rmWorkspace(root);
        }
    });

    test("retries edits made during compilation and exposes a closeable watcher", { timeout: 30000 }, async () => {
        const root = mkWorkspace({
            "src/a.ts": '/// <reference path="../types/api.d.ts" />\nnamespace App { export const value = Flavor.Value; }',
            "types/api.d.ts": "declare const enum Flavor { Value = 1 }",
            "tsconfig.json": JSON.stringify({
                compilerOptions: { target: "es2020", types: [], rootDir: "src", outDir: "out", sourceMap: true },
                include: ["src/**/*.ts"],
            }),
        });
        const cfg = { projects: [{ name: "M", tsconfig: "tsconfig.json", projectDir: "src", rootDir: "src", outDir: "out", js: "dist/bundle.js", scanDirs: [{ dir: "src" }] }] };
        let changed = false, watcher;
        const logs = vi.spyOn(console, "log").mockImplementation(message => {
            if (!changed && message.startsWith("[M] tsc emit:")) {
                changed = true;
                fs.writeFileSync(path.join(root, "types/api.d.ts"), "declare const enum Flavor { Value = 222 }");
            }
        });
        try {
            watcher = await buildLib.watch(cfg, { root, compiler, watch: true });
            await expect.poll(() => fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8"), { timeout: 15000 }).toContain("222");
            await watcher.close();
            const count = logs.mock.calls.length;
            fs.writeFileSync(path.join(root, "types/api.d.ts"), "declare const enum Flavor { Value = 333 }");
            await new Promise(resolve => setTimeout(resolve, 500));
            expect(logs.mock.calls.length).toBe(count);
        }
        finally {
            await watcher?.close();
            logs.mockRestore();
            rmWorkspace(root);
        }
    });
});
