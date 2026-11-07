// Child build. The parent sets cwd to the project directory so the plugin's
// process.cwd() is that directory, not the monorepo.
import { createRequire } from 'node:module';
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const installDir = process.env.NEO_INSTALL;
const pluginFile = path.join(installDir, 'node_modules/@djodjonx/neosyringe-plugin/dist/index.mjs');
const contextFile = path.join(installDir, 'node_modules/@djodjonx/neosyringe-core/dist/TSContext.mjs');
const proofPath = process.env.NEO_PROOF;
const requireFromPlugin = createRequire(pluginFile);
const ts = requireFromPlugin('typescript');
const reads = new Set();

function note(file) {
  if (typeof file !== 'string' || file.length === 0) return;
  try {
    reads.add(realpathSync(file));
  } catch {
    reads.add(path.resolve(file));
  }
}

const readFile = ts.sys.readFile.bind(ts.sys);
const fileExists = ts.sys.fileExists.bind(ts.sys);
ts.sys.readFile = (file, encoding) => {
  const text = readFile(file, encoding);
  if (typeof text === 'string') note(file);
  return text;
};
ts.sys.fileExists = (file) => {
  const found = fileExists(file);
  if (found) note(file);
  return found;
};

const roots = [];
function noteRoot(value) {
  if (typeof value === 'string' && value !== '') roots.push(value);
}

const { TSContext } = await import(pathToFileURL(contextFile).href);
const descriptor = Object.getOwnPropertyDescriptor(TSContext, 'projectRoot');
if (descriptor) {
  Object.defineProperty(TSContext, 'projectRoot', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      const value = descriptor.get ? descriptor.get.call(this) : undefined;
      noteRoot(value);
      return value;
    },
    set(value) {
      if (descriptor.set) descriptor.set.call(this, value);
      noteRoot(value);
    },
  });
}

let ok = false;
let error = '';
let inputs = [];
try {
  const plugin = await import(pathToFileURL(pluginFile).href);
  if (typeof plugin.neoSyringePlugin?.esbuild !== 'function') {
    throw new Error(`plugin has no esbuild entry: ${pluginFile}`);
  }
  const esbuild = requireFromPlugin('esbuild');
  const built = await esbuild.build({
    absWorkingDir: process.cwd(),
    entryPoints: [process.env.NEO_ENTRY],
    bundle: process.env.NEO_BUNDLE !== 'false',
    format: 'esm',
    platform: 'node',
    outfile: process.env.NEO_OUTFILE,
    metafile: true,
    logLevel: 'silent',
    plugins: [plugin.neoSyringePlugin.esbuild(JSON.parse(process.env.NEO_OPTIONS || '{}'))],
  });
  ok = true;
  inputs = Object.keys(built.metafile?.inputs ?? {});
} catch (caught) {
  const parts = [caught instanceof Error ? caught.message : String(caught)];
  if (caught && Array.isArray(caught.errors)) {
    for (const item of caught.errors) {
      if (item && typeof item.text === 'string') parts.push(item.text);
    }
  }
  error = parts.join('\n');
}

noteRoot(TSContext.projectRoot);
const projectRoots = [];
for (const value of roots) {
  try {
    projectRoots.push(realpathSync(value));
  } catch {
    projectRoots.push(path.resolve(value));
  }
}
const resolvedInputs = [];
for (const input of inputs) {
  const absolute = path.resolve(process.cwd(), input);
  try {
    resolvedInputs.push(realpathSync(absolute));
  } catch {
    resolvedInputs.push(absolute);
  }
}
const projectRoot = projectRoots.length > 0 ? projectRoots[projectRoots.length - 1] : '';
writeFileSync(proofPath, JSON.stringify({
  ok,
  error,
  projectRoot,
  projectRoots: [...new Set(projectRoots)],
  cwd: process.cwd(),
  inputs: resolvedInputs,
  reads: [...reads],
}));
if (!ok) process.exitCode = 1;
