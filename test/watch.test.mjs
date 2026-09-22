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
            waitForBuild = async count => expect.poll(() => watcher.completed, { timeout: 30000, message: "Watch did not finish rebuilding" }).toBeGreaterThanOrEqual(count);
        try {
            await waitForBuild(1);
            let count = watcher.completed;
            fs.writeFileSync(probe, 'namespace App { export const watchProbe = "first"; }\n');
            await waitForBuild(count + 1);
            expect(await bundle()).toContain('watchProbe = "first"');
            count = watcher.completed;
            fs.writeFileSync(probe, 'namespace App { export const watchProbe: number = "bad"; }\n');
            await expect.poll(() => watcher.output, { timeout: 30000 }).toContain("tsgo failed for M");
            expect(await bundle()).toContain('watchProbe = "first"');
            count = watcher.completed;
            fs.writeFileSync(probe, 'namespace App { export const watchProbe = "fixed"; }\n');
            await waitForBuild(count + 1);
            expect(await bundle()).toContain('watchProbe = "fixed"');
            count = watcher.completed;
            fs.rmSync(probe);
            await waitForBuild(count + 1);
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
