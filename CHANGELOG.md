# Changelog

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
