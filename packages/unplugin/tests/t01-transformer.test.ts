import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';

// Default libs are parsed by a real ts.Program on every transform. Keep one SourceFile per .d.ts.
const libSourceFiles = new Map<string, ts.SourceFile>();

function cachedLibPath(fileName: string): string | undefined {
  const norm = fileName.replace(/\\/g, '/');
  if (!norm.endsWith('.d.ts')) return undefined;
  if (norm.includes('/node_modules/') || norm.includes('/typescript/lib/')) return norm;
  return undefined;
}

function cacheLibHost(host: ts.CompilerHost): ts.CompilerHost {
  const read = host.getSourceFile.bind(host);
  return {
    ...host,
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const key = cachedLibPath(fileName);
      if (key && !shouldCreateNewSourceFile) {
        const hit = libSourceFiles.get(key);
        if (hit) return hit;
        const created = read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
        if (created) libSourceFiles.set(key, created);
        return created;
      }
      return read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
  };
}

function createCachedProgram(
  rootNames: readonly string[],
  options: ts.CompilerOptions,
  host?: ts.CompilerHost,
  oldProgram?: ts.Program,
): ts.Program {
  return ts.createProgram(rootNames, options, cacheLibHost(host ?? ts.createCompilerHost(options)), oldProgram);
}

// The transformer calls tsInstance.createProgram. Hand it this object so those programs reuse the cache.
const tsWithLibCache = new Proxy(ts, {
  get(target, prop, receiver) {
    if (prop === 'createProgram') return createCachedProgram;
    if (prop === 'createCompilerHost') {
      return (options: ts.CompilerOptions, setParentNodes?: boolean) => (
        cacheLibHost(target.createCompilerHost(options, setParentNodes))
      );
    }
    return Reflect.get(target, prop, receiver);
  },
}) as typeof ts;

function prewarmLibSourceCache(): void {
  const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('tsconfig.json introuvable');
  const readConfig = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(readConfig.config, ts.sys, process.cwd());
  const entry = path.join(tmpdir(), `t01-lib-cache-${process.pid}.ts`);
  const source = `import '@djodjonx/neosyringe';\nexport {};\n`;
  const host = cacheLibHost(ts.createCompilerHost(parsed.options));
  const readSource = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => fileName === entry || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => (fileName === entry ? source : ts.sys.readFile(fileName));
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === entry) return ts.createSourceFile(fileName, source, languageVersion, true);
    return readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  createCachedProgram([entry], parsed.options, host).getTypeChecker();
}

describe('T01 ts-patch transformer provenance', () => {
  const dirs: string[] = [];

  beforeAll(() => {
    prewarmLibSourceCache();
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('T01-P10-transformer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-transformer-'));
    dirs.push(dir);
    const barrelPath = path.join(dir, 'barrel.ts');
    const consumerPath = path.join(dir, 'consumer.ts');
    writeFileSync(barrelPath, `export { defineBuilderConfig as builder } from '@djodjonx/neosyringe';\n`);
    writeFileSync(consumerPath, `
import { builder } from './barrel';

class Service {}

export const c = builder({
  injections: [{ token: Service }],
});
`);

    const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new Error('tsconfig.json introuvable');
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, process.cwd());
    const program = createCachedProgram([consumerPath], parsed.options);
    const { default: neoSyringeTransformer } = await import('../src/transformer');
    const next = neoSyringeTransformer(program, undefined, {}, { ts: tsWithLibCache } as never);
    const output = next.getSourceFile(consumerPath)?.text ?? '';
    expect(output).not.toContain('builder(');
    expect(output).toContain('class NeoContainer');
  });

  it('T01-P17-transformer-star-barrel', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-transformer-star-'));
    dirs.push(dir);
    const barrelPath = path.join(dir, 'barrel.ts');
    const consumerPath = path.join(dir, 'consumer.ts');
    const plainPath = path.join(dir, 'plain.ts');
    const depPath = path.join(dir, 'dep.ts');
    writeFileSync(barrelPath, `export * from '@djodjonx/neosyringe';\n`);
    writeFileSync(depPath, `export function x(): number { return 1; }\n`);
    writeFileSync(consumerPath, `
import { defineBuilderConfig as b } from './barrel';

class Service {}

export const c = b({
  injections: [{ token: Service }],
});
`);
    const plainSource = `import { x } from './dep';\nexport const n = x();\nexport const m = Math.max(1, 2);\n`;
    writeFileSync(plainPath, plainSource);

    const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new Error('tsconfig.json introuvable');
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, process.cwd());
    const program = createCachedProgram([consumerPath, plainPath], parsed.options);
    const { default: neoSyringeTransformer } = await import('../src/transformer');
    const next = neoSyringeTransformer(program, undefined, {}, { ts: tsWithLibCache } as never);
    const consumerOut = next.getSourceFile(consumerPath)?.text ?? '';
    const plainOut = next.getSourceFile(plainPath)?.text ?? '';
    expect(consumerOut).not.toContain('export const c = b(');
    expect(consumerOut).toContain('class NeoContainer');
    expect(plainOut).toBe(plainSource);
  });
});
