#!/usr/bin/env node
// Opt-in. Needs the npm registry. Does not build this repo and does not publish.
// Installs the historical pins in a temp directory, then the candidate tarballs
// from `pnpm pack`, runs the migration consumers, and removes the temp directory.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertDistNewerThanSrc, assertTarballFromBuild, declaredEntries, extractTarball } from './lib/tarball-proof.mjs';
import {
  assertBuildOutsideRepo,
  assertDiagnostic,
  assertExactPins,
  assertInstalledVersion,
  assertNoNestedDjodjonx,
  compareBehaviour,
} from './lib/historical-compare.mjs';

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));

const HISTORICAL_PINS = [
  ['@djodjonx/neosyringe', '0.3.0'],
  ['@djodjonx/neosyringe-plugin', '0.6.1'],
  ['@djodjonx/neosyringe-core', '3.2.0'],
  ['@djodjonx/neosyringe-ui', '0.2.1'],
];

// The message the historical async container throws. It has no Neo error code.
const LEGACY_ASYNC = '[LegacyAsync] This container has async services — call `await container.initialize()` before the first resolve().';

// Pinned from the historical archive versus the candidate run of migration-after.ts.
const DECLARED_DIFFERENCES = {
  mocked: { before: 'report from real', after: 'report from fake' },
  disposed: { before: 1, after: 2 },
  afterDestroy: { before: 'no error', after: 'NEO_CONTAINER_DESTROYED' },
  asyncBeforeInit: { before: LEGACY_ASYNC, after: 'NEO_NOT_INITIALIZED' },
  asyncEndpoint: { before: LEGACY_ASYNC, after: '/api' },
  asyncClosed: { before: 0, after: 1 },
  asyncAfterDestroy: { before: LEGACY_ASYNC, after: 'NEO_CONTAINER_DESTROYED' },
  syncInitialize: { before: 'undefined', after: 'function' },
};

const PROBE = `
export async function probe() {
  const out = { syncInitialize: typeof container.initialize };
  try { out.real = container.resolve(Report).summary(); } catch (error) { out.real = codeOf(error); }
  try {
    container.override(Database, () => new FakeDatabase());
    out.mocked = container.resolve(Report).summary();
  } catch (error) { out.mocked = codeOf(error); }
  try {
    container.clearOverrides();
    out.restored = container.resolve(Report).summary();
  } catch (error) { out.restored = codeOf(error); }
  try { await container.destroy(); out.disposed = Database.closed; } catch (error) { out.disposed = codeOf(error); }
  out.afterDestroy = 'no error';
  try { container.resolve(Report); } catch (error) { out.afterDestroy = codeOf(error); }
  out.asyncBeforeInit = 'no error';
  try { asyncApp.resolve(Client); } catch (error) { out.asyncBeforeInit = codeOf(error); }
  out.initializeError = 'no error';
  try { await asyncApp.initialize(); } catch (error) { out.initializeError = codeOf(error); }
  try {
    out.asyncEndpoint = asyncApp.resolve(Client).endpoint;
  } catch (error) { out.asyncEndpoint = codeOf(error); }
  try { await asyncApp.destroy(); out.asyncClosed = clientsClosed; } catch (error) { out.asyncClosed = codeOf(error); }
  out.asyncAfterDestroy = 'no error';
  try { asyncApp.resolve(Client); } catch (error) { out.asyncAfterDestroy = codeOf(error); }
  try {
    out.sharedLogger = child.resolve(Handler).logger === parent.resolve(Logger);
    out.childLine = child.resolve(Handler).line();
  } catch (error) { out.childLine = codeOf(error); }
  try { await child.destroy(); out.parentClosedAfterChild = Logger.closed; } catch (error) { out.parentClosedAfterChild = codeOf(error); }
  try { await parent.destroy(); out.parentClosedAfterParent = Logger.closed; } catch (error) { out.parentClosedAfterParent = codeOf(error); }
  return out;
}
`;

// Temp-only, appended to both recorded consumers. The example files stay unchanged.
// Reads the overridden token itself, immediately after override returns.
const DIRECT_READ = `
const overriddenDirectRead = { value: 'missing' };
const readOverriddenDirect = () => {
  try {
    overriddenDirectRead.value = container.resolve(Database).label();
  } catch (error) {
    overriddenDirectRead.value = codeOf(error);
  }
};
const overrideBeforeDirectRead = container.override.bind(container);
container.override = (...args) => {
  const result = overrideBeforeDirectRead(...args);
  if (result && typeof result.then === 'function') {
    return result.then((value) => {
      readOverriddenDirect();
      return value;
    });
  }
  readOverriddenDirect();
  return result;
};
export { overriddenDirectRead };
`;

const CAPTURE = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
class Leak { dispose() {} }
class Hold { constructor(readonly leak: Leak) {} }
export const container = defineBuilderConfig({
  name: 'Cap',
  injections: [
    { token: Leak, lifecycle: 'transient' },
    { token: Hold },
  ],
});
`;

const BUSY = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
class Db {
  static closed = 0;
  label(): string { return 'real'; }
  async dispose(): Promise<void> { await Promise.resolve(); Db.closed += 1; }
}
class Fake extends Db { label(): string { return 'fake'; } }
export const container = defineBuilderConfig({ name: 'Busy', injections: [{ token: Db }] });
export async function run() {
  container.resolve(Db);
  const pending = container.override(Db, () => new Fake());
  let during = 'no error';
  try { container.resolve(Db); } catch (error) { during = error && error.code ? error.code : String(error); }
  await pending;
  return { during, after: container.resolve(Db).label(), closed: Db.closed };
}
`;

const TOKEN_SOURCE = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
export interface User { id: string }
export const UserToken = useInterface<User>();
class Box { constructor(readonly user: User) {} }
export const container = defineBuilderConfig({
  name: 'Box',
  injections: [{ token: UserToken, useValue: { id: 'p' } }, { token: Box }],
});
`;

const TOKEN_CONSUMER = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import type { User } from '@acme/tokens';
export const container = defineBuilderConfig({
  name: 'Tok',
  injections: [{ token: useInterface<User>(), useValue: { id: 'a' } }],
});
`;

const REBUILT_CONSUMER = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import type { User } from '@acme/tokens';
class Greeter { constructor(readonly user: User) {} id() { return this.user.id; } }
export const container = defineBuilderConfig({
  name: 'Rebuilt',
  injections: [
    { token: useInterface<User>(), useValue: { id: 'same' } },
    { token: Greeter },
  ],
});
export function run() { return container.resolve(Greeter).id(); }
`;

function block(label, text) {
  console.log(`\n${label}`);
  console.log(text);
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd, env) {
  if (command === 'npm' && args.includes('publish')) fail('refusing to publish');
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false', ...env },
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

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function tail(text) {
  return text.trim().split('\n').slice(-30).join('\n');
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function freeze(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (item === undefined ? null : item)));
}

function specOf(name, version) {
  return `${name}@${version}`;
}

function packageDirs() {
  return readdirSync(path.join(root, 'packages'))
    .map((name) => path.join(root, 'packages', name))
    .filter((dir) => existsSync(path.join(dir, 'package.json')));
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

function parsePack(output, packDir) {
  const arrayAt = output.indexOf('[');
  const objectAt = output.indexOf('{');
  const useArray = arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt);
  const start = useArray ? arrayAt : objectAt;
  const end = useArray ? output.lastIndexOf(']') : output.lastIndexOf('}');
  if (start < 0 || end < start) fail(`pack did not return json:\n${tail(output)}`);
  const parsed = JSON.parse(output.slice(start, end + 1));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const filename = typeof first === 'string' ? first : (first?.filename ?? first?.name);
  if (typeof filename !== 'string' || !filename.endsWith('.tgz')) fail(`pack json has no tarball:\n${tail(output)}`);
  return path.isAbsolute(filename) ? filename : path.join(packDir, path.basename(filename));
}

function npmInstall(cwd, extraArgs) {
  return run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...extraArgs], cwd);
}

function assertOutsideRepo(file, label) {
  const real = realpathSync(file);
  if (real === root || real.startsWith(`${root}${path.sep}`)) fail(`${label} resolved into the monorepo: ${real}`);
  return real;
}

function installedVersion(dir, name) {
  const file = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(file)) fail(`package was not installed: ${name}`);
  assertOutsideRepo(file, name);
  return readJson(file).version;
}

function writeProject(dir, include) {
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeJson(path.join(dir, 'package.json'), { private: true, type: 'module' });
  writeJson(path.join(dir, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      types: [],
    },
    include,
  });
}

function linkModules(dir, fromDir) {
  const target = path.join(fromDir, 'node_modules');
  const link = path.join(dir, 'node_modules');
  if (!existsSync(link)) symlinkSync(target, link);
}

const buildWorker = path.join(root, 'scripts/ci/lib/historical-build-worker.mjs');

// The plugin reads process.cwd() for its tsconfig. Each build is a child whose cwd is the project.
function bundleChild(installDir, cwd, entry, outfile, options, bundleModules, nodeEnv) {
  const proofFile = path.join(cwd, 'build-proof.json');
  const result = run(process.execPath, [buildWorker], cwd, {
    NODE_ENV: nodeEnv,
    NEO_INSTALL: installDir,
    NEO_ENTRY: entry,
    NEO_OUTFILE: outfile,
    NEO_OPTIONS: JSON.stringify(options ?? {}),
    NEO_BUNDLE: bundleModules ? 'true' : 'false',
    NEO_PROOF: proofFile,
  });
  if (!existsSync(proofFile)) return { ok: false, error: result.output, proof: null };
  const proof = readJson(proofFile);
  if (!proof.ok || result.status !== 0) return { ok: false, error: proof.error || result.output, proof };
  return { ok: true, error: '', proof };
}

function proofPaths(proof) {
  return [
    ...(Array.isArray(proof.projectRoots) ? proof.projectRoots : []),
    ...(Array.isArray(proof.inputs) ? proof.inputs : []),
    ...(Array.isArray(proof.reads) ? proof.reads : []),
  ];
}

function assertBuildProof(proof, label, errorText = '') {
  if (!proof) fail(`${label} wrote no build proof\n${errorText}`);
  assertBuildOutsideRepo({
    projectRoot: proof.projectRoot,
    paths: proofPaths(proof),
    reads: proof.reads,
    ok: proof.ok,
  }, root);
  return [
    label,
    `projectRoot: ${proof.projectRoot}`,
    `typescript reads: ${Array.isArray(proof.reads) ? proof.reads.length : 0}`,
    `metafile inputs: ${Array.isArray(proof.inputs) ? proof.inputs.length : 0}`,
    'under the repo: 0',
  ].join('\n');
}

function djodjonxPackageRels(installDir) {
  const scope = path.join(installDir, 'node_modules', '@djodjonx');
  if (!existsSync(scope)) return [];
  const found = [];
  for (const name of readdirSync(scope)) {
    const own = path.join('node_modules', '@djodjonx', name, 'package.json');
    if (existsSync(path.join(installDir, own))) found.push(own);
    const nested = path.join(scope, name, 'node_modules', '@djodjonx');
    if (!existsSync(nested)) continue;
    for (const inner of readdirSync(nested)) {
      found.push(path.join('node_modules', '@djodjonx', name, 'node_modules', '@djodjonx', inner, 'package.json'));
    }
  }
  return found;
}

function runExport(file, exportName, cwd) {
  const script = `
    import { pathToFileURL } from 'node:url';
    const mod = await import(pathToFileURL(process.env.NEO_ENTRY).href);
    try {
      const value = await mod[process.env.NEO_EXPORT]();
      const recorded = value && typeof value === 'object' ? { ...value } : { value };
      if (mod.container) recorded.syncInitialize = typeof mod.container.initialize;
      if (mod.overriddenDirectRead) recorded.overriddenDirect = mod.overriddenDirectRead.value;
      process.stdout.write(JSON.stringify(recorded));
    } catch (error) {
      process.stderr.write(error && error.stack ? error.stack : String(error));
      process.exit(1);
    }
  `;
  return run(process.execPath, ['--input-type=module', '-e', script], cwd, {
    NODE_ENV: 'test',
    NEO_ENTRY: file,
    NEO_EXPORT: exportName,
  });
}

function tokenKeys(text) {
  return [...new Set([...text.matchAll(/User_[0-9a-f]{8}/g)].map((match) => match[0]))];
}

function codeLine(text, code) {
  const line = text.split('\n').map((item) => item.trim()).find((item) => item.includes(code));
  return line ?? text.split('\n')[0] ?? text;
}

function printSummary(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(DECLARED_DIFFERENCES)])];
  const lines = ['key | before | after | result'];
  for (const key of keys) {
    const same = isDeepStrictEqual(before[key], after[key]);
    const result = same ? 'equal' : (DECLARED_DIFFERENCES[key] ? 'declared' : 'UNDECLARED');
    lines.push(`${key} | ${JSON.stringify(before[key])} | ${JSON.stringify(after[key])} | ${result}`);
  }
  block('BEFORE (historical npm) vs AFTER (candidate tarballs)', lines.join('\n'));
}

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'neosyringe-historical-migration-')));
let exitCode = 0;

try {
  const buildProofs = [];
  if (tmp === root || tmp.startsWith(`${root}${path.sep}`)) fail(`temp dir is inside the repo: ${tmp}`);
  const packDir = path.join(tmp, 'packs');
  const histDir = path.join(tmp, 'historical');
  const candDir = path.join(tmp, 'candidate');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(histDir, { recursive: true });
  mkdirSync(candDir, { recursive: true });

  const toolPins = [
    ['typescript', lockfileVersion('packages/core', 'typescript')],
    ['esbuild', lockfileVersion('packages/unplugin', 'esbuild')],
  ];
  const histSpecs = [...HISTORICAL_PINS, ...toolPins].map(([name, version]) => specOf(name, version));
  assertExactPins(histSpecs);
  const histDependencies = Object.fromEntries([...HISTORICAL_PINS, ...toolPins]);
  writeJson(path.join(histDir, 'package.json'), { private: true, dependencies: histDependencies });
  const histInstall = npmInstall(histDir, []);
  if (histInstall.status !== 0) fail(`BEFORE (historical npm) npm install failed\n${tail(histInstall.output)}`);
  const saved = readJson(path.join(histDir, 'package.json')).dependencies ?? {};
  assertExactPins(Object.entries(saved).map(([name, version]) => specOf(name, version)));
  for (const [name, pin] of HISTORICAL_PINS) {
    assertInstalledVersion(installedVersion(histDir, name), pin);
  }
  const histNested = djodjonxPackageRels(histDir);
  assertNoNestedDjodjonx(histNested);
  if (existsSync(path.join(histDir, 'node_modules/@djodjonx/neosyringe-cli/package.json'))) {
    fail('BEFORE (historical npm) installed @djodjonx/neosyringe-cli');
  }
  if (existsSync(path.join(histDir, 'node_modules/@djodjonx/neosyringe-lsp/package.json'))) {
    fail('BEFORE (historical npm) installed @djodjonx/neosyringe-lsp');
  }
  block(
    'BEFORE (historical npm) installed pins',
    HISTORICAL_PINS.map(([name, pin]) => `${name} ${installedVersion(histDir, name)} (pin ${pin})`).join('\n')
      + '\npublish: no\ncli installed: no\nlsp installed: no\nnested @djodjonx packages: 0',
  );

  const historicalGenerator = readFileSync(
    path.join(histDir, 'node_modules/@djodjonx/neosyringe-core/dist/generator/index.cjs'),
    'utf8',
  );
  const processGate = historicalGenerator.includes("process.env?.NODE_ENV === 'production'");
  block(
    'BEFORE (historical npm) override process check',
    `override checks process.env.NODE_ENV: ${processGate ? 'yes' : 'no'}`,
  );

  const pluginDts = readFileSync(path.join(histDir, 'node_modules/@djodjonx/neosyringe-plugin/dist/index.d.mts'), 'utf8');
  block(
    'BEFORE (historical npm) plugin options',
    `testOverrides mentioned: ${pluginDts.includes('testOverrides') ? 'yes' : 'no'}\nvalidation mentioned: ${pluginDts.includes('validation') ? 'yes' : 'no'}`,
  );

  const cliSpec = '@djodjonx/neosyringe-cli@0.4.1';
  assertExactPins(cliSpec);
  const cliPack = run('npm', ['pack', cliSpec, '--json', '--pack-destination', packDir], tmp);
  if (cliPack.status !== 0) fail(`BEFORE (historical npm) npm pack of the cli failed\n${tail(cliPack.output)}`);
  const cliTarball = parsePack(cliPack.stdout || cliPack.output, packDir);
  const cliUnpacked = extractTarball(cliTarball, path.join(tmp, 'cli-inspect'));
  const cliDist = readFileSync(path.join(cliUnpacked, 'dist/index.mjs'), 'utf8');
  const cliHasFlag = cliDist.includes('--tokens-manifest');
  block(
    'BEFORE (historical npm) CLI 0.4.1',
    `installed: no\nnpm pack only, not npm install\n--tokens-manifest in dist/index.mjs: ${cliHasFlag ? 'yes' : 'no'}`,
  );
  if (cliHasFlag) fail('BEFORE (historical npm) CLI 0.4.1 contains --tokens-manifest');

  const beforeDir = path.join(tmp, 'before');
  writeProject(beforeDir, ['src']);
  linkModules(beforeDir, histDir);
  const beforeSource = readFileSync(path.join(root, 'examples/new-api/migration-before.ts'), 'utf8');
  writeFileSync(path.join(beforeDir, 'src/app.ts'), `${beforeSource}\n${PROBE}\n${DIRECT_READ}`);
  const beforeOut = path.join(beforeDir, 'dist/app.mjs');
  const beforeBuild = bundleChild(histDir, beforeDir, 'src/app.ts', beforeOut, {}, true, 'test');
  if (!beforeBuild.ok) fail(`BEFORE (historical npm) build failed\n${beforeBuild.error}`);
  buildProofs.push(assertBuildProof(beforeBuild.proof, 'BEFORE (historical npm) behaviour build', beforeBuild.error));

  const plainDir = path.join(tmp, 'before-plain');
  writeProject(plainDir, ['src']);
  linkModules(plainDir, histDir);
  writeFileSync(path.join(plainDir, 'src/app.ts'), `${beforeSource}\n${PROBE}`);
  const plainOut = path.join(plainDir, 'dist/app.mjs');
  const plainBuild = bundleChild(histDir, plainDir, 'src/app.ts', plainOut, {}, true, 'test');
  if (!plainBuild.ok) fail(`BEFORE (historical npm) plain build failed\n${plainBuild.error}`);
  buildProofs.push(assertBuildProof(plainBuild.proof, 'BEFORE (historical npm) plain build', plainBuild.error));
  const beforeRun = runExport(beforeOut, 'run', beforeDir);
  block(
    'BEFORE (historical npm) run()',
    beforeRun.status === 0 ? beforeRun.stdout : `rejected\n${tail(beforeRun.stderr || beforeRun.output)}`,
  );
  const beforeProbe = runExport(beforeOut, 'probe', beforeDir);
  if (beforeProbe.status !== 0) fail(`BEFORE (historical npm) probe failed\n${tail(beforeProbe.stderr || beforeProbe.output)}`);
  const beforeRaw = JSON.parse(beforeProbe.stdout);
  const initializeError = beforeRaw.initializeError;
  // migration-after.ts run() awaits initialize() and does not return this key (examples/new-api/migration-after.ts:144).
  const EXCLUDED_FROM_COMPARISON = ['initializeError'];
  for (const key of EXCLUDED_FROM_COMPARISON) delete beforeRaw[key];
  const beforeRecord = freeze(beforeRaw);
  block('BEFORE (historical npm) initialize()', String(initializeError));
  block(
    'BEFORE (historical npm) comparison exclusions',
    EXCLUDED_FROM_COMPARISON.map((key) => `${key}: printed above, not compared`).join('\n'),
  );
  const plainProbe = runExport(plainOut, 'probe', plainDir);
  if (plainProbe.status !== 0) fail(`BEFORE (historical npm) plain probe failed\n${tail(plainProbe.stderr || plainProbe.output)}`);
  const plainRecord = freeze(JSON.parse(plainProbe.stdout));
  block('BEFORE (historical npm) plain consumer, no direct read', `disposed ${plainRecord.disposed}`);
  block('BEFORE (historical npm) behaviour', JSON.stringify(beforeRecord, null, 2));

  const packed = [];
  for (const dir of packageDirs()) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg.private === true) continue;
    for (const rel of declaredEntries(pkg)) {
      if (!existsSync(path.join(dir, rel))) fail(`prebuilt dist is missing: ${path.join(dir, rel)}. This script does not build.`);
    }
    const packedRun = run('pnpm', ['pack', '--json', '--pack-destination', packDir], dir);
    if (packedRun.status !== 0) fail(`pnpm pack failed for ${pkg.name}\n${tail(packedRun.output)}`);
    const tarball = parsePack(packedRun.stdout || packedRun.output, packDir);
    if (!existsSync(tarball)) fail(`missing tarball for ${pkg.name}: ${tarball}`);
    for (const rel of declaredEntries(pkg)) assertDistNewerThanSrc(path.join(dir, rel), path.join(dir, 'src'));
    const proof = assertTarballFromBuild(tarball, dir);
    block(
      'AFTER (candidate tarballs) pack',
      `${path.basename(tarball)} carries the disk build (${proof.distFiles} dist files, version ${proof.version})`,
    );
    packed.push({ name: pkg.name, tarball, version: proof.version });
  }
  const candDependencies = {};
  for (const item of packed) candDependencies[item.name] = `file:${item.tarball}`;
  for (const [name, version] of toolPins) candDependencies[name] = version;
  assertExactPins(toolPins.map(([name, version]) => specOf(name, version)));
  writeJson(path.join(candDir, 'package.json'), { private: true, dependencies: candDependencies });
  const candInstall = npmInstall(candDir, []);
  if (candInstall.status !== 0) fail(`AFTER (candidate tarballs) npm install failed\n${tail(candInstall.output)}`);
  // Version strings match the historical pins (scripts/ci/historical-migration.mjs:35).
  // assertInstalledVersion does not prove the candidate. The sha256 block and assertNoNestedDjodjonx do.
  for (const item of packed) {
    assertInstalledVersion(installedVersion(candDir, item.name), item.version);
    assertOutsideRepo(path.join(candDir, 'node_modules', ...item.name.split('/'), 'package.json'), item.name);
  }
  const candNested = djodjonxPackageRels(candDir);
  assertNoNestedDjodjonx(candNested);
  block(
    'AFTER (candidate tarballs) installed',
    packed.map((item) => `${item.name} ${installedVersion(candDir, item.name)} from file tarball`).join('\n')
      + '\npublish: no\nnested @djodjonx packages: 0\nversion check proves the candidate: no',
  );

  const diskDir = {
    '@djodjonx/neosyringe': 'packages/neosyringe',
    '@djodjonx/neosyringe-plugin': 'packages/unplugin',
    '@djodjonx/neosyringe-core': 'packages/core',
    '@djodjonx/neosyringe-ui': 'packages/ui',
  };
  const hashed = [
    ['@djodjonx/neosyringe', 'dist/index.d.mts', true],
    ['@djodjonx/neosyringe-plugin', 'dist/index.mjs', true],
    ['@djodjonx/neosyringe-core', 'dist/generator/index.mjs', true],
    ['@djodjonx/neosyringe-ui', 'dist/index.mjs', false],
    ['@djodjonx/neosyringe', 'dist/index.mjs', false],
  ];
  const hashLines = [];
  for (const [name, rel, mustDiffer] of hashed) {
    const historicalFile = path.join(histDir, 'node_modules', ...name.split('/'), rel);
    const candidateFile = path.join(candDir, 'node_modules', ...name.split('/'), rel);
    const diskFile = path.join(root, diskDir[name], rel);
    const historicalHash = sha256(historicalFile);
    const candidateHash = sha256(candidateFile);
    const diskHash = sha256(diskFile);
    if (candidateHash !== diskHash) fail(`AFTER (candidate tarballs) ${name} ${rel} is not the disk build`);
    hashLines.push(`${name} ${rel} | historical ${historicalHash} | candidate ${candidateHash} | ${historicalHash === candidateHash ? 'same' : 'differs'}`);
    if (mustDiffer && historicalHash === candidateHash) fail(`historical and candidate are the same file: ${name} ${rel}`);
  }
  block('BEFORE (historical npm) vs AFTER (candidate tarballs) sha256', hashLines.join('\n'));

  const afterSource = readFileSync(path.join(root, 'examples/new-api/migration-after.ts'), 'utf8');

  function candidateProject(name, source, options, nodeEnv) {
    const dir = path.join(tmp, name);
    writeProject(dir, ['src']);
    linkModules(dir, candDir);
    writeFileSync(path.join(dir, 'src/app.ts'), source);
    const outfile = path.join(dir, 'dist/app.mjs');
    const built = bundleChild(
      candDir,
      dir,
      'src/app.ts',
      outfile,
      { project: path.join(dir, 'tsconfig.json'), ...options },
      true,
      nodeEnv,
    );
    if (!built.proof) fail(`AFTER (candidate tarballs) ${name} wrote no build proof\n${built.error}`);
    buildProofs.push(assertBuildProof(built.proof, `AFTER (candidate tarballs) ${name}`, built.error));
    return { dir, outfile, built };
  }

  const strictLegacy = await candidateProject('legacy-strict', beforeSource, { validation: 'strict', testOverrides: true }, 'test');
  if (strictLegacy.built.ok) fail('AFTER (candidate tarballs) strict build of the legacy factory succeeded');
  assertDiagnostic(strictLegacy.built.error, 'NEO_FACTORY_DEPENDENCIES_REQUIRED');
  block('AFTER (candidate tarballs) strict legacy factory', codeLine(strictLegacy.built.error, 'NEO_FACTORY_DEPENDENCIES_REQUIRED'));

  const compatibleLegacy = await candidateProject('legacy-compatible', beforeSource, { validation: 'compatible', testOverrides: true }, 'test');
  if (compatibleLegacy.built.ok) fail('AFTER (candidate tarballs) validation compatible build of the legacy factory succeeded');
  assertDiagnostic(compatibleLegacy.built.error, 'NEO_FACTORY_DEPENDENCIES_REQUIRED');
  block('AFTER (candidate tarballs) validation compatible legacy factory', codeLine(compatibleLegacy.built.error, 'NEO_FACTORY_DEPENDENCIES_REQUIRED'));

  const capture = await candidateProject('capture', CAPTURE, { validation: 'strict' }, 'test');
  if (capture.built.ok) fail('AFTER (candidate tarballs) disposable transient capture build succeeded');
  assertDiagnostic(capture.built.error, 'NEO_DISPOSABLE_TRANSIENT_CAPTURED');
  block('AFTER (candidate tarballs) disposable transient', codeLine(capture.built.error, 'NEO_DISPOSABLE_TRANSIENT_CAPTURED'));

  const after = await candidateProject('after', `${afterSource}\n${DIRECT_READ}`, { validation: 'strict', testOverrides: true }, 'test');
  if (!after.built.ok) fail(`AFTER (candidate tarballs) build failed\n${after.built.error}`);
  assertOutsideRepo(path.join(candDir, 'node_modules/@djodjonx/neosyringe/package.json'), '@djodjonx/neosyringe');
  const afterRun = runExport(after.outfile, 'run', after.dir);
  if (afterRun.status !== 0) fail(`AFTER (candidate tarballs) run() failed\n${tail(afterRun.stderr || afterRun.output)}`);
  const afterRecord = freeze(JSON.parse(afterRun.stdout));
  block('AFTER (candidate tarballs) behaviour', JSON.stringify(afterRecord, null, 2));
  printSummary(beforeRecord, afterRecord);
  const differences = compareBehaviour(beforeRecord, afterRecord, DECLARED_DIFFERENCES);
  if (!Array.isArray(differences) || differences.length !== 0) fail('compareBehaviour did not return []');

  assertDiagnostic(afterRecord.afterDestroy, 'NEO_CONTAINER_DESTROYED');
  assertDiagnostic(afterRecord.asyncAfterDestroy, 'NEO_CONTAINER_DESTROYED');
  assertDiagnostic(afterRecord.asyncBeforeInit, 'NEO_NOT_INITIALIZED');

  const busy = await candidateProject('busy', BUSY, { validation: 'strict', testOverrides: true }, 'test');
  if (!busy.built.ok) fail(`AFTER (candidate tarballs) busy build failed\n${busy.built.error}`);
  const busyRun = runExport(busy.outfile, 'run', busy.dir);
  if (busyRun.status !== 0) fail(`AFTER (candidate tarballs) busy run failed\n${tail(busyRun.stderr || busyRun.output)}`);
  assertDiagnostic(busyRun.stdout, 'NEO_CONTAINER_BUSY');
  block('AFTER (candidate tarballs) override not awaited', busyRun.stdout);

  const production = await candidateProject('production', afterSource, { validation: 'strict', testOverrides: true }, 'production');
  if (production.built.ok) fail('AFTER (candidate tarballs) testOverrides in production succeeded');
  assertDiagnostic(production.built.error, 'NEO_TEST_API_DISABLED');
  block('AFTER (candidate tarballs) testOverrides in production', codeLine(production.built.error, 'NEO_TEST_API_DISABLED'));
  block(
    'AFTER (candidate tarballs) FactoryContext restriction',
    'no code asserted: the guide row does not name one, and this script does not invent one',
  );
  block(
    'AFTER (candidate tarballs) NEO_ROOT_NOT_EXPORTED',
    'not run here. Closed mode stays on tests/e2e/t20-migration.test.ts',
  );

  const producerSourceDir = path.join(tmp, 'hist-producer');
  writeProject(producerSourceDir, ['src']);
  linkModules(producerSourceDir, histDir);
  writeJson(path.join(producerSourceDir, 'package.json'), {
    name: '@acme/tokens',
    version: '1.0.0',
    type: 'module',
    dependencies: { '@djodjonx/neosyringe': '0.3.0' },
    exports: { '.': { types: './dist/tokens.d.ts', import: './dist/tokens.mjs' } },
  });
  writeJson(path.join(producerSourceDir, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: 'src',
      outDir: 'dist',
      types: [],
    },
    include: ['src'],
  });
  writeFileSync(path.join(producerSourceDir, 'src/tokens.ts'), TOKEN_SOURCE);
  const histTokenOut = path.join(producerSourceDir, 'dist/tokens.mjs');
  const histTokenBuild = bundleChild(histDir, producerSourceDir, 'src/tokens.ts', histTokenOut, {}, false, 'test');
  if (!histTokenBuild.ok) fail(`BEFORE (historical npm) token producer build failed\n${histTokenBuild.error}`);
  buildProofs.push(assertBuildProof(histTokenBuild.proof, 'BEFORE (historical npm) token producer', histTokenBuild.error));
  const histKeys = tokenKeys(readFileSync(histTokenOut, 'utf8'));
  if (histKeys.length === 0) fail('BEFORE (historical npm) token producer emitted no User_ key');
  block('BEFORE (historical npm) producer key', histKeys.join(','));
  const tsc = path.join(histDir, 'node_modules/typescript/bin/tsc');
  const declarations = run(process.execPath, [tsc, '-p', 'tsconfig.json'], producerSourceDir);
  if (declarations.status !== 0) fail(`BEFORE (historical npm) token declarations failed\n${tail(declarations.output)}`);

  const shippedTokens = path.join(tmp, 'shipped-tokens');
  mkdirSync(shippedTokens, { recursive: true });
  cpSync(producerSourceDir, shippedTokens, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules`),
  });
  const boundaryDir = path.join(tmp, 'boundary');
  writeProject(boundaryDir, ['src']);
  mkdirSync(path.join(boundaryDir, 'node_modules/@acme'), { recursive: true });
  symlinkSync(path.join(candDir, 'node_modules/@djodjonx'), path.join(boundaryDir, 'node_modules/@djodjonx'));
  symlinkSync(path.join(candDir, 'node_modules/typescript'), path.join(boundaryDir, 'node_modules/typescript'));
  symlinkSync(shippedTokens, path.join(boundaryDir, 'node_modules/@acme/tokens'));
  writeFileSync(path.join(boundaryDir, 'src/app.ts'), TOKEN_CONSUMER);
  const boundaryOut = path.join(boundaryDir, 'dist/app.mjs');
  const boundaryBuild = bundleChild(
    candDir,
    boundaryDir,
    'src/app.ts',
    boundaryOut,
    { project: path.join(boundaryDir, 'tsconfig.json'), validation: 'strict' },
    true,
    'test',
  );
  if (!boundaryBuild.proof) fail(`AFTER (candidate tarballs) boundary wrote no build proof\n${boundaryBuild.error}`);
  buildProofs.push(assertBuildProof(boundaryBuild.proof, 'AFTER (candidate tarballs) boundary', boundaryBuild.error));
  if (boundaryBuild.ok) fail('AFTER (candidate tarballs) consumed a historical producer with no manifest');
  assertDiagnostic(boundaryBuild.error, 'NEO_TOKEN_BOUNDARY_UNSUPPORTED');
  assertDiagnostic(boundaryBuild.error, 'manifest-absent');
  block('AFTER (candidate tarballs) historical producer, no manifest', codeLine(boundaryBuild.error, 'NEO_TOKEN_BOUNDARY_UNSUPPORTED'));

  const rebuiltDir = path.join(tmp, 'rebuilt-producer');
  writeProject(rebuiltDir, ['src']);
  rmSync(path.join(rebuiltDir, 'node_modules'), { recursive: true, force: true });
  mkdirSync(path.join(rebuiltDir, 'node_modules'), { recursive: true });
  symlinkSync(path.join(candDir, 'node_modules/@djodjonx'), path.join(rebuiltDir, 'node_modules/@djodjonx'));
  symlinkSync(path.join(candDir, 'node_modules/typescript'), path.join(rebuiltDir, 'node_modules/typescript'));
  writeJson(path.join(rebuiltDir, 'package.json'), {
    name: '@acme/tokens',
    version: '1.0.0',
    type: 'module',
    dependencies: { '@djodjonx/neosyringe': '0.3.0' },
    exports: { '.': { types: './dist/tokens.d.ts', import: './dist/tokens.mjs' } },
  });
  writeJson(path.join(rebuiltDir, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      skipLibCheck: true,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: 'src',
      outDir: 'dist',
      types: [],
    },
    include: ['src'],
  });
  writeFileSync(path.join(rebuiltDir, 'src/tokens.ts'), TOKEN_SOURCE);
  const candTsc = path.join(candDir, 'node_modules/typescript/bin/tsc');
  const rebuiltDecl = run(process.execPath, [candTsc, '-p', 'tsconfig.json'], rebuiltDir);
  if (rebuiltDecl.status !== 0) fail(`AFTER (candidate tarballs) rebuilt declarations failed\n${tail(rebuiltDecl.output)}`);
  const cliBin = path.join(candDir, 'node_modules/@djodjonx/neosyringe-cli/dist/index.mjs');
  const manifestCmd = run(process.execPath, [
    cliBin,
    '--project', 'tsconfig.json',
    '--tokens-manifest', 'dist/tokens-manifest.json',
    '--contract-version', '1',
  ], rebuiltDir);
  if (manifestCmd.status !== 0) fail(`AFTER (candidate tarballs) --tokens-manifest failed\n${tail(manifestCmd.output)}`);
  const rebuiltPkg = readJson(path.join(rebuiltDir, 'package.json'));
  rebuiltPkg.neosyringe = { tokensManifest: './dist/tokens-manifest.json' };
  writeJson(path.join(rebuiltDir, 'package.json'), rebuiltPkg);
  const rebuiltOut = path.join(rebuiltDir, 'dist/tokens.mjs');
  const rebuiltBuild = bundleChild(
    candDir,
    rebuiltDir,
    'src/tokens.ts',
    rebuiltOut,
    { project: path.join(rebuiltDir, 'tsconfig.json'), validation: 'strict' },
    false,
    'test',
  );
  if (!rebuiltBuild.ok) fail(`AFTER (candidate tarballs) rebuilt producer build failed\n${rebuiltBuild.error}`);
  buildProofs.push(assertBuildProof(rebuiltBuild.proof, 'AFTER (candidate tarballs) rebuilt producer', rebuiltBuild.error));
  const rebuiltKeys = tokenKeys(readFileSync(rebuiltOut, 'utf8'));
  if (rebuiltKeys.length === 0) fail('AFTER (candidate tarballs) rebuilt producer emitted no User_ key');

  const rebuiltConsumerDir = path.join(tmp, 'rebuilt-consumer');
  writeProject(rebuiltConsumerDir, ['src']);
  rmSync(path.join(rebuiltConsumerDir, 'node_modules'), { recursive: true, force: true });
  mkdirSync(path.join(rebuiltConsumerDir, 'node_modules'), { recursive: true });
  symlinkSync(path.join(candDir, 'node_modules/@djodjonx'), path.join(rebuiltConsumerDir, 'node_modules/@djodjonx'));
  symlinkSync(path.join(candDir, 'node_modules/typescript'), path.join(rebuiltConsumerDir, 'node_modules/typescript'));
  const rebuiltInstall = path.join(rebuiltConsumerDir, 'node_modules/@acme/tokens');
  mkdirSync(path.join(rebuiltInstall, 'dist'), { recursive: true });
  for (const file of ['package.json', 'dist/tokens.d.ts', 'dist/tokens.mjs', 'dist/tokens-manifest.json']) {
    cpSync(path.join(rebuiltDir, file), path.join(rebuiltInstall, file));
  }
  writeFileSync(path.join(rebuiltConsumerDir, 'src/app.ts'), REBUILT_CONSUMER);
  const rebuiltConsumerOut = path.join(rebuiltConsumerDir, 'dist/app.mjs');
  const rebuiltConsumerBuild = bundleChild(
    candDir,
    rebuiltConsumerDir,
    'src/app.ts',
    rebuiltConsumerOut,
    { project: path.join(rebuiltConsumerDir, 'tsconfig.json'), validation: 'strict', testOverrides: true },
    true,
    'test',
  );
  if (!rebuiltConsumerBuild.ok) fail(`AFTER (candidate tarballs) rebuilt consumer build failed\n${rebuiltConsumerBuild.error}`);
  buildProofs.push(assertBuildProof(rebuiltConsumerBuild.proof, 'AFTER (candidate tarballs) rebuilt consumer', rebuiltConsumerBuild.error));
  const consumerKeys = tokenKeys(readFileSync(rebuiltConsumerOut, 'utf8'));
  if (consumerKeys.join(',') !== rebuiltKeys.join(',')) {
    fail(`AFTER (candidate tarballs) consumer key ${consumerKeys.join(',')} is not producer key ${rebuiltKeys.join(',')}`);
  }
  const rebuiltRun = runExport(rebuiltConsumerOut, 'run', rebuiltConsumerDir);
  if (rebuiltRun.status !== 0) fail(`AFTER (candidate tarballs) rebuilt consumer run failed\n${tail(rebuiltRun.stderr || rebuiltRun.output)}`);
  let rebuiltValue;
  try {
    rebuiltValue = JSON.parse(rebuiltRun.stdout).value;
  } catch {
    fail(`AFTER (candidate tarballs) rebuilt consumer did not return json: ${rebuiltRun.stdout}`);
  }
  if (rebuiltValue !== 'same') fail(`AFTER (candidate tarballs) rebuilt consumer value ${JSON.stringify(rebuiltValue)}`);
  block(
    'AFTER (candidate tarballs) rebuilt producer and consumer',
    `producer key: ${rebuiltKeys.join(',')}\nconsumer key: ${consumerKeys.join(',')}\nresolved: ${rebuiltRun.stdout}`,
  );
  const sameTokenKey = histKeys.join(',') === rebuiltKeys.join(',');
  block(
    'BEFORE (historical npm) vs AFTER (candidate tarballs) token keys',
    [
      'producers: both @acme/tokens, both src/tokens.ts',
      `historical producer: ${histKeys.join(',')}`,
      `candidate producer: ${rebuiltKeys.join(',')}`,
      `historical key differs from candidate key: ${sameTokenKey ? 'no' : 'yes'}`,
      `same key across the rebuild: ${sameTokenKey ? 'yes' : 'no'}`,
    ].join('\n'),
  );
  block('builds read nothing under the repo', buildProofs.join('\n\n'));

  block('AFTER (candidate tarballs) summary', 'migration:historical ok');
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.exitCode = exitCode;
