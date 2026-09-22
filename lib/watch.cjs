const
    { subscribe } = require("@parcel/watcher"),
    { fs, path } = require("./util.cjs"),
    { inputModel, affectsInputs, containsPath } = require("./inputs.cjs"),
    { commonJSInputs } = require("./config-inputs.cjs"),
    { loadState, scanInputs, inputsMatch } = require("./state.cjs"),
    { build, validateConfig, selectedProjects, STATE_VERSION } = require("./build.cjs");

function nearestDirectory(directory) {
    for (;;) {
        if (fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
            return directory;
        const parent = path.dirname(directory);
        if (parent === directory)
            throw new Error(`No watchable directory for ${directory}.`);
        directory = parent;
    }
}

function directoryIdentity(directory) {
    const stat = fs.statSync(directory);
    return `${stat.dev}:${stat.ino}`;
}

async function watch(config, options) {
    const
        root = path.resolve(options.root || process.cwd()),
        configFile = options.config == null ? null : require.resolve(path.resolve(root, options.config)),
        dependencies = new Map(),
        recursive = new Map(),
        shallow = new Map();
    let
        current = validateConfig(config),
        modules = configFile == null ? new Set() : commonJSInputs(configFile),
        models = [],
        timer = null,
        running = false,
        pending = false,
        closed = false,
        active = null;

    const state = loadState(path.resolve(root, current.stateFile || ".build/buildstate.json"), STATE_VERSION);
    for (const project of current.projects)
        dependencies.set(project.name, state?.projects[project.name]?.dependencies || []);

    function schedule() {
        if (closed)
            return;
        pending = true;
        clearTimeout(timer);
        if (!running)
            timer = setTimeout(() => { active = rebuild(false); }, 150);
    }

    function changed(event) {
        if (closed || event.path === path.resolve(root, current.stateFile || ".build/buildstate.json"))
            return;
        if ([...modules].some(file => file === event.path || (event.type !== "update" && containsPath(event.path, file))) || models.some(model => affectsInputs(model, event)))
            schedule();
    }

    async function refresh() {
        models = selectedProjects(current.projects, options.only).map(project => inputModel(project, root, dependencies.get(project.name), true));
        const directories = new Set(), scans = new Set();
        for (const file of [...modules, ...models.flatMap(model => [...model.files])])
            directories.add(nearestDirectory(path.dirname(file)));
        for (const model of models)
            for (const scan of model.scans) {
                // Watch the parent too: deletion/recreation of a scan root must recover.
                directories.add(nearestDirectory(path.dirname(scan.dir)));
                if (fs.statSync(scan.dir, { throwIfNoEntry: false })?.isDirectory())
                    scans.add(scan.dir);
            }
        // Non-recursive handles for explicit files avoid recursively watching an
        // entire drive just to observe an ancestor package.json or a missing file.
        for (const directory of directories) {
            const identity = directoryIdentity(directory), previous = shallow.get(directory);
            if (previous?.identity !== identity) {
                previous?.handle.close();
                const handle = fs.watch(directory, (type, filename) => {
                    if (filename == null) {
                        schedule();
                        return;
                    }
                    const file = path.resolve(directory, filename.toString());
                    changed({ path: file, type: type === "change" ? "update" : fs.existsSync(file) ? "create" : "delete" });
                });
                handle.on("error", error => {
                    console.error(`Watcher error for ${directory}: ${error.message}`);
                    handle.close();
                    shallow.delete(directory);
                    schedule();
                });
                shallow.set(directory, { handle, identity });
            }
        }
        for (const [directory, entry] of shallow)
            if (!directories.has(directory)) {
                entry.handle.close();
                shallow.delete(directory);
            }
        for (const directory of scans) {
            const ignore = ["**/node_modules", "**/.*", ...models.map(model => model.outDir).filter(outDir => containsPath(directory, outDir) && ![...scans].some(scan => containsPath(outDir, scan)))];
            const key = directoryIdentity(directory) + JSON.stringify(ignore), previous = recursive.get(directory);
            if (previous?.key === key)
                continue;
            if (previous != null)
                await previous.handle.unsubscribe();
            const handle = await subscribe(directory, (error, events) => {
                if (error != null) {
                    console.error(`Watcher error for ${directory}: ${error.message || error}`);
                    schedule();
                    return;
                }
                for (const event of events)
                    changed({ ...event, path: path.resolve(event.path) });
            }, { ignore });
            recursive.set(directory, { handle, key });
        }
        for (const [directory, entry] of recursive)
            if (!scans.has(directory)) {
                await entry.handle.unsubscribe();
                recursive.delete(directory);
            }
    }

    async function rebuild(initial) {
        running = true;
        pending = false;
        let succeeded = false;
        try {
            if (!initial && configFile != null) {
                for (const file of modules)
                    delete require.cache[file];
                const next = validateConfig(require(configFile));
                selectedProjects(next.projects, options.only);
                current = next;
                modules = commonJSInputs(configFile);
            }
            await refresh();
            build(current, {
                ...options,
                root,
                force: initial && options.force,
                onInputs(project, files) {
                    dependencies.set(project.name, files);
                    if (options.onInputs != null)
                        options.onInputs(project, files);
                },
            });
            succeeded = true;
        }
        catch (error) {
            console.error(error.message);
        }
        finally {
            try {
                await refresh();
                if (succeeded) {
                    // Close the subscription gap for newly discovered inputs:
                    // edits during compilation/async subscription must trigger
                    // another build even if no native event could be observed.
                    const latest = loadState(path.resolve(root, current.stateFile || ".build/buildstate.json"), STATE_VERSION);
                    for (const project of selectedProjects(current.projects, options.only))
                        if (!inputsMatch(latest?.projects[project.name]?.inputs, scanInputs(project, root, dependencies.get(project.name))))
                            pending = true;
                }
            }
            catch (error) {
                console.error(error.message);
                succeeded = false;
            }
            // Consumers can edit as soon as this appears: newly discovered
            // dependencies already have subscriptions, including after errors.
            if (succeeded)
                console.log("Build complete.");
            running = false;
            if (pending)
                schedule();
        }
    }

    active = rebuild(true);
    await active;
    console.log("Watching TypeScript sources and project configurations...");
    return {
        async close() {
            closed = true;
            clearTimeout(timer);
            await active;
            for (const entry of shallow.values())
                entry.handle.close();
            await Promise.all([...recursive.values()].map(entry => entry.handle.unsubscribe()));
            shallow.clear();
            recursive.clear();
        },
    };
}

module.exports = { watch };
