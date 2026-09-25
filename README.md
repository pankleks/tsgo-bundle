# tsgo-bundle

Single-file bundler for TypeScript **global-script** (`namespace`) projects compiled with TypeScript 7's native [`tsc`](https://www.typescriptlang.org/). A drop-in replacement for the removed tsc `outFile` option — without migrating a large codebase to ES modules.

How it works: each project is compiled per-file (`outDir`, never `outFile`), then concatenated reference-first with merged source maps. Chunk order additionally guarantees every base class evaluates before its subclasses, so reference cycles cannot silently break the bundle at runtime.

## Install

```bash
npm i -D tsgo-bundle typescript
```

`typescript` is a peer dependency (the compiler this tool drives).

## Quickstart

1. Make sure each project's tsconfig uses per-file emit (`outDir` + `rootDir`), never `outFile`. Keep bundle outputs **outside** the tsconfig `include` globs (or `exclude` them); `outDir` itself is excluded automatically, anything else (e.g. `dist/`) is not.
2. Add `tsgo-bundle.config.cjs` to the repo root:

```js
module.exports = {
    // Where incremental state lives (default: .build/buildstate.json).
    stateFile: "wwwroot/.build/buildstate.json",
    projects: [
        {
            name: "Components",
            tsconfig: "wwwroot/Components/tsconfig.tsgo.json",
            projectDir: "wwwroot/Components",
            rootDir: "wwwroot/Components",
            outDir: "wwwroot/.build/Components",
            js: "wwwroot/_Public/Components.js",
            dts: "wwwroot/_Public/Components.d.ts", // or null when unneeded
            tsbuildinfo: "wwwroot/.build/Components.tsbuildinfo", // wiped before every compiler run
            mapStyle: "external", // or "inline" (self-contained, for distributed libs)
            sourcesContent: false, // true embeds on-disk sources (self-contained maps, coverage remapping)
            scanDirs: [{ dir: "wwwroot/Components" }],
            // Test files may live in a second tree:
            // scanDirs: [{ dir: "wwwroot/Tests" }, { dir: "wwwroot/Components", testOnly: true }],
            extraFiles: [
                "wwwroot/_Public/Planck.d.ts",
                "wwwroot/Components/tsconfig.tsgo.json",
            ],
        },
    ],
};
```

3. Wire up scripts:

```json
{
    "build": "tsgo-bundle",
    "build:components": "tsgo-bundle --only Components",
    "build:full": "tsgo-bundle --force",
    "watch": "tsgo-bundle --watch"
}
```

CLI: `tsgo-bundle [--config <path>] [--only <name>[,<name>...]] [--watch] [--force]`.

## Rules the tool enforces

- **Sources stay global scripts.** Any top-level `import`/`export` in program sources fails the build loudly (`ES module syntax in …`) instead of breaking the bundle at runtime. `implements` and type-only usages are fine.
- **Chunk order is reference-first**, with class heritage (`extends`) enforced on top: every base class is bundled before its subclasses — even without a `/// <reference>` edge (which is then added to the ordering graph automatically).
- **Reference cycles are broken deterministically**: non-heritage `/// <reference>` hints inside a cycle are dropped (logged as `cycle: ignoring ordering hint …`). A heritage-only cycle cannot be ordered and fails the build with the file list instead of crashing in the browser.
- **Incremental by content hash** (like `tsc -b`, but hash-checked): unchanged builds skip in milliseconds, mere touches without content change skip too, `--force` wipes emit and rebuilds cold. Failed builds never update the incremental state, so a retry rebuilds (and fails again) instead of skipping.
- Configs usually keep `noEmitOnError: false`: bundles refresh even with type errors, but the exit code is nonzero — check it, not artifact presence.

### Incremental inputs

Each project has its own compiler/bundler stamp and configuration fingerprint.
The cache tracks its tsconfig and inherited `extends` configs (including JSONC,
arrays and package-based configs), plus the files reported by the compiler,
including `.d.ts` dependencies outside `scanDirs`. Package manifests along those
paths and workspace lockfiles are tracked too.

Keep `scanDirs` covering directories where new sources can appear; these scans
detect additions and removals, including declarations, while excluding the
project's emit directory and bundle files. Use `extraFiles` for additional build
inputs. A failed or interrupted rebuild invalidates the project's previous state,
so reverting sources after an error still regenerates the bundles. Inputs changed
during compilation are not cached as successfully emitted.

Rebuilds reuse hashes for inputs whose mtime and size are unchanged. Declaration
bundles can also be reused when their emitted files/maps, source order, compiler,
configuration and output hashes match. With `sourcesContent: true` declarations
are always merged again so embedded source text stays current. `--force` bypasses
these reuse paths.

The project's `tsbuildinfo` file is deleted before every compiler run, not just
`--force`: TypeScript 7 incremental builds can exit 0 without re-reporting
semantic errors in unchanged files (e.g. narrowing a callee signature surfaces
only at its unchanged callers), and that false success would otherwise be cached
as up to date. Every rebuild therefore fully type-checks; unchanged builds still
skip the compiler entirely via content hashes. Keep `tsbuildinfo` configured so
the wipe target is explicit — a target pointing at a directory or a protected
input fails the build instead of deleting.

### Watch and force builds

`--watch` uses the same input definitions as the incremental cache: `scanDirs`
(including `testOnly`), declarations, `extraFiles`, tsconfigs and resolved
dependencies. Explicit inputs outside source directories, in hidden directories
or in `node_modules` are watched too. Subscriptions are refreshed after builds,
including failed builds, and after configuration changes.

The CLI reloads its CommonJS bundler config and the modules it requires when
rebuilding. Fixing a configuration error resumes watch mode without restarting
the process. Generated bundles, the configured emit directory and build state do
not trigger rebuild loops. With `--watch --force`, cleaning happens on the initial
build; later changes use normal incremental builds.

Before `--force` deletes anything, it checks every selected cleanup path against
the workspace, source roots and inputs of **all** configured projects, including
projects excluded by `--only`. Symlinks/junctions are resolved during these checks.
An emit directory containing TypeScript source files, a config/dependency, or
repository metadata is rejected; `tsbuildinfo` must not point at an input or a
directory. Use a dedicated generated-output directory.

For programmatic usage, `await watch(config, options)` performs the initial build
and returns a handle with an async `close()` method to release subscriptions.
Set `options.config` to the CommonJS config path to enable configuration reloading.

## Gotchas

- New `@types/*` package: TypeScript 7 does **not** auto-include `@types`. Add it to `types` in every tsconfig used here, or the build breaks with `Cannot find name`.
- `mapStyle: "inline"` embeds the map as a data URL (good for distributed scripts); `"external"` writes a sibling `.map` (good for local development).
- Decorator arguments and top-level executable statements referencing same-bundle values are not part of ordering analysis (only `extends` is). Keep eval-time values in leaf files.
- Ordering uses TypeScript 7's AST and symbol checker, including global classes,
  nested/merged namespaces, lexical shadowing and internal `import Alias = ...`
  initializers. Comments and string/template literals do not create dependencies.
- Dynamic heritage such as `extends mixin(Base)` or computed base expressions is
  rejected with a source location. Named bases and `extends null` are supported.
  Ordering operates on whole files; it does not repair statement order within a
  file or arbitrary constructor-variable initialization chains.
- Module checks inspect source ASTs before bundling, including type-only
  imports/exports and `moduleDetection: "force"`, even when emit is CommonJS.
  Syntax analysis uses the pinned TypeScript peer's `unstable` API in an isolated
  ESM worker; the public bundler API remains synchronous CommonJS. Actual rebuilds
  incur an additional process startup; cache hits skip this analysis.

## Performance benchmarks

Run `npm run bench -- --files 200 --runs 5` for cold, no-op, touch,
single-file edit and watch measurements. The benchmark reports phase timings,
raw samples and parent-process peak RSS, and cleans up temporary fixtures.
See [methodology and baseline results](bench/BASELINE.md) in the source repository
for measurement limits and the 200/1000-file reference runs.

## License

MIT
