# tsgo-bundle

Single-file bundler for TypeScript **global-script** (`namespace`) projects compiled with [tsgo](https://github.com/microsoft/typescript-go) (`@typescript/native-preview`). A drop-in replacement for the removed tsc `outFile` option — without migrating a large codebase to ES modules.

How it works: each project is compiled per-file (`outDir`, never `outFile`), then concatenated reference-first with merged source maps. Chunk order additionally guarantees every base class evaluates before its subclasses, so reference cycles cannot silently break the bundle at runtime.

## Install

```bash
npm i -D tsgo-bundle @typescript/native-preview
```

`@typescript/native-preview` is a peer dependency (the compiler this tool drives).

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
            tsbuildinfo: "wwwroot/.build/Components.tsbuildinfo", // for --force wipe
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
- **Incremental by content hash** (like `tsc -b`, but hash-checked): unchanged builds skip in milliseconds, mere touches without content change skip too, `--force` wipes emit and rebuilds cold.
- Configs usually keep `noEmitOnError: false`: bundles refresh even with type errors, but the exit code is nonzero — check it, not artifact presence.

## Gotchas

- New `@types/*` package: tsgo does **not** auto-include `@types` (tsc did). Add it to `types` in every tsconfig used here, or only the tsgo build breaks with `Cannot find name`.
- `mapStyle: "inline"` embeds the map as a data URL (good for distributed scripts); `"external"` writes a sibling `.map` (good for local development).
- Decorator arguments and top-level executable statements referencing same-bundle values are not part of ordering analysis (only `extends` is). Keep eval-time values in leaf files.

## License

MIT
