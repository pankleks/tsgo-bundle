# tsgo-bundle Contributor Instructions

## Project Structure

- `./package.json`: dependencies and the `test` script (`vitest run`).
- `./bin/cli.cjs`: thin CLI (`--config`, `--only`, `--watch`, `--force`).
- `./lib/`: bundler modules, all CommonJS (`order`, `merge`, `state`, `build`, `guard` in `merge`, `resolve-compiler`, `util`), re-exported from `./lib/index.cjs` for tests.
- `./test/`: vitest suites (`.test.mjs`, ESM) with tmp fixture workspaces (`./test/helpers.cjs`). Fixtures are generated at runtime, never committed.
- `./.github/workflows/ci.yml`: node 22/24 x ubuntu/windows.

## Build Commands

- `npm test`: run the full suite (`vitest run`).
- `npm pack --dry-run`: verify published file list before release.

## Coding Conventions

- End every statement with `;`.
- Prefer `const` and `let`; never use `var`.
- Related variables share one declaration block (see existing lib files).
- Library code stays dependency-free except `@jridgewell/sourcemap-codec`; the TypeScript compiler is a peer dependency resolved at runtime with fallbacks.
- No runtime behavior change without a test: ordering, merging, skipping and failure modes are all covered in `./test/`.

## Scope Notes

- Do not introduce runtime external dependencies into the published bundle path.
- Keep changes consistent with the style and structure used in existing code.
