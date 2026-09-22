const
    fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path"),
    { spawnSync } = require("node:child_process"),
    { performance } = require("node:perf_hooks");

const args = process.argv.slice(2), settings = { files: 200, runs: 5 };
for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, ""), value = Number(args[i + 1]);
    if (!Object.hasOwn(settings, name) || !Number.isSafeInteger(value) || value < 1)
        throw new Error("Usage: npm run bench -- [--files 200] [--runs 5]");
    settings[name] = value;
}
const
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tsgo-bundle-bench-")),
    samples = { cold: [], noop: [], touch: [], edit: [], watch: [] },
    worker = path.join(__dirname, "worker.cjs");
function invoke(mode, repetitions = 1) {
    const started = performance.now(), result = spawnSync(process.execPath, [worker, root, mode, String(repetitions)], { encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    const wall = performance.now() - started;
    if (result.error || result.status !== 0)
        throw result.error || new Error(result.stdout + result.stderr);
    const line = result.stdout.split(/\r?\n/).find(text => text.startsWith("BENCH_RESULT="));
    if (line == null)
        throw new Error("Missing worker result: " + result.stdout);
    const values = JSON.parse(line.slice("BENCH_RESULT=".length));
    if (mode !== "watch")
        values[0].processWallMs = wall;
    return values;
}
function median(values) {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarize(values) {
    const names = new Set(values.flatMap(sample => Object.keys(sample.phases))), round = n => Math.round(n * 100) / 100;
    return {
        medianMs: round(median(values.map(sample => sample.milliseconds))),
        minMs: round(Math.min(...values.map(sample => sample.milliseconds))),
        maxMs: round(Math.max(...values.map(sample => sample.milliseconds))),
        processWallMedianMs: values[0].processWallMs == null ? null : round(median(values.map(sample => sample.processWallMs))),
        parentPeakRssMiB: round(Math.max(...values.map(sample => sample.maxRssMiB))),
        phaseMedianMs: Object.fromEntries([...names].map(name => [name, round(median(values.map(sample => sample.phases[name] || 0)))])),
    };
}
try {
    fs.mkdirSync(path.join(root, "src"));
    for (let i = 0; i < settings.files; i++) {
        const base = i % 10 === 0 ? "" : ` extends C${i - 1}`;
        const fields = Array.from({ length: 20 }, (_, n) => `        field${n} = ${i + n};`).join("\n");
        fs.writeFileSync(path.join(root, "src", String(settings.files - i).padStart(6, "0") + ".ts"), `namespace Bench {\n    export class C${i}${base} {\n${fields}\n    }\n}\n`);
    }
    fs.writeFileSync(path.join(root, "src/marker.ts"), "namespace Bench { export const marker = 0; }\n");
    fs.writeFileSync(path.join(root, "marker.txt"), "0");
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
        target: "es2020", types: [], rootDir: "src", outDir: "out", sourceMap: true,
        declaration: true, declarationMap: true, incremental: true, tsBuildInfoFile: "out/cache.tsbuildinfo",
    }, include: ["src/**/*.ts"] }));
    fs.writeFileSync(path.join(root, "tsgo-bundle.config.cjs"), "module.exports = " + JSON.stringify({ projects: [{
        name: "Bench", tsconfig: "tsconfig.json", projectDir: "src", rootDir: "src", outDir: "out",
        js: "dist/bundle.js", dts: "dist/bundle.d.ts", tsbuildinfo: "out/cache.tsbuildinfo", scanDirs: [{ dir: "src" }],
    }] }) + ";\n");
    // Untimed warm-up initializes filesystem caches and verifies the fixture.
    invoke("cold");
    for (let i = 0; i < settings.runs; i++) {
        samples.cold.push(...invoke("cold"));
        samples.noop.push(...invoke("noop"));
        const now = new Date(Date.now() + 1000);
        fs.utimesSync(path.join(root, "src/marker.ts"), now, now);
        samples.touch.push(...invoke("touch"));
        fs.writeFileSync(path.join(root, "marker.txt"), String(i + 1));
        fs.writeFileSync(path.join(root, "src/marker.ts"), `namespace Bench { export const marker = ${i + 1}; }\n`);
        samples.edit.push(...invoke("edit"));
    }
    samples.watch = invoke("watch", settings.runs);
    console.log(JSON.stringify({
        environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, typescript: require("typescript/package.json").version },
        fixture: { classFiles: settings.files, markerFiles: 1, fieldsPerClass: 20, maxInheritanceDepth: 10, repetitions: settings.runs, incremental: true, declarationMaps: true },
        summary: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summarize(values)])),
        samples,
    }, null, 2));
}
finally {
    fs.rmSync(root, { recursive: true, force: true });
}
