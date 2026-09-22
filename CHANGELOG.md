# Changelog

## 1.0.0

- Initial public release.
- Per-file tsgo emit + reference-first concatenation (replacement for removed tsc `outFile`).
- Heritage-aware ordering: base classes always bundle before subclasses; reference cycles broken deterministically with a log line; heritage-only cycles fail loudly.
- Merged source maps (external or inline) via `@jridgewell/sourcemap-codec`, no `sourcesContent` (maps reference on-disk sources).
- Content-hash incremental builds with skip, `--force` cold rebuilds, `--watch` mode.
- Loud failure on top-level `import`/`export` in program sources (global-script contract).
- CLI: `--config`, `--only`, `--watch`, `--force`; Node >= 22.
