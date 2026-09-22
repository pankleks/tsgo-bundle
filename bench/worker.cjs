const
    fs = require("node:fs"),
    path = require("node:path"),
    assert = require("node:assert/strict"),
    { performance } = require("node:perf_hooks"),
    { resolveCompiler } = require("../lib/resolve-compiler.cjs"),
    phases = {};

// Instrument exports before build.cjs captures them. Production code is unchanged.
function instrument(module, name, label = name) {
    const original = module[name];
    module[name] = function (...args) {
        const started = performance.now();
        try {
            return original.apply(this, args);
        }
        finally {
            const key = typeof label === "function" ? label(args) : label;
            phases[key] = (phases[key] || 0) + performance.now() - started;
        }
    };
}
instrument(require("node:child_process"), "spawnSync", args => args[1]?.includes("--listFilesOnly") ? "process listFiles" : args[1]?.includes("-p") ? "process emit" : "process syntax");
const
    state = require("../lib/state.cjs"),
    order = require("../lib/order.cjs"),
    merge = require("../lib/merge.cjs");
for (const name of ["scanInputs", "isUpToDate", "snapshotWithHashes", "saveState"])
    instrument(state, name);
instrument(order, "programFiles");
instrument(order, "orderedSources");
instrument(merge, "bundle", args => "bundle " + args[2]);
const { build, watch } = require("../lib/build.cjs");

async function main() {
    const
        [root, mode, repetitionsText] = process.argv.slice(2),
        config = require(path.join(root, "tsgo-bundle.config.cjs")),
        compiler = resolveCompiler(path.resolve(__dirname, "..")),
        options = { root, compiler },
        samples = [];
    let skipped = false, completed = 0;
    console.log = message => {
        if (message.includes("up to date, skipping"))
            skipped = true;
        if (message === "Build complete.")
            completed++;
    };
    function reset() {
        for (const key of Object.keys(phases))
            delete phases[key];
        skipped = false;
    }
    function sample(started) {
        return { milliseconds: performance.now() - started, maxRssMiB: process.resourceUsage().maxRSS / 1024, phases: { ...phases }, skipped };
    }
    function verify() {
        const js = fs.readFileSync(path.join(root, "dist/bundle.js"), "utf8");
        assert(js.includes("marker = " + fs.readFileSync(path.join(root, "marker.txt"), "utf8")));
        assert(fs.existsSync(path.join(root, "dist/bundle.d.ts.map")));
    }
    if (mode !== "watch") {
        const started = performance.now();
        build(config, { ...options, force: mode === "cold" });
        samples.push(sample(started));
        assert.equal(skipped, mode === "noop" || mode === "touch");
        verify();
    }
    else {
        const handle = await watch(config, { ...options, watch: true });
        try {
            for (let i = 0; i < Number(repetitionsText); i++) {
                // Let native notifications from the previous build drain.
                await new Promise(resolve => setTimeout(resolve, 500));
                reset();
                const target = completed + 1, marker = 10000 + i, started = performance.now();
                fs.writeFileSync(path.join(root, "marker.txt"), String(marker));
                fs.writeFileSync(path.join(root, "src/marker.ts"), `namespace Bench { export const marker = ${marker}; }\n`);
                while (completed < target) {
                    if (performance.now() - started > 60000)
                        throw new Error("Watch benchmark timed out.");
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                samples.push(sample(started));
                assert.equal(skipped, false);
                verify();
            }
        }
        finally {
            await handle.close();
        }
    }
    process.stdout.write("BENCH_RESULT=" + JSON.stringify(samples) + "\n");
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
