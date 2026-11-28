/**
 * G04 incremental-session bench. Not part of vitest and not part of `pnpm test`. Opt-in:
 *   pnpm bench:g04            (runs `node --expose-gc tests/bench/g04-soak.mjs`)
 *
 * Like compile-cost.mjs, it bundles `packages/unplugin/src` with esbuild into a module under
 * `os.tmpdir()`, so nothing has to be built first. The output is JSON lines with counts, timings and
 * heap sizes only: no source text and no configuration value.
 *
 * Env: NEOSYRINGE_G04_MODE (cold | warm | soak | close | multi | rebuild | bigroots | all, default all; `all` runs
 *      none of multi, rebuild and bigroots),
 *      NEOSYRINGE_G04_SRC (a directory holding `packages/unplugin/src`, to measure another copy of the plugin, e.g. a
 *      `git archive` of the base commit; default: this repository),
 *      NEOSYRINGE_G04_ROOTS (tsconfig roots of the bigroots tree, default 386),
 *      NEOSYRINGE_G04_LIB (1: the trees use the `es5` lib instead of `noLib`, so a rebuild shows what happens to lib files),
 *      NEOSYRINGE_G04_EDITS (soak edits, default 1000), NEOSYRINGE_G04_FILES (files of the soak tree, default 20),
 *      NEOSYRINGE_G04_COLD_SIZES (containers of the cold and warm trees, default 100; 5000 for the orchestrator),
 *      NEOSYRINGE_G04_MULTI_SIZES (containers of the multi trees, default 50,200).
 *
 * cold:  first transform of every container, then buildEnd. Programs, parses and analyses it took, RSS.
 * warm:  on the tree of cold, a leaf edit and a dependency type edit, median of 5, with the work they did.
 * soak:  EDITS edits of five kinds, each compared with a clean plugin instance on the same tree; heap after
 *        gc every 50 edits; the verdict compares the median of the first quarter with the last one.
 * close: after buildEnd and closeBundle, whether a Program and three SourceFiles are still reachable.
 * rebuild:  an esbuild-style rebuild on one plugin instance: buildStart, a transform of every container, buildEnd,
 *        no watcher event, no closeBundle; one leaf is edited between two builds. Build 0 is cold. Time and parses per build.
 * bigroots: a tsconfig that lists ROOTS files, one container with a one-file closure. First transform, then five
 *        edits of the container's dependency (watch mode): the cost of a large tsconfig with a small closure.
 * multi: M independent container files, each with its own small graph (a container, its class and one leaf file).
 *        Cold build (every transform, then buildEnd), then an edit of one leaf of container X and a transform of X,
 *        median of 5 edits on five different containers. Reports the time and the number of containers analysed
 *        per edit: it must follow what X imports, not M.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = repoRoot();
const require = createRequire(path.join(root, 'packages/unplugin/package.json'));
const esbuild = require('esbuild');
const neosyringeSrc = path.join(root, 'packages/neosyringe/src/index.ts');

const mode = (process.env.NEOSYRINGE_G04_MODE || 'all').trim();
const edits = intEnv('NEOSYRINGE_G04_EDITS', 1000);
const soakFiles = intEnv('NEOSYRINGE_G04_FILES', 20);
const coldSizes = (process.env.NEOSYRINGE_G04_COLD_SIZES || '100').split(',').map((part) => Number(part.trim()));
const unpluginRoot = process.env.NEOSYRINGE_G04_SRC ? path.resolve(process.env.NEOSYRINGE_G04_SRC) : root;
const withLib = process.env.NEOSYRINGE_G04_LIB === '1';
const bigRoots = intEnv('NEOSYRINGE_G04_ROOTS', 386);
const multiSizes = (process.env.NEOSYRINGE_G04_MULTI_SIZES || '50,200').split(',').map((part) => Number(part.trim()));

function repoRoot() {
  let dir = path.resolve(process.cwd());
  for (;;) {
    try {
      readFileSync(path.join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('racine du dépôt introuvable');
      dir = parent;
    }
  }
}

function intEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} attend un entier >= 1`);
  return value;
}

function emit(row) {
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

const externalNames = ['typescript', 'unplugin', '@jridgewell/trace-mapping', '@djodjonx/neosyringe-core', '@djodjonx/neosyringe-ui'];

function packageRoot(name) {
  for (const candidate of [path.join(root, 'packages/unplugin/node_modules', name), path.join(root, 'node_modules', name)]) {
    try {
      readFileSync(path.join(candidate, 'package.json'));
      return candidate;
    } catch {
      // try the next place
    }
  }
  throw new Error(`paquet introuvable: ${name}`);
}

async function loadPlugin() {
  const outdir = mkdtempSync(path.join(tmpdir(), 'g04-bench-bundle-'));
  for (const name of externalNames) {
    const link = path.join(outdir, 'node_modules', name);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(packageRoot(name), link);
  }
  const outfile = path.join(outdir, 'g04-bench.mjs');
  await esbuild.build({
    stdin: {
      contents: [
        `export { neoSyringePlugin } from ${JSON.stringify(path.join(unpluginRoot, 'packages/unplugin/src/index.ts'))};`,
        `export { sessionStateKey } from ${JSON.stringify(path.join(unpluginRoot, 'packages/unplugin/src/session.ts'))};`,
      ].join('\n'),
      resolveDir: path.join(root, 'packages/unplugin'),
      sourcefile: 'g04-bench-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    external: externalNames,
    logLevel: 'silent',
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { outdir, ...loaded };
}

const MARK = "import { defineBuilderConfig } from '@djodjonx/neosyringe';\n";

function leafText(index, revision = 0) {
  return `${MARK}import { Shared } from './contract';
export class N${index} { constructor(public dep: Shared) {} id = ${revision}; }
export const c = defineBuilderConfig({ injections: [{ token: Shared }, { token: N${index} }] });
`;
}

const SHARED_PLAIN = 'export class Buddy {}\nexport class Shared { constructor() {} }\n';
const SHARED_BUDDY = 'export class Buddy {}\nexport class Shared { constructor(public buddy: Buddy) {} }\n';

function tsconfigText(aliasTarget) {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      ...(withLib ? { lib: ['es5'] } : { noLib: true }),
      types: [],
      skipLibCheck: true,
      baseUrl: '.',
      paths: { '@djodjonx/neosyringe': [neosyringeSrc], '@app/dep': [aliasTarget] },
    },
    include: ['**/*.ts'],
  });
}

function pkgManifest(target) {
  return JSON.stringify({ name: 'pkg', version: '1.0.0', exports: { '.': { types: target } } });
}

function writeTree(dir, size) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'contract.ts'), SHARED_PLAIN);
  writeFileSync(path.join(dir, 'dep-a.ts'), 'export class Aliased { constructor() {} }\n');
  writeFileSync(path.join(dir, 'dep-b.ts'), 'export class Buddy2 {}\nexport class Aliased { constructor(public b: Buddy2) {} }\n');
  writeFileSync(path.join(dir, 'tsconfig.json'), tsconfigText('./dep-a.ts'));
  mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules/pkg/package.json'), pkgManifest('./a.d.ts'));
  writeFileSync(path.join(dir, 'node_modules/pkg/a.d.ts'), 'export declare class PkgDep { constructor(); }\n');
  writeFileSync(path.join(dir, 'node_modules/pkg/b.d.ts'), 'export declare class Extra {}\nexport declare class PkgDep { constructor(extra: Extra); }\n');
  writeFileSync(path.join(dir, 'viaalias.ts'), `${MARK}import { Aliased } from '@app/dep';\nexport const c = defineBuilderConfig({ injections: [{ token: Aliased }] });\n`);
  writeFileSync(path.join(dir, 'viapkg.ts'), `${MARK}import { PkgDep } from 'pkg';\nexport const c = defineBuilderConfig({ injections: [{ token: PkgDep }] });\n`);
  const leaves = [];
  for (let i = 0; i < size; i += 1) {
    const file = path.join(dir, `leaf${i}.ts`);
    writeFileSync(file, leafText(i));
    leaves.push(file);
  }
  return { dir, leaves, config: path.join(dir, 'tsconfig.json') };
}

function hook(plugin, name, context, args) {
  const fn = Reflect.get(plugin, name);
  if (typeof fn !== 'function') return undefined;
  return Reflect.apply(fn, context, args);
}

function transform(plugin, file, text = readFileSync(file, 'utf8')) {
  try {
    const result = hook(plugin, 'transform', {}, [text, file]);
    if (typeof result === 'string') return result;
    if (result && typeof result.code === 'string') return result.code;
    return text;
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function stateOf(api, plugin) {
  return Reflect.get(plugin, api.sessionStateKey);
}

function work(api, plugin) {
  const state = stateOf(api, plugin);
  const stats = state.project?.stats();
  return {
    programsBuilt: stats?.programsBuilt ?? 0,
    sourcesParsed: stats?.sourcesParsed ?? 0,
    sourcesReused: stats?.sourcesReused ?? 0,
    analysesBuilt: state.analysesBuilt ?? 0,
    containersAnalysed: state.containersAnalysed ?? 0,
    graphsBuilt: state.graphsBuilt,
    filesParsed: state.filesParsed,
  };
}

function diff(after, before) {
  const out = {};
  for (const key of Object.keys(after)) out[key] = after[key] - before[key];
  return out;
}

function cleanTransform(api, config, file) {
  const plugin = api.neoSyringePlugin.vite({ project: config });
  try {
    return transform(plugin, file);
  } finally {
    hook(plugin, 'closeWatcher', { meta: { watchMode: true } }, []);
  }
}

async function cold(api, size) {
  const { dir, leaves, config } = writeTree(mkdtempSync(path.join(tmpdir(), `g04-cold-${size}-`)), size);
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const plugin = api.neoSyringePlugin.vite({ project: config });
    global.gc?.();
    const rssBefore = process.memoryUsage().rss;
    const start = performance.now();
    for (const file of leaves) transform(plugin, file);
    const transformMs = performance.now() - start;
    const counts = work(api, plugin);
    const mid = performance.now();
    try {
      hook(plugin, 'buildEnd', {}, []);
    } catch {
      // a usage error would be reported here; the tree has none
    }
    const endMs = performance.now() - mid;
    emit({
      kind: 'cold',
      size,
      transformMs: Math.round(transformMs),
      buildEndMs: Math.round(endMs),
      totalMs: Math.round(transformMs + endMs),
      rssDeltaMb: mb(process.memoryUsage().rss - rssBefore),
      ...counts,
    });
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function warm(api, size) {
  const { dir, leaves, config } = writeTree(mkdtempSync(path.join(tmpdir(), `g04-warm-${size}-`)), size);
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const plugin = api.neoSyringePlugin.vite({ project: config });
    hook(plugin, 'buildStart', { meta: { watchMode: true } }, [{}]);
    for (const file of leaves) transform(plugin, file);
    const leaf = leaves[leaves.length - 1];
    const contract = path.join(dir, 'contract.ts');
    const leafMs = [];
    const depMs = [];
    let leafWork = null;
    let depWork = null;
    for (let rep = 0; rep < 5; rep += 1) {
      let before = work(api, plugin);
      writeFileSync(leaf, leafText(size - 1, rep + 1));
      hook(plugin, 'watchChange', {}, [leaf, { event: 'update' }]);
      let start = performance.now();
      transform(plugin, leaf);
      leafMs.push(performance.now() - start);
      leafWork = diff(work(api, plugin), before);
      before = work(api, plugin);
      writeFileSync(contract, rep % 2 === 0 ? SHARED_BUDDY : SHARED_PLAIN);
      hook(plugin, 'watchChange', {}, [contract, { event: 'update' }]);
      start = performance.now();
      transform(plugin, leaf);
      depMs.push(performance.now() - start);
      depWork = diff(work(api, plugin), before);
    }
    emit({ kind: 'warm', size, case: 'leaf-edit', medianMs: Math.round(median(leafMs) * 10) / 10, work: leafWork });
    emit({ kind: 'warm', size, case: 'dependency-type-edit', medianMs: Math.round(median(depMs) * 10) / 10, work: depWork });
    hook(plugin, 'closeWatcher', { meta: { watchMode: true } }, []);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

function multiLeafText(index, revision) {
  return `export class Leaf${index} { id = ${revision}; }\n`;
}

function multiContainerText(index) {
  return `${MARK}import { Leaf${index} } from './leaf${index}';
export class Svc${index} { constructor(public leaf: Leaf${index}) {} }
export const c = defineBuilderConfig({ injections: [{ token: Leaf${index} }, { token: Svc${index} }] });
`;
}

function writeMultiTree(dir, size) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'tsconfig.json'), tsconfigText('./dep-a.ts'));
  writeFileSync(path.join(dir, 'dep-a.ts'), 'export class Aliased { constructor() {} }\n');
  const containers = [];
  for (let i = 0; i < size; i += 1) {
    writeFileSync(path.join(dir, `leaf${i}.ts`), multiLeafText(i, 0));
    const file = path.join(dir, `c${i}.ts`);
    writeFileSync(file, multiContainerText(i));
    containers.push(file);
  }
  return { dir, containers, config: path.join(dir, 'tsconfig.json') };
}

async function multi(api, size) {
  const { dir, containers, config } = writeMultiTree(mkdtempSync(path.join(tmpdir(), `g04-multi-${size}-`)), size);
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const plugin = api.neoSyringePlugin.vite({ project: config });
    hook(plugin, 'buildStart', { meta: { watchMode: true } }, [{}]);
    // A transform that failed or generated nothing is counted: a fast number of a broken run proves nothing.
    let wrong = 0;
    const generated = (code) => !code.startsWith('error:') && code.includes(`new Leaf`);
    const start = performance.now();
    for (const file of containers) if (!generated(transform(plugin, file))) wrong += 1;
    const transformMs = performance.now() - start;
    const mid = performance.now();
    try {
      hook(plugin, 'buildEnd', {}, []);
    } catch {
      // a usage error would be reported here; the tree has none
    }
    const endMs = performance.now() - mid;
    emit({
      kind: 'multi-cold',
      size,
      wrongTransforms: wrong,
      transformMs: Math.round(transformMs),
      buildEndMs: Math.round(endMs),
      totalMs: Math.round(transformMs + endMs),
      ...work(api, plugin),
    });
    // The session stays open between builds in watch mode: edit one leaf, transform its container.
    const ms = [];
    const analysed = [];
    const analyses = [];
    const programs = [];
    const parsed = [];
    for (let rep = 0; rep < 5; rep += 1) {
      const index = Math.floor(((rep + 1) * size) / 6);
      const leaf = path.join(dir, `leaf${index}.ts`);
      const before = work(api, plugin);
      writeFileSync(leaf, multiLeafText(index, rep + 1));
      hook(plugin, 'watchChange', {}, [leaf, { event: 'update' }]);
      const begin = performance.now();
      if (!generated(transform(plugin, containers[index]))) wrong += 1;
      ms.push(performance.now() - begin);
      const done = diff(work(api, plugin), before);
      analysed.push(done.containersAnalysed);
      analyses.push(done.analysesBuilt);
      programs.push(done.programsBuilt);
      parsed.push(done.sourcesParsed);
    }
    emit({
      kind: 'multi-edit',
      size,
      wrongTransforms: wrong,
      medianMs: Math.round(median(ms) * 10) / 10,
      containersAnalysedPerEdit: analysed,
      analysesPerEdit: analyses,
      programsPerEdit: programs,
      sourcesParsedPerEdit: parsed,
    });
    hook(plugin, 'closeWatcher', { meta: { watchMode: true } }, []);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function rebuild(api, size) {
  const { dir, leaves, config } = writeTree(mkdtempSync(path.join(tmpdir(), `g04-rebuild-${size}-`)), size);
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const plugin = api.neoSyringePlugin.vite({ project: config });
    const rows = [];
    let wrong = 0;
    for (let build = 0; build < 6; build += 1) {
      if (build > 0) writeFileSync(leaves[0], leafText(0, build));
      const before = work(api, plugin);
      const start = performance.now();
      hook(plugin, 'buildStart', {}, [{}]);
      for (const file of leaves) if (transform(plugin, file).startsWith('error:')) wrong += 1;
      try {
        hook(plugin, 'buildEnd', {}, []);
      } catch {
        // a usage error would be reported here; the tree has none
      }
      const ms = performance.now() - start;
      const done = diff(work(api, plugin), before);
      rows.push({ build, ms: Math.round(ms), filesParsed: done.filesParsed });
    }
    const later = rows.slice(1).map((row) => row.ms);
    emit({ kind: 'rebuild', size, wrongTransforms: wrong, coldMs: rows[0].ms, rebuildMedianMs: median(later), builds: rows });
    hook(plugin, 'closeWatcher', { meta: { watchMode: true } }, []);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function bigroots(api, roots) {
  const dir = mkdtempSync(path.join(tmpdir(), `g04-bigroots-${roots}-`));
  writeFileSync(path.join(dir, 'tsconfig.json'), tsconfigText('./dep-a.ts'));
  writeFileSync(path.join(dir, 'dep-a.ts'), 'export class Aliased { constructor() {} }\n');
  writeFileSync(path.join(dir, 'contract.ts'), SHARED_PLAIN);
  writeFileSync(path.join(dir, 'app.ts'), leafText(0));
  // Each root is a module of about a hundred lines of types and functions that imports a helper of the same size,
  // two thirds of a file per root more than the roots themselves: the program of the tsconfig is what is measured.
  const body = (name) => Array.from({ length: 24 }, (_, n) => `export interface ${name}Shape${n} { id: number; label: string; items: ${name}Shape${Math.max(0, n - 1)}[] }
export function ${name}Make${n}(seed: number): ${name}Shape${n} { return { id: seed + ${n}, label: String(seed), items: [] }; }
`).join('');
  for (let i = 0; i < roots; i += 1) {
    writeFileSync(path.join(dir, `h${i}.ts`), `${body(`H${i}`)}export const h${i} = ${i};\n`);
    writeFileSync(path.join(dir, `r${i}.ts`), `import { h${i} } from './h${i}';\n${body(`R${i}`)}export const v${i} = h${i} + 1;\n`);
  }
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const plugin = api.neoSyringePlugin.vite({ project: path.join(dir, 'tsconfig.json') });
    hook(plugin, 'buildStart', { meta: { watchMode: true } }, [{}]);
    const app = path.join(dir, 'app.ts');
    const contract = path.join(dir, 'contract.ts');
    let start = performance.now();
    const first = transform(plugin, app);
    const firstMs = performance.now() - start;
    const ms = [];
    let wrong = first.startsWith('error:') ? 1 : 0;
    for (let rep = 0; rep < 5; rep += 1) {
      writeFileSync(contract, rep % 2 === 0 ? SHARED_BUDDY : SHARED_PLAIN);
      hook(plugin, 'watchChange', {}, [contract, { event: 'update' }]);
      start = performance.now();
      const code = transform(plugin, app);
      ms.push(performance.now() - start);
      if (rep % 2 === 0 ? !code.startsWith('error:') : code.startsWith('error:')) wrong += 1;
    }
    emit({ kind: 'bigroots', roots, files: roots * 2 + 4, wrongTransforms: wrong, firstMs: Math.round(firstMs), editsMs: ms.map((value) => Math.round(value * 10) / 10), editMedianMs: Math.round(median(ms) * 10) / 10 });
    hook(plugin, 'closeWatcher', { meta: { watchMode: true } }, []);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function soak(api) {
  const { dir, leaves, config } = writeTree(mkdtempSync(path.join(tmpdir(), 'g04-soak-')), soakFiles);
  const previous = process.cwd();
  process.chdir(dir);
  const plugin = api.neoSyringePlugin.vite({ project: config });
  hook(plugin, 'buildStart', { meta: { watchMode: true } }, [{}]);
  for (const file of leaves) transform(plugin, file);
  const contract = path.join(dir, 'contract.ts');
  const temp = path.join(dir, 'temp.ts');
  const viaAlias = path.join(dir, 'viaalias.ts');
  const viaPkg = path.join(dir, 'viapkg.ts');
  const manifest = path.join(dir, 'node_modules/pkg/package.json');
  const heap = [];
  let mismatches = 0;
  let tempExists = false;
  let aliasB = false;
  let pkgB = false;
  let depBuddy = false;
  const kinds = ['leaf-edit', 'dependency-type', 'create-delete', 'tsconfig-paths', 'package-exports'];
  // A changed compiler option replaces the session: its counters are read before it goes, and added up.
  const reasons = new Map();
  let lastProject;
  let lastStats = [];
  const addUp = (rows) => {
    for (const row of rows) {
      const id = `${row.kind}:${row.reason}`;
      reasons.set(id, (reasons.get(id) ?? 0) + row.count);
    }
  };
  const started = performance.now();
  try {
    for (let step = 0; step < edits; step += 1) {
      const kind = kinds[step % kinds.length];
      const leaf = leaves[step % leaves.length];
      let target = leaf;
      if (kind === 'leaf-edit') {
        writeFileSync(leaf, leafText(step % leaves.length, step));
        hook(plugin, 'watchChange', {}, [leaf, { event: 'update' }]);
      } else if (kind === 'dependency-type') {
        depBuddy = !depBuddy;
        writeFileSync(contract, depBuddy ? SHARED_BUDDY : SHARED_PLAIN);
        hook(plugin, 'watchChange', {}, [contract, { event: 'update' }]);
      } else if (kind === 'create-delete') {
        target = temp;
        if (!tempExists) {
          writeFileSync(temp, leafText(9999, step));
          hook(plugin, 'watchChange', {}, [temp, { event: 'create' }]);
          tempExists = true;
        } else {
          unlinkSync(temp);
          hook(plugin, 'watchChange', {}, [temp, { event: 'delete' }]);
          tempExists = false;
          target = leaf;
        }
      } else if (kind === 'tsconfig-paths') {
        aliasB = !aliasB;
        writeFileSync(config, tsconfigText(aliasB ? './dep-b.ts' : './dep-a.ts'));
        hook(plugin, 'watchChange', {}, [config, { event: 'update' }]);
        target = viaAlias;
      } else {
        pkgB = !pkgB;
        writeFileSync(manifest, pkgManifest(pkgB ? './b.d.ts' : './a.d.ts'));
        hook(plugin, 'watchChange', {}, [manifest, { event: 'update' }]);
        target = viaPkg;
      }
      const live = transform(plugin, target);
      const clean = cleanTransform(api, config, target);
      if (live !== clean) mismatches += 1;
      const project = stateOf(api, plugin).project;
      if (project !== lastProject) {
        addUp(lastStats);
        lastProject = project;
      }
      lastStats = project ? project.stats().invalidations : [];
      if ((step + 1) % 50 === 0) {
        global.gc?.();
        heap.push(process.memoryUsage().heapUsed);
      }
    }
    const counts = work(api, plugin);
    addUp(lastStats);
    const quarter = Math.max(1, Math.floor(heap.length / 4));
    const first = median(heap.slice(0, quarter));
    const last = median(heap.slice(-quarter));
    emit({
      kind: 'soak',
      edits,
      files: soakFiles,
      mismatches,
      seconds: Math.round((performance.now() - started) / 1000),
      heapMb: heap.map(mb),
      firstQuarterMedianMb: mb(first),
      lastQuarterMedianMb: mb(last),
      growthMb: mb(last - first),
      invalidations: Object.fromEntries([...reasons].sort()),
      ...counts,
    });
  } finally {
    hook(plugin, 'closeWatcher', { meta: { watchMode: true } }, []);
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

function retentionProbe(api, leaves, config) {
  const plugin = api.neoSyringePlugin.vite({ project: config });
  for (const file of leaves) transform(plugin, file);
  const state = stateOf(api, plugin);
  const program = state.previousProgram;
  const refs = {
    program: new WeakRef(program),
    sources: leaves.slice(0, 3).map((file) => new WeakRef(program.getSourceFile(file))),
    session: new WeakRef(state.project),
  };
  return { plugin, refs };
}

function reachable(refs) {
  return {
    program: refs.program.deref() !== undefined,
    sources: refs.sources.map((ref) => ref.deref() !== undefined),
    session: refs.session.deref() !== undefined,
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    global.gc?.();
  }
}

async function close(api) {
  const { dir, leaves, config } = writeTree(mkdtempSync(path.join(tmpdir(), 'g04-close-')), soakFiles);
  const previous = process.cwd();
  process.chdir(dir);
  try {
    const { plugin, refs } = retentionProbe(api, leaves, config);
    await settle();
    // The probe must see the objects while the session is open: otherwise "released" proves nothing.
    const before = reachable(refs);
    hook(plugin, 'buildEnd', {}, []);
    hook(plugin, 'closeBundle', { meta: { watchMode: false } }, []);
    await settle();
    emit({ kind: 'close', beforeClose: before, afterClose: reachable(refs) });
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  if (typeof global.gc !== 'function') throw new Error('lancer avec --expose-gc (pnpm bench:g04)');
  const api = await loadPlugin();
  try {
    if (mode === 'cold' || mode === 'all') for (const size of coldSizes) await cold(api, size);
    if (mode === 'warm' || mode === 'all') for (const size of coldSizes) await warm(api, size);
    if (mode === 'soak' || mode === 'all') await soak(api);
    if (mode === 'close' || mode === 'all') await close(api);
    if (mode === 'multi') for (const size of multiSizes) await multi(api, size);
    if (mode === 'rebuild') for (const size of coldSizes) await rebuild(api, size);
    if (mode === 'bigroots') await bigroots(api, bigRoots);
  } finally {
    rmSync(api.outdir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
