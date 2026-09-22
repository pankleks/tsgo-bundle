# Performance baseline

Measured on 2026-09-22 after correctness fixes 1–4, before performance optimization.
Environment: Windows x64, Node 24.17.0, TypeScript 7.0.2,
AMD Ryzen 7 9700X, 16 logical CPUs.

## Reproduce

```sh
npm run bench -- --files 200 --runs 5
npm run bench -- --files 1000 --runs 3
```

The runner emits JSON containing environment, settings, summaries and every raw
sample. Redirect stdout to a file if desired; use `node bench/run.cjs` directly
for JSON without npm's command banner. Fixtures live in the OS temporary directory
and are removed in `finally`. No fixture or benchmark output is published in the
npm package. No production instrumentation or new dependencies are required.

## Methodology and scope

- One namespace project with 200/1000 class files, 20 fields per class and chains
  of ten classes. Filenames put derived classes ahead of their bases. One extra
  marker source provides the single-file mutation.
- Native compiler incremental emit, JS and declaration bundles, external maps
  for both outputs. This is a synthetic workload, not a representative claim
  about every real application. Edits change a leaf constant, not a base class.
- One untimed force-build warms filesystem caches. **Cold means cleared emit and
  tsbuildinfo via `--force`, not a cold OS disk cache.** It includes force safety
  checks and deletion. Subsequent cases run in order: no-op, touch, leaf edit.
- Each non-watch sample uses a fresh Node worker. `medianMs` times `build()`;
  `processWallMedianMs` includes worker startup/imports, verification and shutdown.
  It is not a measurement of the CLI argument parser.
- Watch runs in one resident process, after an initial untimed build. Latency
  starts before the source write and ends after `Build complete.` (subscriptions
  refreshed). It includes the 150 ms debounce and up to 10 ms polling overhead.
  A 500 ms settling interval separates mutations and is outside measured time.
- Export wrappers measure phases with `performance.now()`. Scan times aggregate
  all calls within a sample. `process listFiles` is inside `programFiles` and
  `process syntax` is inside `orderedSources`: **do not add both levels**.
  Force validation, filesystem deletion, watch subscription management and other
  glue are included in totals but not separately timed. Medians of phases need
  not sum to the median total.
- RSS is `process.resourceUsage().maxRSS / 1024`: **parent Node process only**,
  excluding compiler, AST worker and native API server. Watch RSS is a lifetime
  high-water mark, not per-rebuild retained memory or evidence of a memory leak.
  Full process-tree peak memory and a long-running heap profile remain unmeasured.
- Benchmark assertions verify no-op/touch skip, edit/watch rebuild, marker content
  and declaration-map presence. Failures abort rather than becoming timing data.
- Runs were sequential on one machine; 3–5 repetitions support a baseline, not
  robust tail-latency statistics. Repeat identically before comparing changes.

## Results

All times in milliseconds. RSS is the maximum parent-process high-water mark
across the samples (MiB).

| Class files / runs | Case | Median build/latency | Min–max | Process wall median | Parent RSS |
|---|---|---:|---:|---:|---:|
| 200 / 5 | cold | 1007.86 | 987.32–1016.01 | 1050.92 | 78.07 |
| 200 / 5 | no-op | 14.81 | 14.33–15.47 | 54.98 | 61.00 |
| 200 / 5 | touch | 15.80 | 15.57–16.11 | 56.30 | 61.00 |
| 200 / 5 | edit | 685.75 | 658.76–694.10 | 729.51 | 77.00 |
| 200 / 5 | watch | 889.02 | 865.31–923.44 | — | 102.92 |
| 1000 / 3 | cold | 3562.95 | 3521.78–3608.80 | 3615.99 | 124.41 |
| 1000 / 3 | no-op | 52.49 | 51.21–53.17 | 95.45 | 69.52 |
| 1000 / 3 | touch | 53.11 | 51.27–53.93 | 94.60 | 69.57 |
| 1000 / 3 | edit | 1615.05 | 1599.79–1727.64 | 1661.34 | 127.82 |
| 1000 / 3 | watch | 1872.07 | 1865.07–1914.76 | — | 245.27 |

### Phase medians for 1000 class files

| Phase | Cold | Single-file edit | Watch edit |
|---|---:|---:|---:|
| All input scans | 176.32 | 134.86 | 169.33 |
| Program file discovery | 135.91 | 132.80 | 138.86 |
| Hash snapshot | 299.97 | 248.50 | 256.75 |
| Compiler emit process | 1642.33 | 249.10 | 247.22 |
| Source ordering including syntax worker | 376.26 | 371.89 | 388.42 |
| JS bundle | 131.66 | 121.10 | 98.32 |
| Declaration bundle | 326.35 | 368.21 | 316.20 |
| State writes | 2.97 | 2.52 | 2.59 |

No-op input scanning accounts for 49.74 of 52.49 ms. Within edit ordering,
the syntax-worker subprocess accounts for 289.63 of 371.89 ms.

## Optimization candidates supported by these measurements

1. Reuse unchanged declaration/JS map work. In this workload declaration merging
   alone exceeds incremental compiler emit time; investigate per-file processing
   caches and skipping identical declaration bundles.
2. Avoid rehashing all unchanged inputs (248.50 ms per edit here), retaining the
   correctness checks for changes during compilation and failed builds.
3. Share file discovery / syntax analysis work, or retain a native compiler API
   session in watch mode. Measure memory and lifecycle costs before adopting it.
4. Reduce repeated input scans, particularly in watch and no-op paths. Keep
   additions, deletions and external configuration/dependency tracking correct.
5. Profile the 1000-file watch memory curve over many rebuilds with GC/heap data
   and process-tree sampling before concluding that the rising high-water mark
   is a leak or choosing a memory optimization.

No speedup is claimed yet; these are baseline observations for the next step.

## Step 6: incremental optimization comparison

Repeated `npm run bench -- --files 1000 --runs 3` on the same environment after
reusing hashes for unchanged inputs and adding a declaration-bundle cache.
The workload and runner were unchanged.

| Case | Baseline median ms | Optimized median ms | Change |
|---|---:|---:|---:|
| Cold | 3562.95 | 3694.07 | 3.7% slower |
| No-op | 52.49 | 54.03 | +1.54 ms |
| Touch | 53.11 | 56.51 | +3.40 ms |
| Single-file edit | 1615.05 | 1498.17 | 7.2% faster |
| Watch edit | 1872.07 | 1750.52 | 6.5% faster |

Input hash snapshot time for edits fell from 248.50 to 1.34 ms. Declaration cache
bookkeeping adds work/state size; cold builds populate its hashes while merging
already-read bytes, rather than rereading all emitted files. Parent peak RSS was
126.83 MiB cold, 138.87 MiB edit and 259.37 MiB watch; this is not a memory-saving
optimization. Only three runs were taken, so small changes warrant caution.

The benchmark changes an inferred literal constant: its public declaration
changes too, so **declaration merging is not skipped in this comparison**. The
reuse path is covered by an integration regression with a same-width function
body change, including artifact damage, type signature changes and embedded
source content. It applies only when declaration text, maps, ordering, project
configuration, compiler and existing output hashes match. Changing source
positions can change declaration maps even if the public types are identical.

This improves incremental latency, with a measured small cold-build cost. It does
not eliminate the extra compiler processes or all scans; those remain future
optimization candidates rather than claimed improvements.
