// Size of the factory lease helpers of the optimized emitter (packages/core/src/generator/factoryLeaseEmitter.ts:96,125,142).
// Run from the repo root: node docs/benchmarks/data/stage-d-fix/partB-lease-size.mjs
// It bundles factoryLeaseEmitter.ts with esbuild, writes the text of the two helpers and of one declaration (policy and
// read), minifies it with esbuild (minify, no bundle) and prints raw, minified and gzip level 9 bytes.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = process.cwd();
const esbuild = createRequire(resolve(root, 'packages/unplugin/package.json'))('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'partb-'));
const out = join(dir, 'lease.mjs');
esbuild.buildSync({
  entryPoints: [resolve(root, 'packages/core/src/generator/factoryLeaseEmitter.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
});
const lease = await import(pathToFileURL(out).href);
const textOf = (helper) => helper.parts.map((part) => part.text ?? String(part)).join('');
function measure(label, text) {
  const wrapped = `class C {\n${text}\n}`;
  const min = esbuild.transformSync(wrapped, { loader: 'ts', minify: true }).code;
  console.log(`${label}\traw ${wrapped.length}\tminified ${min.length}\tgzip ${gzipSync(min, { level: 9 }).length}`);
}
const helpers = lease.factoryLeaseHelpers('C');
for (const helper of helpers) measure(`helper ${helper.id}`, textOf(helper));
measure('both helpers', helpers.map(textOf).join('\n'));
const declaration = [
  lease.emitFactoryPolicy('C', 'make', [{ keyExpression: 'Dep', mode: 'simple' }]),
  lease.emitFactoryRead('C', 'make', 'return host.resolve(token);'),
].join('\n');
measure('one declaration (policy + read)', declaration);
measure('both helpers + one declaration', `${helpers.map(textOf).join('\n')}\n${declaration}`);
rmSync(dir, { recursive: true, force: true });
