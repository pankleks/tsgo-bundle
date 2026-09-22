import { describe, test, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helpers from "./helpers.cjs";
import resolverLib from "../lib/resolve-compiler.cjs";

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

function startWatch(workspace) {
    const child = spawn(process.execPath, [cli, "--watch"], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
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
            waitForBuild = async (count, timeout) => expect.poll(() => watcher.completed, { timeout: timeout || 5000, message: "Watch did not finish rebuilding" }).toBeGreaterThanOrEqual(count),
            // fs.watch can drop change events under load; repeat the mutation
            // until the watcher reacts (total budget matches the old 30s poll).
            settle = async (mutate, check) => {
                const deadline = Date.now() + 25000;
                for (;;) {
                    mutate();
                    try {
                        await check();
                        return;
                    }
                    catch (error) {
                        if (Date.now() >= deadline) {
                            error.message += `\nWatcher child ${watcher.status}, output tail:\n${watcher.output.slice(-3000)}`;
                            throw error;
                        }
                    }
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
                () => expect.poll(() => watcher.output, { timeout: 5000 }).toContain("tsgo failed for M"),
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
});
