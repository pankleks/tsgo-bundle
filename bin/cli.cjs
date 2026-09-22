#!/usr/bin/env node
const
    path = require("node:path"),
    { resolveCompiler } = require("../lib/resolve-compiler.cjs"),
    { run, watch, validateConfig } = require("../lib/build.cjs");

function usage() {
    console.log([
        "Usage: tsgo-bundle [--config <path>] [--only <name>[,<name>...]] [--watch] [--force]",
        "",
        "  --config  bundler config file (default: ./tsgo-bundle.config.cjs)",
        "  --only    build only these projects (repeatable or comma-separated)",
        "  --watch   rebuild on change",
        "  --force   ignore caches, wipe emit and rebuild from scratch",
    ].join("\n"));
}

function main(argv) {
    const
        options = { only: [], watch: false, force: false, config: "tsgo-bundle.config.cjs" };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            usage();
            return;
        }
        else if (arg === "--config")
            options.config = argv[++i];
        else if (arg === "--only")
            options.only.push(...argv[++i].split(",").map(name => name.trim()).filter(name => name !== ""));
        else if (arg === "--watch")
            options.watch = true;
        else if (arg === "--force")
            options.force = true;
        else
            throw new Error(`Unknown argument "${arg}". See --help.`);
    }
    if (options.config == null)
        throw new Error("Missing value for --config.");
    const
        root = process.cwd(),
        config = require(path.resolve(root, options.config)),
        compiler = resolveCompiler(root);
    validateConfig(config);
    options.root = root;
    options.compiler = compiler;
    if (options.watch)
        watch(config, options);
    run(config, options);
}

try {
    main(process.argv.slice(2));
}
catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
