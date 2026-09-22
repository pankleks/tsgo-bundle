# Changelog

## 1.2.0

- Reuse input hashes on incremental rebuilds and skip merging unchanged declaration bundles/maps, checking output integrity and respecting embedded sources and `--force`.
- Collect declaration emit hashes from bytes already read during merging; document measured incremental gains and cold-build tradeoffs.
- Add a reproducible performance benchmark for cold/no-op/touch/edit/watch, phase timings and parent-process peak RSS, with documented 200/1000-file baselines.
- Replace regex-based heritage/reference/module analysis with the TypeScript 7 AST and symbol checker, isolated in a worker using the existing compiler peer.
- Resolve global classes, nested namespaces, lexical shadowing, Unicode identifiers and internal aliases; reject unsupported dynamic heritage explicitly.
- Reject source modules even after CommonJS or type-only transformations; add executable bundle regressions using `node:vm`.
- Validate all `--force` cleanup paths before modifying any project, protecting source/config inputs, other projects and symlinked paths.
- Share cache/watch input definitions; watch declarations, external dependencies and extra files, and refresh subscriptions after builds and config reloads.
- Reload the CommonJS bundler configuration and its dependencies in watch mode, with recovery after configuration errors.
- Clean only once for `--watch --force`; expose `watch().close()` and recover from replaced watch directories and edits during compilation.
- Watch integration tests now require a single filesystem mutation to be observed instead of retrying mutations.
- Keep compiler/bundler stamps and configuration fingerprints per project, including builds selected with `--only`.
- Track tsconfigs, inherited JSONC/package configs, compiler-discovered declarations, package manifests and workspace lockfiles as incremental inputs.
- Invalidate project state before rebuilding so failed builds cannot leave stale bundles after source changes are reverted.
- Snapshot inputs before compilation and avoid caching builds whose inputs changed during compilation.
- Bump the state format to version 2; existing version 1 caches rebuild automatically.

## 1.1.3

- Use the stable TypeScript 7.0.2 `tsc` compiler instead of `@typescript/native-preview`.

## 1.1.2

- Fix `orderedSources` returning an empty source list on Windows: tsgo `--listFilesOnly` prints forward-slash paths (`C:/...`) while `root` uses backslashes (`C:\...`), so the raw `startsWith(root)` filter never matched. Paths are now compared via a new `isInside` helper that resolves both sides first.

## 1.1.1

- Failed builds no longer update the incremental state: retrying a still-broken build fails again instead of silently skipping as up to date.

## 1.1.0

- New per-project `sourcesContent` option (default `false`): embed on-disk sources in merged maps. Enable it for self-contained distributed bundles and source-mapped coverage; leave it off for local development maps.
- `bundle()` creates the output directory when missing.

## 1.0.0

- Initial public release.
- Per-file tsgo emit + reference-first concatenation (replacement for removed tsc `outFile`).
- Heritage-aware ordering: base classes always bundle before subclasses; reference cycles broken deterministically with a log line; heritage-only cycles fail loudly.
- Merged source maps (external or inline) via `@jridgewell/sourcemap-codec`, no `sourcesContent` (maps reference on-disk sources).
- Content-hash incremental builds with skip, `--force` cold rebuilds, `--watch` mode.
- Loud failure on top-level `import`/`export` in program sources (global-script contract).
- CLI: `--config`, `--only`, `--watch`, `--force`; Node >= 22.
