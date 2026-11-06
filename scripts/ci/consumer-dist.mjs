#!/usr/bin/env node
// scripts/ci/consumer-dist.mjs
// Does not build. Requires a prebuilt packages/*/dist (run `pnpm build` first).
// Packs every non-private package under packages/, installs those tarballs plus
// typescript, esbuild and rollup from the registry in a temporary directory
// outside this repo, then typechecks, bundles and resolves a published token.
// T21: each tarball is proven to carry the build on disk (scripts/ci/lib/tarball-proof.mjs), then the
// integrated scenario and the closed bundle are compiled by the installed plugin and run.
// The temporary directory is removed in finally.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertDistNewerThanSrc, assertTarballFromBuild, declaredEntries } from './lib/tarball-proof.mjs';

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const started = Date.now();
const tmp = mkdtempSync(path.join(os.tmpdir(), 'neosyringe-consumer-dist-'));
const packDir = path.join(tmp, 'packs');
const consumerDir = path.join(tmp, 'consumer');
const producerDir = path.join(tmp, 'producer');
let failed = false;
let networkUsed = false;

// Measured on this tree (consumer-dist, 2026-11-01): esbuild 232 bytes, rollup 1374 bytes.
// Bound is about twice the larger bundle. A typescript import is far above it. Do not raise it.
const RUNTIME_BUNDLE_MAX_BYTES = 3072;

const NAMED = [
  ['@djodjonx/neosyringe-core/analyzer', 'Analyzer'],
  ['@djodjonx/neosyringe-core/analyzer', 'readTokensManifest'],
  ['@djodjonx/neosyringe-core/generator', 'Generator'],
  ['@djodjonx/neosyringe-core/generator', 'writeTokensManifest'],
  ['@djodjonx/neosyringe-core/context', 'TSContext'],
  ['@djodjonx/neosyringe', 'useInterface'],
  ['@djodjonx/neosyringe-plugin', 'neoSyringePlugin'],
  ['@djodjonx/neosyringe-ui', 'buildStandaloneHtml'],
];

const FORBIDDEN_BUNDLE = [
  'require("typescript")',
  "require('typescript')",
  'from "typescript"',
  "from 'typescript'",
  'ts.createProgram',
  'ScriptTarget',
  '@djodjonx/neosyringe-ui',
  'buildStandaloneHtml',
];

function step(line) {
  console.log(`consumer-dist: ${line}`);
}

function fail(message) {
  console.error(message);
  failed = true;
  throw new Error(message);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function packageDirs() {
  const packagesDir = path.join(root, 'packages');
  return readdirSync(packagesDir)
    .map((name) => path.join(packagesDir, name))
    .filter((dir) => existsSync(path.join(dir, 'package.json')));
}

function parsePack(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) fail(`pnpm pack did not return json:\n${output}`);
  const parsed = JSON.parse(output.slice(start, end + 1));
  const filename = parsed.filename ?? parsed.name;
  if (typeof filename !== 'string' || !filename.endsWith('.tgz')) {
    fail(`pnpm pack json has no tarball:\n${output}`);
  }
  return path.isAbsolute(filename) ? filename : path.join(packDir, filename);
}

function fileSpec(abs) {
  return `file:${abs}`;
}

function installedPackageDir(name, base = consumerDir) {
  return path.join(base, 'node_modules', ...name.split('/'));
}

function assertEntries(dir, label) {
  const pkg = readJson(path.join(dir, 'package.json'));
  for (const rel of declaredEntries(pkg)) {
    const file = path.join(dir, rel);
    if (!existsSync(file)) fail(`missing dist entry (${label}): ${file}`);
  }
}

function noteNetwork(result) {
  if (/https?:\/\//.test(result.output)) networkUsed = true;
}

function npmInstall(cwd, extraArgs) {
  const result = run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    ...extraArgs,
  ], cwd);
  noteNetwork(result);
  return result;
}

function lockfileVersion(importer, depName) {
  const lines = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8').split('\n');
  const header = `  ${importer}:`;
  let inImporter = false;
  let inDep = false;
  for (const line of lines) {
    if (/^ {2}[^ ]/.test(line) && line.endsWith(':')) {
      inImporter = line === header;
      inDep = false;
      continue;
    }
    if (!inImporter) continue;
    if (line === `      ${depName}:`) {
      inDep = true;
      continue;
    }
    if (inDep && line.startsWith('        version: ')) {
      const version = line.slice('        version: '.length).trim().split('(')[0];
      if (!/^\d+\.\d+\.\d+/.test(version)) fail(`lockfile version for ${importer} ${depName} is ${version}`);
      return version;
    }
    if (inDep && line.startsWith('      ') && !line.startsWith('        ')) inDep = false;
  }
  fail(`lockfile has no version for ${importer} ${depName}`);
}

function registryDeps() {
  return {
    typescript: lockfileVersion('packages/core', 'typescript'),
    esbuild: lockfileVersion('packages/unplugin', 'esbuild'),
    rollup: lockfileVersion('packages/unplugin', 'rollup'),
  };
}

function assertInsideConsumer(file, label) {
  const real = realpathSync(file);
  const consumer = realpathSync(consumerDir);
  if (!real.startsWith(`${consumer}${path.sep}`) && real !== consumer) {
    fail(`${label} resolved outside the consumer: ${real}`);
  }
  if (real.startsWith(`${root}${path.sep}`)) fail(`${label} resolved into the monorepo: ${real}`);
}

try {
  const tmpReal = realpathSync(tmp);
  if (tmpReal.startsWith(`${root}${path.sep}`)) fail(`temp dir is inside the repo: ${tmpReal}`);
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });

  const versions = registryDeps();
  const packed = [];
  for (const dir of packageDirs()) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg.private === true) continue;
    for (const rel of declaredEntries(pkg)) {
      if (!existsSync(path.join(dir, rel))) {
        fail(`prebuilt dist is missing: ${path.join(dir, rel)}. This script does not build.`);
      }
    }
    const packedRun = run('pnpm', ['pack', '--json', '--pack-destination', packDir], dir);
    if (packedRun.status !== 0) fail(`pnpm pack failed for ${pkg.name}\n${packedRun.output}`);
    const tarball = parsePack(packedRun.stdout);
    if (!existsSync(tarball)) fail(`missing tarball for ${pkg.name}: ${tarball}`);
    for (const rel of declaredEntries(pkg)) {
      assertDistNewerThanSrc(path.join(dir, rel), path.join(dir, 'src'));
    }
    const proof = assertTarballFromBuild(tarball, dir);
    step(`tarball ${path.basename(tarball)} carries the disk build (${proof.distFiles} dist files, version ${proof.version})`);
    packed.push({ name: pkg.name, tarball });
  }
  step(`packed ${packed.length} tarballs`);

  const dependencies = {};
  for (const item of packed) dependencies[item.name] = fileSpec(item.tarball);
  Object.assign(dependencies, versions);
  writeFileSync(path.join(consumerDir, 'package.json'), `${JSON.stringify({
    name: 't15-consumer',
    private: true,
    dependencies,
  }, null, 2)}\n`);

  let installed = npmInstall(consumerDir, ['--prefer-offline']);
  if (installed.status !== 0) {
    rmSync(path.join(consumerDir, 'node_modules'), { recursive: true, force: true });
    rmSync(path.join(consumerDir, 'package-lock.json'), { force: true });
    installed = npmInstall(consumerDir, []);
  }
  if (installed.status !== 0) fail(`npm install failed\n${installed.output}`);
  step(`installed tarballs (typescript ${versions.typescript}, esbuild ${versions.esbuild}, rollup ${versions.rollup}, npm network: ${networkUsed ? 'yes' : 'no'})`);

  for (const item of packed) {
    const dir = installedPackageDir(item.name);
    if (!existsSync(path.join(dir, 'package.json'))) fail(`package was not installed: ${item.name}`);
    assertEntries(dir, 'installed');
    const installedPkg = readJson(path.join(dir, 'package.json'));
    const depText = JSON.stringify(installedPkg.dependencies ?? {});
    if (depText.includes('workspace:')) fail(`${item.name} still depends on workspace:`);
    assertInsideConsumer(path.join(dir, 'package.json'), item.name);
  }
  const pluginPkg = readJson(path.join(installedPackageDir('@djodjonx/neosyringe-plugin'), 'package.json'));
  if (pluginPkg.sideEffects === false) {
    fail('plugin package.json sideEffects is false; createUnplugin runs at import');
  }
  const runtimePkg = readJson(path.join(installedPackageDir('@djodjonx/neosyringe'), 'package.json'));
  if (runtimePkg.sideEffects !== false) {
    fail('runtime package sideEffects must be false so an unused import can be dropped');
  }
  step('installed entries exist');

  const tsc = path.join(consumerDir, 'node_modules/.bin/tsc');
  const esbuildBin = path.join(consumerDir, 'node_modules/esbuild/package.json');
  const rollupBin = path.join(consumerDir, 'node_modules/rollup/package.json');
  if (!existsSync(tsc)) fail(`consumer tsc is missing: ${tsc}`);
  if (!existsSync(esbuildBin)) fail(`consumer esbuild is missing: ${esbuildBin}`);
  if (!existsSync(rollupBin)) fail(`consumer rollup is missing: ${rollupBin}`);
  assertInsideConsumer(tsc, 'tsc');
  assertInsideConsumer(esbuildBin, 'esbuild');
  assertInsideConsumer(rollupBin, 'rollup');

  writeFileSync(path.join(consumerDir, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
    files: ['app.mts', 'lsp.cts'],
  }, null, 2)}\n`);
  writeFileSync(path.join(consumerDir, 'app.mts'), [
    "import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';",
    "import { Generator } from '@djodjonx/neosyringe-core/generator';",
    "import { TSContext } from '@djodjonx/neosyringe-core/context';",
    "import { useInterface } from '@djodjonx/neosyringe';",
    "import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';",
    "import transformer from '@djodjonx/neosyringe-plugin/transformer';",
    "import { buildStandaloneHtml } from '@djodjonx/neosyringe-ui';",
    'export const surface = [Analyzer, Generator, TSContext, useInterface, neoSyringePlugin, transformer, buildStandaloneHtml];',
    '',
  ].join('\n'));
  writeFileSync(path.join(consumerDir, 'lsp.cts'), [
    "import lsp = require('@djodjonx/neosyringe-lsp');",
    'export const surface = lsp;',
    '',
  ].join('\n'));

  const typecheck = run(tsc, ['--noEmit', '-p', path.join(consumerDir, 'tsconfig.json')], consumerDir);
  if (typecheck.status !== 0) fail(`tsc failed\n${typecheck.output}`);
  step('tsc ok');

  writeFileSync(path.join(consumerDir, 'probe.mjs'), `
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const consumer = ${JSON.stringify(realpathSync(consumerDir))};
const repo = ${JSON.stringify(root)};
const require = createRequire(import.meta.url);
const named = ${JSON.stringify(NAMED)};

function insideConsumer(file) {
  const real = realpathSync(file);
  if (!real.startsWith(consumer + path.sep)) {
    throw new Error('resolved outside the consumer: ' + file + ' -> ' + real);
  }
  if (real.startsWith(repo + path.sep)) {
    throw new Error('resolved into the monorepo: ' + file + ' -> ' + real);
  }
}

function present(value, spec, name) {
  if (name === 'neoSyringePlugin') {
    if (value == null || (typeof value.vite !== 'function' && typeof value.rollup !== 'function')) {
      throw new Error('export missing: ' + spec + ' ' + name);
    }
    return;
  }
  if (typeof value !== 'function') throw new Error('export missing: ' + spec + ' ' + name);
}

for (const [spec, name] of named) {
  const esm = await import(spec);
  present(esm[name], spec, name);
  insideConsumer(fileURLToPath(import.meta.resolve(spec)));
  const cjs = require(spec);
  present(cjs[name], spec, name);
  insideConsumer(require.resolve(spec));
}

const esmTransformer = await import('@djodjonx/neosyringe-plugin/transformer');
if (typeof esmTransformer.default !== 'function') throw new Error('esm transformer default missing');
insideConsumer(fileURLToPath(import.meta.resolve('@djodjonx/neosyringe-plugin/transformer')));
const cjsTransformer = require('@djodjonx/neosyringe-plugin/transformer');
const transformerFn = typeof cjsTransformer === 'function' ? cjsTransformer : cjsTransformer.default;
if (typeof transformerFn !== 'function') throw new Error('cjs transformer export missing');
insideConsumer(require.resolve('@djodjonx/neosyringe-plugin/transformer'));

const lsp = require('@djodjonx/neosyringe-lsp');
const lspFn = typeof lsp === 'function' ? lsp : lsp.default;
if (typeof lspFn !== 'function') throw new Error('cjs lsp export missing');
insideConsumer(require.resolve('@djodjonx/neosyringe-lsp'));
`);
  const probe = run(process.execPath, [path.join(consumerDir, 'probe.mjs')], consumerDir);
  if (probe.status !== 0) fail(`import/require failed\n${probe.output}`);
  step('import and require ok');

  const bin = path.join(consumerDir, 'node_modules/.bin/neosyringe-check');
  if (!existsSync(bin)) fail(`installed CLI bin is missing: ${bin}`);
  if (!lstatSync(bin).isSymbolicLink()) fail('installed CLI bin is not the npm symlink');
  assertInsideConsumer(bin, 'cli bin');
  const cli = run(bin, ['--project', 'does-not-exist.json'], consumerDir);
  if (cli.status === 0) fail(`installed CLI through its symlink exited 0\n${cli.output}`);
  if (!cli.output.includes('[NeoSyringe]')) fail(`installed CLI through its symlink printed nothing\n${cli.output}`);
  step('installed CLI symlink prints and exits non-zero');

  const effectDir = path.join(consumerDir, 'node_modules/@acme/effect');
  mkdirSync(effectDir, { recursive: true });
  writeFileSync(path.join(effectDir, 'package.json'), `${JSON.stringify({
    name: '@acme/effect',
    version: '1.0.0',
    type: 'module',
    sideEffects: ['./effect.js'],
    exports: {
      './effect.js': './effect.js',
      './dropped.js': './dropped.js',
    },
  }, null, 2)}\n`);
  writeFileSync(path.join(effectDir, 'effect.js'), "export const marker = 'T15_EFFECT_STAYS';\nconsole.log(marker);\n");
  writeFileSync(path.join(effectDir, 'dropped.js'), "export const marker = 'T15_EFFECT_DROPPED';\nconsole.log(marker);\n");
  writeFileSync(path.join(consumerDir, 'bundle-unused.mjs'), [
    "import { useInterface } from '@djodjonx/neosyringe';",
    "import '@acme/effect/effect.js';",
    "import '@acme/effect/dropped.js';",
    'export const ready = 1;',
    '',
  ].join('\n'));
  writeFileSync(path.join(consumerDir, 'bundle-used.mjs'), [
    "import { useInterface } from '@djodjonx/neosyringe';",
    'console.log(useInterface.name);',
    '',
  ].join('\n'));

  const requireConsumer = createRequire(path.join(consumerDir, 'package.json'));
  const esbuild = requireConsumer('esbuild');
  const rollupPkg = requireConsumer('rollup');
  const rollup = rollupPkg.rollup;
  async function bundleEsbuild(entry) {
    const result = await esbuild.build({
      absWorkingDir: consumerDir,
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      treeShaking: true,
      legalComments: 'none',
      logLevel: 'silent',
    });
    return result.outputFiles[0].text;
  }
  function nearestPackageJson(file) {
    let dir = path.dirname(file);
    while (true) {
      const candidate = path.join(dir, 'package.json');
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  function listedSideEffect(file) {
    const pkgPath = nearestPackageJson(file);
    if (!pkgPath) return true;
    const flag = readJson(pkgPath).sideEffects;
    if (flag === false) return false;
    if (!Array.isArray(flag)) return true;
    const rel = path.relative(path.dirname(pkgPath), file).split(path.sep).join('/');
    return flag.some((entry) => String(entry).replace(/^\.\//, '') === rel);
  }
  function exportFile(pkg, subpath) {
    const node = pkg.exports?.[subpath];
    if (typeof node === 'string') return node;
    if (node && typeof node === 'object') {
      if (typeof node.import === 'string') return node.import;
      if (typeof node.default === 'string') return node.default;
    }
    if (subpath === '.') return pkg.module ?? pkg.main ?? null;
    return null;
  }
  function resolveFrom(specifier, importer) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      return path.resolve(path.dirname(importer), specifier);
    }
    const parts = specifier.split('/');
    const name = specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    const subpath = specifier.length === name.length ? '.' : `.${specifier.slice(name.length)}`;
    let dir = path.dirname(importer);
    while (true) {
      const pkgDir = path.join(dir, 'node_modules', ...name.split('/'));
      const pkgPath = path.join(pkgDir, 'package.json');
      if (existsSync(pkgPath)) {
        const target = exportFile(readJson(pkgPath), subpath);
        if (typeof target !== 'string') fail(`rollup export missing: ${specifier}`);
        return path.resolve(pkgDir, target);
      }
      const parent = path.dirname(dir);
      if (parent === dir) fail(`rollup could not resolve ${specifier}`);
      dir = parent;
    }
  }
  function nodeResolve() {
    return {
      name: 'node-resolve',
      resolveId(source, importer) {
        if (source.startsWith('\0') || source.startsWith('node:')) return false;
        const id = path.isAbsolute(source) && existsSync(source)
          ? source
          : resolveFrom(source, importer ?? path.join(consumerDir, 'package.json'));
        if (!existsSync(id)) fail(`rollup resolved a missing file: ${source} -> ${id}`);
        return { id, moduleSideEffects: listedSideEffect(id) };
      },
    };
  }
  async function bundleRollup(entry) {
    const build = await rollup({
      input: entry,
      plugins: [nodeResolve()],
      treeshake: { moduleSideEffects: (id) => listedSideEffect(id) },
      onwarn(warning, warn) {
        if (warning.code === 'CIRCULAR_DEPENDENCY' || warning.code === 'THIS_IS_UNDEFINED') return;
        warn(warning);
      },
    });
    try {
      const generated = await build.generate({ format: 'es' });
      return generated.output.map((chunk) => chunk.code ?? '').join('\n');
    } finally {
      await build.close();
    }
  }
  function assertUnused(text, label) {
    const runtimeMarker = 'NeoSyringe: useInterface<T>() called at runtime';
    if (text.includes(runtimeMarker)) fail(`${label}: unused @djodjonx/neosyringe import survived in the bundle`);
    if (!text.includes('T15_EFFECT_STAYS')) fail(`${label}: sideEffects file was dropped from the bundle`);
    if (text.includes('T15_EFFECT_DROPPED')) fail(`${label}: unlisted top-level effect was kept in the bundle`);
  }
  function assertRuntime(text, label) {
    for (const needle of FORBIDDEN_BUNDLE) {
      if (text.includes(needle)) fail(`${label} contains ${needle}`);
    }
    if (Buffer.byteLength(text) > RUNTIME_BUNDLE_MAX_BYTES) {
      fail(`${label} is ${Buffer.byteLength(text)} bytes; bound is ${RUNTIME_BUNDLE_MAX_BYTES}`);
    }
  }
  const unusedEsbuild = await bundleEsbuild(path.join(consumerDir, 'bundle-unused.mjs'));
  const unusedRollup = await bundleRollup(path.join(consumerDir, 'bundle-unused.mjs'));
  assertUnused(unusedEsbuild, 'esbuild');
  assertUnused(unusedRollup, 'rollup');
  step('unused runtime import dropped; listed sideEffects file kept; unlisted effect dropped');

  const usedEsbuild = await bundleEsbuild(path.join(consumerDir, 'bundle-used.mjs'));
  const usedRollup = await bundleRollup(path.join(consumerDir, 'bundle-used.mjs'));
  assertRuntime(usedEsbuild, 'esbuild runtime bundle');
  assertRuntime(usedRollup, 'rollup runtime bundle');
  step(`runtime bundle esbuild ${Buffer.byteLength(usedEsbuild)} bytes, rollup ${Buffer.byteLength(usedRollup)} bytes, bound ${RUNTIME_BUNDLE_MAX_BYTES}`);

  // T21: the integrated scenario and the closed bundle, compiled by the installed plugin and run.
  const t21Dir = path.join(consumerDir, 't21');
  const t21Fixtures = path.join(root, 'tests/e2e/fixtures');
  mkdirSync(path.join(t21Dir, 'out'), { recursive: true });
  cpSync(path.join(t21Fixtures, 't21-scenario.ts'), path.join(t21Dir, 'scenario.ts'));
  cpSync(path.join(t21Fixtures, 't21-closed'), path.join(t21Dir, 'closed'), { recursive: true });
  const t21Config = path.join(consumerDir, 'tsconfig.t21.json');
  writeFileSync(t21Config, `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    },
    include: ['t21/**/*.ts'],
  }, null, 2)}\n`);
  const t21Types = run(tsc, ['--noEmit', '-p', t21Config], consumerDir);
  if (t21Types.status !== 0) fail(`t21 fixtures do not typecheck against the tarballs\n${t21Types.output}`);
  const installedPlugin = requireConsumer('@djodjonx/neosyringe-plugin').neoSyringePlugin;
  const t21Warnings = [];
  async function bundleT21(entry, pluginOptions, nodeEnv) {
    const previousEnv = process.env.NODE_ENV;
    const previousWarn = console.warn;
    process.env.NODE_ENV = nodeEnv;
    console.warn = (...args) => { t21Warnings.push(String(args[0])); };
    try {
      const result = await esbuild.build({
        absWorkingDir: consumerDir,
        entryPoints: [entry],
        bundle: true,
        write: false,
        metafile: true,
        format: 'cjs',
        platform: 'node',
        logLevel: 'silent',
        define: { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) },
        plugins: [installedPlugin.esbuild({ project: t21Config, ...pluginOptions })],
      });
      return { code: result.outputFiles[0].text, metafile: result.metafile };
    } finally {
      console.warn = previousWarn;
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  }
  function runBundled(name, code) {
    const file = path.join(t21Dir, 'out', name);
    writeFileSync(file, code);
    const executed = run(process.execPath, [
      '-e',
      "require(process.argv[1]).run().then((value) => console.log(JSON.stringify(value)))",
      file,
    ], consumerDir);
    if (executed.status !== 0) fail(`t21 bundle ${name} failed to run\n${executed.output}`);
    return JSON.parse(executed.stdout.trim().split('\n').pop());
  }
  const scenario = await bundleT21('t21/scenario.ts', { validation: 'strict', testOverrides: true }, 'test');
  const scenarioReport = runBundled('scenario.cjs', scenario.code);
  const scenarioExpected = readJson(path.join(t21Fixtures, 't21-scenario.expected.json'));
  if (!isDeepStrictEqual(scenarioReport, scenarioExpected)) {
    fail(`t21 scenario from the tarballs differs from tests/e2e/fixtures/t21-scenario.expected.json\n${JSON.stringify(scenarioReport)}`);
  }
  if (t21Warnings.length > 0) fail(`t21 scenario build warned\n${t21Warnings.join('\n')}`);
  step(`t21 integrated scenario run from the tarballs equals the pinned report (${Object.keys(scenarioExpected).length} slices, no warnings)`);

  const closedBundle = await bundleT21('t21/closed/app.ts', {}, 'production');
  if (closedBundle.code.includes('T21_SENTINEL_UNREACHABLE')) fail('t21 closed bundle from the tarballs kept the unreachable sentinel');
  const closedCarried = Object.values(closedBundle.metafile.outputs).flatMap((output) => (
    Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file)
  ));
  if (closedCarried.some((file) => file.endsWith('heavy.ts'))) fail(`t21 closed bundle carries heavy.ts: ${closedCarried.join(', ')}`);
  if (!closedBundle.code.includes('T21_EFFECT_REQUIRED')) fail('t21 closed bundle from the tarballs lost the required effect');
  const closedReport = runBundled('closed.cjs', closedBundle.code);
  if (!isDeepStrictEqual(closedReport, { names: ['auth', 'log'], workerStarts: 1, effects: ['T21_EFFECT_REQUIRED'] })) {
    fail(`t21 closed bundle run differs\n${JSON.stringify(closedReport)}`);
  }
  step('t21 closed bundle from the tarballs: sentinel absent, effect run once, eager root started');

  const runtimeTarball = packed.find((item) => item.name === '@djodjonx/neosyringe')?.tarball;
  if (!runtimeTarball) fail('runtime tarball was not packed');
  mkdirSync(path.join(producerDir, 'src'), { recursive: true });
  cpSync(path.join(root, 'tests/e2e/fixtures/t15-producer/src'), path.join(producerDir, 'src'), { recursive: true });
  writeFileSync(path.join(producerDir, 'package.json'), `${JSON.stringify({
    name: '@acme/tokens',
    version: '1.0.0',
    private: true,
    dependencies: { '@djodjonx/neosyringe': fileSpec(runtimeTarball) },
  }, null, 2)}\n`);
  writeFileSync(path.join(producerDir, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: 'src',
      outDir: 'dist',
      skipLibCheck: true,
    },
    include: ['src'],
  }, null, 2)}\n`);
  const producerInstall = npmInstall(producerDir, ['--prefer-offline']);
  if (producerInstall.status !== 0) fail(`producer npm install failed\n${producerInstall.output}`);
  const compiled = run(tsc, ['-p', path.join(producerDir, 'tsconfig.json')], producerDir);
  if (compiled.status !== 0) fail(`producer tsc failed\n${compiled.output}`);
  const manifestCmd = run(bin, [
    '--project', 'tsconfig.json',
    '--tokens-manifest', 'dist/tokens-manifest.json',
    '--contract-version', '1',
  ], producerDir);
  if (manifestCmd.status !== 0) fail(`installed CLI --tokens-manifest failed\n${manifestCmd.output}`);
  const manifestPath = path.join(producerDir, 'dist/tokens-manifest.json');
  if (!existsSync(manifestPath)) fail('producer manifest was not written');
  const manifest = readJson(manifestPath);
  const userToken = manifest.tokens.find((token) => token.exportName === 'UserToken');
  const repoToken = manifest.tokens.find((token) => token.exportName === 'UserRepoToken');
  if (!userToken || !repoToken) fail(`producer manifest is missing tokens\n${JSON.stringify(manifest)}`);
  writeFileSync(path.join(producerDir, 'package.json'), `${JSON.stringify({
    name: '@acme/tokens',
    version: '1.0.0',
    type: 'module',
    files: ['dist'],
    types: './dist/tokens.d.ts',
    exports: {
      '.': {
        types: './dist/tokens.d.ts',
        import: './dist/tokens.d.ts',
        default: './dist/tokens.d.ts',
      },
      './types': {
        types: './dist/types.d.ts',
        import: './dist/types.d.ts',
        default: './dist/types.d.ts',
      },
    },
    peerDependencies: { '@djodjonx/neosyringe': '*' },
    neosyringe: { tokensManifest: './dist/tokens-manifest.json' },
  }, null, 2)}\n`);
  const producerPack = run('npm', ['pack', '--json', '--pack-destination', packDir], producerDir);
  if (producerPack.status !== 0) fail(`producer npm pack failed\n${producerPack.output}`);
  const producerTarball = parsePack(producerPack.stdout || producerPack.output);
  if (!existsSync(producerTarball)) fail(`missing producer tarball: ${producerTarball}`);
  const addProducer = npmInstall(consumerDir, ['--prefer-offline', producerTarball]);
  if (addProducer.status !== 0) fail(`consumer install of producer tarball failed\n${addProducer.output}`);
  assertInsideConsumer(path.join(installedPackageDir('@acme/tokens'), 'package.json'), '@acme/tokens');

  writeFileSync(path.join(consumerDir, 'resolve-token.mts'), [
    "import { UserToken, UserRepoToken } from '@acme/tokens';",
    "import type { User } from '@acme/tokens/types';",
    'export const userProbe: User = null!;',
    'export const constProbe = UserToken;',
    'export const repoProbe = UserRepoToken;',
    '',
  ].join('\n'));
  writeFileSync(path.join(consumerDir, 'tsconfig.tokens.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    files: ['resolve-token.mts'],
  }, null, 2)}\n`);
  writeFileSync(path.join(consumerDir, 'check-token.mjs'), `
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { TokenResolverService } from '@djodjonx/neosyringe-core/analyzer';

const repo = ${JSON.stringify(root)};
const expectedUser = process.argv[2];
const expectedRepo = process.argv[3];
const analyzer = realpathSync(fileURLToPath(import.meta.resolve('@djodjonx/neosyringe-core/analyzer')));
if (analyzer.startsWith(repo + path.sep)) throw new Error('analyzer resolved into the monorepo: ' + analyzer);
const tokenPkg = realpathSync(fileURLToPath(import.meta.resolve('@acme/tokens')));
if (tokenPkg.startsWith(repo + path.sep)) throw new Error('producer resolved into the monorepo: ' + tokenPkg);

const dir = process.cwd();
const configPath = path.join(dir, 'tsconfig.tokens.json');
const read = ts.readConfigFile(configPath, ts.sys.readFile);
if (read.error) {
  console.error('tsconfig');
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const service = new TokenResolverService(checker);
const file = parsed.fileNames.find((name) => name.endsWith('resolve-token.mts'));
if (!file) {
  console.error('missing resolve-token.mts');
  process.exit(1);
}
const source = program.getSourceFile(file);

function varType(name) {
  let found;
  const visit = (node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.type) {
      found = checker.getTypeFromTypeNode(node.type);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error('missing type ' + name);
  return found;
}

function ident(name) {
  let found;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isIdentifier(node)
      && node.text === name
      && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error('missing ident ' + name);
  return found;
}

const userKey = service.getTypeId(varType('userProbe'));
const constKey = service.resolveTokenId(ident('UserToken'));
const repoKey = service.resolveTokenId(ident('UserRepoToken'));
if (userKey !== expectedUser || constKey !== expectedUser) {
  console.error('user key mismatch', userKey, constKey, expectedUser);
  process.exit(1);
}
if (repoKey !== expectedRepo) {
  console.error('repo key mismatch', repoKey, expectedRepo);
  process.exit(1);
}
if (userKey.includes('node_modules') || userKey.includes(dir)) {
  console.error('key contains a path', userKey);
  process.exit(1);
}
console.log(userKey);
`);
  function checkTokens(cwd) {
    return run(process.execPath, [
      path.join(cwd, 'check-token.mjs'),
      userToken.runtimeKey,
      repoToken.runtimeKey,
    ], cwd);
  }
  const first = checkTokens(consumerDir);
  if (first.status !== 0) fail(`producer round trip failed\n${first.output}`);
  const moved = path.join(tmp, 'consumer-moved');
  renameSync(consumerDir, moved);
  const second = checkTokens(moved);
  if (second.status !== 0) fail(`producer round trip after move failed\n${second.output}`);
  const firstKey = first.stdout.trim();
  const secondKey = second.stdout.trim();
  if (firstKey !== userToken.runtimeKey || secondKey !== userToken.runtimeKey) {
    fail(`producer key changed: manifest ${userToken.runtimeKey}, first ${firstKey}, moved ${secondKey}`);
  }
  step(`producer key ${firstKey} stable after move`);
} catch (error) {
  if (!failed) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    failed = true;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  step(`cleaned ${tmp}`);
  step(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (failed) process.exit(1);
