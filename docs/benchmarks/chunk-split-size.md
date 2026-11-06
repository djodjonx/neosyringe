# Chunk split size

Measured on 2026-11-06 with this command, from the repo root, after `pnpm build`:

```bash
node scripts/measure-chunk-split.mjs
```

esbuild only. Rollup is not used. `scripts/ci/consumer-dist.mjs` is a CI check, not a measure. No threshold. Nothing under `.github/` is changed.

## What ran

`scripts/measure-chunk-split.mjs` builds `tests/e2e/fixtures/chunk-split/app.ts` with the real plugin (`packages/unplugin/src/index.ts:64`) and esbuild. The build options are `bundle: true`, `splitting: true`, `format: 'esm'`, `metafile: true`, `write: false`, `platform: 'node'` (`scripts/measure-chunk-split.mjs:288-293`). Each cell is built twice, minify off then on. `NODE_ENV` is `production`, and `process.env.NODE_ENV` is defined as `"production"`. Plugin validation stays strict (`packages/unplugin/src/index.ts:150`).

The script printed:

- Node `v22.23.2`, zlib `1.3.1-e00f703`
- `Darwin 27.2.0 darwin`
- `Apple M4 Max x16`
- esbuild `0.27.2`
- TypeScript `5.9.3`
- `@djodjonx/neosyringe` `0.3.0`

Gzip is level 9 and Brotli is quality 11. Both compress the **minified** text.

Four cells: open or closed, full or minimal. Open omits `optimization`. Closed sets `optimization: { mode: 'closed', roots: [port] }`. Full omits `runtime`. Minimal sets `runtime: { profile: 'minimal' }`. The static control is the same container with a top-level `import { Heavy } from './heavy'` and no `import()`.

The heavy provider is generated into the build directory: 500 methods, xorshift32 seed `0x2545f491`. It is not a registered token. The root factory is the only thing that loads it, through `await import('./heavy')`. The container stays in the entry file.

Roles come from the esbuild metafile, not from file names. esbuild also sets `entryPoint` on the dynamic chunk (`scripts/measure-chunk-split.mjs:143-144`). The initial root is the output that has `entryPoint` and that no other output imports. An output reached from that root only through `imports[].kind === 'import-statement'` is initial. An output reached only by a path that uses `dynamic-import` is deferred. Raw and minified outputs are paired by the set of `outputs[*].inputs` keys.

Each raw build and each minified build was executed. All five returned `{"tag":"CHUNK_SPLIT_HEAVY","marker":"CHUNK_SPLIT_CONTAINER"}`.

The bytes depend on the absolute build path and on the Node zlib version (gzip). The file name is hashed into the container id (`packages/core/src/analyzer/shared/HashUtils.ts:157-160`) and into the generated class suffix (`packages/core/src/generator/Generator.ts:150-154`). The script builds in a fixed directory per checkout. Another checkout, or another Node zlib build, can print other gzip bytes. These numbers are not a promise.

## Bytes

| Scenario | Role | Raw bytes | Minified bytes | Gzip bytes | Brotli bytes | Sentinel | Marker |
|----------|------|-----------|----------------|------------|--------------|----------|--------|
| `open-full` | initial | 16814 | 8237 | 2404 | 2128 | no | yes |
| `open-full` | deferred | 29546 | 22481 | 8698 | 7072 | yes | no |
| `open-minimal` | initial | 11044 | 6162 | 2020 | 1769 | no | yes |
| `open-minimal` | deferred | 29546 | 22481 | 8698 | 7072 | yes | no |
| `closed-full` | initial | 16397 | 8260 | 2440 | 2144 | no | yes |
| `closed-full` | deferred | 29546 | 22481 | 8698 | 7072 | yes | no |
| `closed-minimal` | initial | 11338 | 6362 | 2098 | 1843 | no | yes |
| `closed-minimal` | deferred | 29546 | 22481 | 8698 | 7072 | yes | no |
| `control-static` | initial | 42658 | 28605 | 11115 | 8713 | yes | yes |

`control-static` has no deferred chunk.

## What this does not say

The deferred chunk is the same in the four split cells. The heavy provider is not removed in closed mode: the root factory reaches it. `closed-full` is 16397 raw against `open-full` 16814 raw, and 8260 minified against 8237 minified. No gain is claimed.

Minimal is a different feature set. The optimized emitter is used when the profile is minimal or the mode is closed (`packages/core/src/generator/Generator.ts:201-203`). Do not read the smaller initial chunk as a free saving.

One synthetic provider, one graph, one machine, esbuild only. Rollup is not measured. A real provider can be smaller or larger, and its text changes how well it compresses. The single cjs bundles of `scripts/measure-t17-size.mjs` still do not split chunks (`scripts/measure-t17-size.mjs:158`).
