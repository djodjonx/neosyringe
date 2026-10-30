import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { resolveNeoMarker } from '@djodjonx/neosyringe-core/analyzer';
import { neoSyringePlugin } from '../src/index';
import { TSContext } from '@djodjonx/neosyringe-core/context';

const requireFromPackage = createRequire(
  pathToFileURL(path.join(process.cwd(), 'packages/neosyringe/package.json')).href,
);
const runtime = requireFromPackage('@djodjonx/neosyringe');

function endBuild(plugin: ReturnType<typeof neoSyringePlugin.vite>): void {
  const hook = plugin as { buildEnd: () => void };
  hook.buildEnd();
}

function pluginTransform(
  plugin: ReturnType<typeof neoSyringePlugin.vite>,
  code: string,
  id: string,
): string {
  // @ts-expect-error unplugin hook is callable in tests
  const output = plugin.transform(code, id) as string | { code?: string } | null | undefined;
  if (typeof output === 'string') return output;
  if (output && typeof output.code === 'string') return output.code;
  return code;
}

function transpile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

function virtualProgram(files: Map<string, string>, options: ts.CompilerOptions): ts.Program {
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => files.has(fileName) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => (files.has(fileName) ? files.get(fileName) : ts.sys.readFile(fileName));
  host.getSourceFile = (fileName, languageVersion) => {
    const text = files.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return originalGetSourceFile(fileName, languageVersion);
  };
  return ts.createProgram([...files.keys()], options, host);
}

function callMatching(sourceFile: ts.SourceFile, text: string): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.getText(sourceFile).includes(text)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`appel introuvable: ${text}`);
  return found;
}

function unresolvedMarker(files: Map<string, string>, entry: string, callText: string): ReturnType<typeof resolveNeoMarker> {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  };
  const program = virtualProgram(files, options);
  const sourceFile = program.getSourceFile(entry);
  if (!sourceFile) throw new Error(`fichier virtuel absent: ${entry}`);
  return resolveNeoMarker(program.getTypeChecker(), callMatching(sourceFile, callText));
}

function load(javascript: string, req: (id: string) => unknown): Record<string, unknown> {
  const exportsObject: Record<string, unknown> = {};
  const execute = new Function('exports', 'require', javascript) as (
    exportsObject: Record<string, unknown>,
    req: (id: string) => unknown,
  ) => void;
  execute(exportsObject, req);
  return exportsObject;
}

describe('T01 plugin provenance', () => {
  const dirs: string[] = [];

  afterEach(() => {
    TSContext.reset();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('T01-P4b-tokens-file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-tokens-'));
    dirs.push(dir);
    const tokensPath = path.join(dir, 'tokens.ts');
    const containerPath = path.join(dir, 'container.ts');
    const tokensSource = `
import { useInterface, useProperty } from '@djodjonx/neosyringe';

export interface IPort { id: number }
export class Api { constructor(public url: string) {} }

export const PORT = useInterface<IPort>();
export const URL = useProperty<string>(Api, 'url');
export const bundle = {
  port: useInterface<IPort>(),
  url: useProperty<string>(Api, 'url'),
};
`;
    const containerSource = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { Api, PORT, URL } from './tokens';

class Impl implements Api { id = 3; url = ''; }

export const c = defineBuilderConfig({
  injections: [
    { token: PORT, provider: Impl },
    { token: URL, provider: () => 'https://example.test' },
    { token: Api },
  ],
});

export function run() {
  return c.resolve(URL);
}
`;
    writeFileSync(tokensPath, tokensSource);
    writeFileSync(containerPath, containerSource);

    const plugin = neoSyringePlugin.vite();
    const tokensOut = pluginTransform(plugin, tokensSource, tokensPath);
    const containerOut = pluginTransform(plugin, containerSource, containerPath);
    endBuild(plugin);
    expect(tokensOut).not.toMatch(/useProperty\s*(<|\()/);
    expect(tokensOut).not.toMatch(/useInterface\s*(<|\()/);
    expect(containerOut).not.toMatch(/useProperty\s*(<|\()/);
    expect(containerOut).not.toMatch(/useInterface\s*(<|\()/);

    const tokensJs = transpile(tokensOut);
    const containerJs = transpile(containerOut);
    const req = (id: string): unknown => {
      if (id === '@djodjonx/neosyringe') return runtime;
      if (id === './tokens' || id === './tokens.js') return load(tokensJs, req);
      return requireFromPackage(id);
    };
    const exported = load(containerJs, req);
    expect((exported.run as () => unknown)()).toBe('https://example.test');
  });

  it('T01-P5-barrel-et-masque', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-barrel-'));
    dirs.push(dir);
    const barrelPath = path.join(dir, 'barrel.ts');
    const consumerPath = path.join(dir, 'consumer.ts');
    const barrelSource = `export { defineBuilderConfig } from '@djodjonx/neosyringe';\n`;
    const consumerSource = `
import { defineBuilderConfig as builder } from './barrel';

class Service {}

function masked(defineBuilderConfig: (value: { shadowed: boolean }) => { fromLocal: boolean; shadowed: boolean }) {
  return defineBuilderConfig({ shadowed: true });
}

function inner() {
  const defineBuilderConfig = (value: { shadowed: boolean }) => ({ fromLocal: true, shadowed: value.shadowed });
  return defineBuilderConfig({ shadowed: true });
}

export const c = builder({
  injections: [{ token: Service }],
});

export function run() {
  const viaParameter = masked((value) => ({ fromLocal: true, shadowed: value.shadowed }));
  const viaConst = inner();
  return {
    isService: c.resolve(Service) instanceof Service,
    viaParameter,
    viaConst,
  };
}
`;
    writeFileSync(barrelPath, barrelSource);
    writeFileSync(consumerPath, consumerSource);

    const plugin = neoSyringePlugin.vite();
    let output = '';
    let failure = '';
    try {
      output = pluginTransform(plugin, consumerSource, consumerPath);
      endBuild(plugin);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toBe('');
    expect(output).not.toContain('builder(');
    expect(output).toContain('defineBuilderConfig({ shadowed: true })');
    expect(output).toContain('const defineBuilderConfig = ');

    const consumerJs = transpile(output);
    const req = (id: string): unknown => {
      if (id === '@djodjonx/neosyringe') return runtime;
      if (id === './barrel' || id === './barrel.js') {
        return { defineBuilderConfig: (runtime as { defineBuilderConfig: unknown }).defineBuilderConfig };
      }
      return requireFromPackage(id);
    };
    const exported = load(consumerJs, req);
    expect((exported.run as () => unknown)()).toEqual({
      isService: true,
      viaParameter: { fromLocal: true, shadowed: true },
      viaConst: { fromLocal: true, shadowed: true },
    });
  });

  it('T01-P9-diagnostic', () => {
    const id = path.join(process.cwd(), 'tests/e2e/fixtures/t01-diagnostic.ts');
    const code = [
      "import * as neo from '@djodjonx/neosyringe';",
      "const key: string = 'defineBuilderConfig';",
      'export const c = neo[key]({ injections: [] });',
      '',
    ].join('\n');
    const plugin = neoSyringePlugin.vite();
    let caught: Error | undefined;
    try {
      // @ts-expect-error unplugin hook is callable in tests
      plugin.transform(code, id);
    } catch (error) {
      caught = error as Error;
    } finally {
      endBuild(plugin);
    }
    expect(caught?.message ?? '').toContain('NEO_CONFIG_UNSUPPORTED');
    expect(caught?.message ?? '').toContain(id);
    expect(caught?.message ?? '').toContain(':3:');
    expect(caught?.message ?? '').toMatch(/defineBuilderConfig/);
    expect(caught?.message ?? '').toMatch(/alternative/i);
  });

  it('T01-P11-star-barrel', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-star-'));
    dirs.push(dir);
    const barrelPath = path.join(dir, 'barrel.ts');
    const consumerPath = path.join(dir, 'consumer.ts');
    const barrelSource = `export * from '@djodjonx/neosyringe';\n`;
    const consumerSource = `
import { defineBuilderConfig as b } from './barrel';

class Service {}

export const c = b({
  injections: [{ token: Service }],
});

export function run() {
  return c.resolve(Service) instanceof Service;
}
`;
    writeFileSync(barrelPath, barrelSource);
    writeFileSync(consumerPath, consumerSource);

    const plugin = neoSyringePlugin.vite();
    const output = pluginTransform(plugin, consumerSource, consumerPath);
    endBuild(plugin);
    expect(output).not.toContain('export const c = b(');
    expect(output).toContain('class NeoContainer');

    const consumerJs = transpile(output);
    const req = (id: string): unknown => {
      if (id === '@djodjonx/neosyringe') return runtime;
      if (id === './barrel' || id === './barrel.js') return runtime;
      return requireFromPackage(id);
    };
    const exported = load(consumerJs, req);
    expect((exported.run as () => unknown)()).toBe(true);

    const entry = path.join(dir, 'virtual-consumer.ts');
    const virtualBarrel = path.join(dir, 'virtual-barrel.ts');
    const files = new Map<string, string>([
      [virtualBarrel, barrelSource],
      [entry, `import { defineBuilderConfig as b } from './virtual-barrel';\nexport const c = b({ injections: [] });\n`],
    ]);
    expect(unresolvedMarker(files, entry, 'b(')).toBe('defineBuilderConfig');
  });

  it('T01-P12-export-star-as', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-star-as-'));
    dirs.push(dir);
    const barrelPath = path.join(dir, 'barrel.ts');
    const consumerPath = path.join(dir, 'consumer.ts');
    const barrelSource = `export * as neo from '@djodjonx/neosyringe';\n`;
    const consumerSource = `
import { neo } from './barrel';

export interface IPort { id: number }
class Impl implements IPort { id = 4 }

export const port = neo.useInterface<IPort>();
export const c = neo.defineBuilderConfig({
  injections: [{ token: port, provider: Impl }],
});

export function run() {
  return c.resolve(port);
}
`;
    writeFileSync(barrelPath, barrelSource);
    writeFileSync(consumerPath, consumerSource);

    const plugin = neoSyringePlugin.vite();
    const output = pluginTransform(plugin, consumerSource, consumerPath);
    endBuild(plugin);
    expect(output).not.toContain('neo.defineBuilderConfig');
    expect(output).not.toMatch(/useInterface\s*(<|\()/);
    expect(output).toContain('class NeoContainer');

    const consumerJs = transpile(output);
    const req = (id: string): unknown => {
      if (id === '@djodjonx/neosyringe') return runtime;
      if (id === './barrel' || id === './barrel.js') return { neo: runtime };
      return requireFromPackage(id);
    };
    const exported = load(consumerJs, req);
    expect((exported.run as () => unknown)()).toEqual({ id: 4 });

    const entry = path.join(dir, 'virtual-consumer.ts');
    const virtualBarrel = path.join(dir, 'virtual-barrel.ts');
    const files = new Map<string, string>([
      [virtualBarrel, barrelSource],
      [
        entry,
        `import { neo } from './virtual-barrel';\nexport const port = neo.useInterface<{}>();\nexport const c = neo.defineBuilderConfig({ injections: [] });\n`,
      ],
    ]);
    expect(unresolvedMarker(files, entry, 'neo.defineBuilderConfig')).toBe('defineBuilderConfig');
    expect(unresolvedMarker(files, entry, 'neo.useInterface')).toBe('useInterface');
  });

  it('T01-P13-namespace-of-star-barrel', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-ns-star-'));
    dirs.push(dir);
    const barrelPath = path.join(dir, 'barrel.ts');
    const consumerPath = path.join(dir, 'consumer.ts');
    const barrelSource = `export * from '@djodjonx/neosyringe';\n`;
    const consumerSource = `
import * as neo from './barrel';

export interface IPort { id: number }
export class Api { constructor(public url: string) {} }
class Impl implements IPort { id = 5; url = ''; }

export const port = neo.useInterface<IPort>();
export const url = neo.useProperty<string>(Api, 'url');
export const c = neo.defineBuilderConfig({
  injections: [
    { token: port, provider: Impl },
    { token: url, provider: () => 'https://barrel.test' },
  ],
});

export function run() {
  return c.resolve(url);
}
`;
    writeFileSync(barrelPath, barrelSource);
    writeFileSync(consumerPath, consumerSource);

    const plugin = neoSyringePlugin.vite();
    const output = pluginTransform(plugin, consumerSource, consumerPath);
    endBuild(plugin);
    expect(output).not.toMatch(/useInterface\s*(<|\()/);
    expect(output).not.toMatch(/useProperty\s*(<|\()/);
    expect(output).toContain('PropertyToken:Api.url');
    expect(output).toContain('class NeoContainer');

    const consumerJs = transpile(output);
    const req = (id: string): unknown => {
      if (id === '@djodjonx/neosyringe') return runtime;
      if (id === './barrel' || id === './barrel.js') return runtime;
      return requireFromPackage(id);
    };
    const exported = load(consumerJs, req);
    expect((exported.run as () => unknown)()).toBe('https://barrel.test');

    const entry = path.join(dir, 'virtual-consumer.ts');
    const virtualBarrel = path.join(dir, 'virtual-barrel.ts');
    const files = new Map<string, string>([
      [virtualBarrel, barrelSource],
      [
        entry,
        `import * as neo from './virtual-barrel';\nexport class Api {}\nexport const port = neo.useInterface<{}>();\nexport const url = neo.useProperty<string>(Api, 'url');\n`,
      ],
    ]);
    expect(unresolvedMarker(files, entry, 'neo.useInterface')).toBe('useInterface');
    expect(unresolvedMarker(files, entry, 'neo.useProperty')).toBe('useProperty');
  });

  it('T01-P14-type-only-import', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-other-'));
    dirs.push(dir);
    const otherPath = path.join(dir, 'other.ts');
    const barrelPath = path.join(dir, 'barrel.ts');
    const consumerPath = path.join(dir, 'consumer.ts');
    writeFileSync(otherPath, `export function defineBuilderConfig(value: { ok: number }) {\n  return { fromOther: true, ok: value.ok };\n}\n`);
    writeFileSync(barrelPath, `export * from './other';\n`);
    const consumerSource = `
import type { defineBuilderConfig as BuilderType } from '@djodjonx/neosyringe';
import { defineBuilderConfig as foreign } from './barrel';
import * as box from './barrel';

export const built = foreign({ ok: 1 });
export const viaNs = box.defineBuilderConfig({ ok: 3 });

function defineBuilderConfig(value: { ok: number }) {
  return { fromLocal: true, ok: value.ok };
}

export const local = defineBuilderConfig({ ok: 2 });
export type Keep = BuilderType;
`;
    writeFileSync(consumerPath, consumerSource);

    const plugin = neoSyringePlugin.vite();
    const output = pluginTransform(plugin, consumerSource, consumerPath);
    endBuild(plugin);
    expect(output).toContain('foreign({ ok: 1 })');
    expect(output).toContain('box.defineBuilderConfig({ ok: 3 })');
    expect(output).toContain('function defineBuilderConfig');
    expect(output).not.toContain('class NeoContainer');
  });

  it('T01-P15-no-marker-file-untouched', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-plain-'));
    dirs.push(dir);
    const badPath = path.join(dir, 'bad.ts');
    const importerPath = path.join(dir, 'importer.ts');
    const badSource = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

export function x(): number {
  return 1;
}

export function make() {
  return defineBuilderConfig({ injections: [] });
}
`;
    const importerSource = `
import { x } from './bad';

export const n = x();
export const m = Math.max(1, 2);
`;
    writeFileSync(badPath, badSource);
    writeFileSync(importerPath, importerSource);

    const plugin = neoSyringePlugin.vite();
    let thrown = '';
    let output: string | undefined;
    try {
      // @ts-expect-error unplugin hook is callable in tests
      const result = plugin.transform(importerSource, importerPath) as string | undefined;
      output = result;
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    } finally {
      endBuild(plugin);
    }
    expect(thrown).toBe('');
    expect(output === undefined || output === importerSource).toBe(true);
  });

  it('T01-P18-namespace-of-named-barrel', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-named-ns-'));
    dirs.push(dir);
    const barrelPath = path.join(dir, 'barrel.ts');
    const consumerPath = path.join(dir, 'consumer.ts');
    const barrelSource = `export { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';\n`;
    const consumerSource = `
import * as ns from './barrel';

export interface IPort { id: number }
class Impl implements IPort { id = 8 }

export const port = ns.useInterface<IPort>();
export const c = ns.defineBuilderConfig({
  injections: [{ token: port, provider: Impl }],
});

export function run() {
  return c.resolve(port);
}
`;
    writeFileSync(barrelPath, barrelSource);
    writeFileSync(consumerPath, consumerSource);

    const expdefPath = path.join(dir, 'expdef.ts');
    const expdefConsumerPath = path.join(dir, 'expdef-consumer.ts');
    const expdefSource = `import { defineBuilderConfig } from '@djodjonx/neosyringe';\nexport default defineBuilderConfig;\n`;
    const expdefConsumerSource = `
import d from './expdef';

class Service {}

export const c = d({
  injections: [{ token: Service }],
});
`;
    writeFileSync(expdefPath, expdefSource);
    writeFileSync(expdefConsumerPath, expdefConsumerSource);

    const plugin = neoSyringePlugin.vite();
    const output = pluginTransform(plugin, consumerSource, consumerPath);
    const expdefOut = pluginTransform(plugin, expdefConsumerSource, expdefConsumerPath);
    endBuild(plugin);
    expect(output).not.toMatch(/useInterface\s*(<|\()/);
    expect(output).not.toContain('ns.defineBuilderConfig');
    expect(output).toContain('class NeoContainer');
    expect(expdefOut).toContain('class NeoContainer');
    expect(expdefOut).not.toContain('export const c = d(');

    const consumerJs = transpile(output);
    const req = (id: string): unknown => {
      if (id === '@djodjonx/neosyringe') return runtime;
      if (id === './barrel' || id === './barrel.js') return runtime;
      return requireFromPackage(id);
    };
    const exported = load(consumerJs, req);
    expect((exported.run as () => unknown)()).toEqual({ id: 8 });

    const entry = path.join(dir, 'virtual-consumer.ts');
    const virtualBarrel = path.join(dir, 'virtual-barrel.ts');
    const files = new Map<string, string>([
      [virtualBarrel, barrelSource],
      [
        entry,
        `import * as ns from './virtual-barrel';\nexport const port = ns.useInterface<{}>();\nexport const c = ns.defineBuilderConfig({ injections: [] });\n`,
      ],
    ]);
    expect(unresolvedMarker(files, entry, 'ns.useInterface')).toBe('useInterface');
    expect(unresolvedMarker(files, entry, 'ns.defineBuilderConfig')).toBe('defineBuilderConfig');
  });

  it('T01-P19-nested-namespace', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-nested-ns-'));
    dirs.push(dir);
    const starAsPath = path.join(dir, 'star-as-barrel.ts');
    const innerPath = path.join(dir, 'inner.ts');
    const starNamedPath = path.join(dir, 'star-named-barrel.ts');
    const starAsConsumerPath = path.join(dir, 'star-as-consumer.ts');
    const starNamedConsumerPath = path.join(dir, 'star-named-consumer.ts');
    writeFileSync(starAsPath, `export * as neo from '@djodjonx/neosyringe';\n`);
    writeFileSync(innerPath, `export { defineBuilderConfig } from '@djodjonx/neosyringe';\n`);
    writeFileSync(starNamedPath, `export * from './inner';\n`);
    const starAsSource = `
import * as ns from './star-as-barrel';

class Service {}

export const c = ns.neo.defineBuilderConfig({
  injections: [{ token: Service }],
});

export function run() {
  return c.resolve(Service) instanceof Service;
}
`;
    const starNamedSource = `
import * as ns from './star-named-barrel';

class Service {}

export const c = ns.defineBuilderConfig({
  injections: [{ token: Service }],
});

export function run() {
  return c.resolve(Service) instanceof Service;
}
`;
    writeFileSync(starAsConsumerPath, starAsSource);
    writeFileSync(starNamedConsumerPath, starNamedSource);

    const plugin = neoSyringePlugin.vite();
    const starAsOut = pluginTransform(plugin, starAsSource, starAsConsumerPath);
    const starNamedOut = pluginTransform(plugin, starNamedSource, starNamedConsumerPath);
    endBuild(plugin);
    expect(starAsOut).not.toContain('ns.neo.defineBuilderConfig');
    expect(starAsOut).toContain('class NeoContainer');
    expect(starNamedOut).not.toContain('ns.defineBuilderConfig');
    expect(starNamedOut).toContain('class NeoContainer');

    const run = (javascript: string, barrel: string): unknown => {
      const req = (id: string): unknown => {
        if (id === '@djodjonx/neosyringe') return runtime;
        if (id === barrel || id === `${barrel}.js`) return barrel === './star-as-barrel' ? { neo: runtime } : runtime;
        if (id === './inner' || id === './inner.js') return runtime;
        return requireFromPackage(id);
      };
      const exported = load(javascript, req);
      return (exported.run as () => unknown)();
    };
    expect(run(transpile(starAsOut), './star-as-barrel')).toBe(true);
    expect(run(transpile(starNamedOut), './star-named-barrel')).toBe(true);
  });

  it('T01-P20-namespace-negative', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-ns-neg-'));
    dirs.push(dir);
    const localBarrel = path.join(dir, 'local-barrel.ts');
    const foreign = path.join(dir, 'foreign.ts');
    const foreignBarrel = path.join(dir, 'foreign-barrel.ts');
    const localConsumer = path.join(dir, 'local-consumer.ts');
    const foreignConsumer = path.join(dir, 'foreign-consumer.ts');
    writeFileSync(
      localBarrel,
      `export function defineBuilderConfig(value: { ok: number }) {\n  return { fromLocal: true, ok: value.ok };\n}\n`,
    );
    writeFileSync(
      foreign,
      `export function defineBuilderConfig(value: { ok: number }) {\n  return { fromForeign: true, ok: value.ok };\n}\n`,
    );
    const otherPkgBarrel = path.join(dir, 'other-pkg-barrel.ts');
    const otherPkgConsumer = path.join(dir, 'other-pkg-consumer.ts');
    writeFileSync(foreignBarrel, `export { defineBuilderConfig } from './foreign';\n`);
    writeFileSync(otherPkgBarrel, `export { defineBuilderConfig } from 'other-pkg';\n`);
    const localSource = `
import * as ns from './local-barrel';

export const built = ns.defineBuilderConfig({ ok: 1 });
`;
    const foreignSource = `
import * as ns from './foreign-barrel';

export const built = ns.defineBuilderConfig({ ok: 3 });
`;
    const otherPkgSource = `
import * as ns from './other-pkg-barrel';

export const built = ns.defineBuilderConfig({ ok: 4 });
`;
    writeFileSync(localConsumer, localSource);
    writeFileSync(foreignConsumer, foreignSource);
    writeFileSync(otherPkgConsumer, otherPkgSource);

    const plugin = neoSyringePlugin.vite();
    let localResult: unknown;
    let foreignResult: unknown;
    let otherPkgResult: unknown;
    try {
      // @ts-expect-error unplugin hook is callable in tests
      localResult = plugin.transform(localSource, localConsumer);
      // @ts-expect-error unplugin hook is callable in tests
      foreignResult = plugin.transform(foreignSource, foreignConsumer);
      // @ts-expect-error unplugin hook is callable in tests
      otherPkgResult = plugin.transform(otherPkgSource, otherPkgConsumer);
    } finally {
      endBuild(plugin);
    }
    expect(localResult).toBeUndefined();
    expect(foreignResult).toBeUndefined();
    expect(otherPkgResult).toBeUndefined();
  });

  it('T01-P22-cache-same-length-edit', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-cache-'));
    dirs.push(dir);
    const barrelPath = path.join(dir, 'barrel.ts');
    const xPath = path.join(dir, 'x.ts');
    const yPath = path.join(dir, 'y.ts');
    const asBuilder = `export { defineBuilderConfig as b } from '@djodjonx/neosyringe';\n`;
    const asPartial = `export { definePartialConfig as b } from '@djodjonx/neosyringe';\n`;
    expect(asBuilder.length).toBe(asPartial.length);
    const source = `
import { b } from './barrel';

class Service {}

export const c = b({
  injections: [{ token: Service }],
});
`;
    writeFileSync(barrelPath, asBuilder);
    writeFileSync(xPath, source);
    writeFileSync(yPath, source);

    const plugin = neoSyringePlugin.vite();
    try {
      const xOut = pluginTransform(plugin, source, xPath);
      expect(xOut).toContain('class NeoContainer');
      writeFileSync(barrelPath, asPartial);
      const yOut = pluginTransform(plugin, source, yPath);
      expect(yOut).not.toContain('class NeoContainer');
    } finally {
      endBuild(plugin);
    }
  });

  it('T01-P23-export-default-alias', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-expdef-'));
    dirs.push(dir);
    const expdefPath = path.join(dir, 'expdef.ts');
    const aliasPath = path.join(dir, 'aliasdef.ts');
    const chainPath = path.join(dir, 'chain.ts');
    const directPath = path.join(dir, 'direct.ts');
    const aliasConsumerPath = path.join(dir, 'alias-consumer.ts');
    const chainConsumerPath = path.join(dir, 'chain-consumer.ts');
    const nsPath = path.join(dir, 'ns-consumer.ts');
    const expdefSource = `import { defineBuilderConfig } from '@djodjonx/neosyringe';\nexport default defineBuilderConfig;\n`;
    const aliasSource = `import { defineBuilderConfig as z } from '@djodjonx/neosyringe';\nexport default z;\n`;
    const chainSource = `import d from './expdef';\nexport default d;\n`;
    const body = (from: string, call: string): string => `
import ${from};

class Service {}

export const c = ${call}({
  injections: [{ token: Service }],
});

export function run() {
  return c.resolve(Service) instanceof Service;
}
`;
    const directSource = body(`d from './expdef'`, 'd');
    const aliasConsumerSource = body(`d from './aliasdef'`, 'd');
    const chainConsumerSource = body(`d from './chain'`, 'd');
    const nsSource = body(`* as q from './expdef'`, 'q.default');
    writeFileSync(expdefPath, expdefSource);
    writeFileSync(aliasPath, aliasSource);
    writeFileSync(chainPath, chainSource);
    writeFileSync(directPath, directSource);
    writeFileSync(aliasConsumerPath, aliasConsumerSource);
    writeFileSync(chainConsumerPath, chainConsumerSource);
    writeFileSync(nsPath, nsSource);

    const plugin = neoSyringePlugin.vite();
    let directOut = '';
    let aliasOut = '';
    let chainOut = '';
    let nsOut = '';
    try {
      directOut = pluginTransform(plugin, directSource, directPath);
      aliasOut = pluginTransform(plugin, aliasConsumerSource, aliasConsumerPath);
      chainOut = pluginTransform(plugin, chainConsumerSource, chainConsumerPath);
      nsOut = pluginTransform(plugin, nsSource, nsPath);
    } finally {
      endBuild(plugin);
    }

    const prove = (output: string, banned: string): void => {
      expect(output).toContain('class NeoContainer');
      expect(output).not.toContain(banned);
      const exported = load(transpile(output), (id: string) => {
        if (id === '@djodjonx/neosyringe') return runtime;
        if (id === './expdef' || id === './expdef.js') return { default: runtime.defineBuilderConfig };
        if (id === './aliasdef' || id === './aliasdef.js') return { default: runtime.defineBuilderConfig };
        if (id === './chain' || id === './chain.js') return { default: runtime.defineBuilderConfig };
        return requireFromPackage(id);
      });
      expect((exported.run as () => unknown)()).toBe(true);
    };
    prove(directOut, 'export const c = d(');
    prove(aliasOut, 'export const c = d(');
    prove(chainOut, 'export const c = d(');
    prove(nsOut, 'q.default(');

    expect(
      unresolvedMarker(
        new Map([
          [expdefPath, expdefSource],
          [directPath, `import d from './expdef';\nexport const c = d({ injections: [] });\n`],
        ]),
        directPath,
        'd(',
      ),
    ).toBe('defineBuilderConfig');
    expect(
      unresolvedMarker(
        new Map([
          [aliasPath, aliasSource],
          [aliasConsumerPath, `import d from './aliasdef';\nexport const c = d({ injections: [] });\n`],
        ]),
        aliasConsumerPath,
        'd(',
      ),
    ).toBe('defineBuilderConfig');
    expect(
      unresolvedMarker(
        new Map([
          [expdefPath, expdefSource],
          [chainPath, chainSource],
          [chainConsumerPath, `import d from './chain';\nexport const c = d({ injections: [] });\n`],
        ]),
        chainConsumerPath,
        'd(',
      ),
    ).toBe('defineBuilderConfig');
    expect(
      unresolvedMarker(
        new Map([
          [expdefPath, expdefSource],
          [nsPath, `import * as q from './expdef';\nexport const c = q.default({ injections: [] });\n`],
        ]),
        nsPath,
        'q.default(',
      ),
    ).toBe('defineBuilderConfig');
  });

  it('T01-P24-export-default-negative', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-expdef-neg-'));
    dirs.push(dir);
    const localPath = path.join(dir, 'localdef.ts');
    const otherPath = path.join(dir, 'otherdef.ts');
    const eqPath = path.join(dir, 'eqdef.ts');
    const localConsumer = path.join(dir, 'local-consumer.ts');
    const otherConsumer = path.join(dir, 'other-consumer.ts');
    const eqConsumer = path.join(dir, 'eq-consumer.ts');
    writeFileSync(
      localPath,
      `export default function defineBuilderConfig(value: { ok: number }) {\n  return { fromLocal: true, ok: value.ok };\n}\n`,
    );
    writeFileSync(
      otherPath,
      `import { defineBuilderConfig } from 'other-pkg';\nexport default defineBuilderConfig;\n`,
    );
    writeFileSync(
      eqPath,
      `import { defineBuilderConfig } from '@djodjonx/neosyringe';\nexport = defineBuilderConfig;\n`,
    );
    const localSource = `
import d from './localdef';

export const built = d({ ok: 1 });
`;
    const otherSource = `
import d from './otherdef';

export const built = d({ ok: 1 });
`;
    const eqSource = `
import d = require('./eqdef');

export const built = d({ ok: 1 });
`;
    writeFileSync(localConsumer, localSource);
    writeFileSync(otherConsumer, otherSource);
    writeFileSync(eqConsumer, eqSource);

    const plugin = neoSyringePlugin.vite();
    let localResult: unknown;
    let otherResult: unknown;
    let eqResult: unknown;
    try {
      // @ts-expect-error unplugin hook is callable in tests
      localResult = plugin.transform(localSource, localConsumer);
      // @ts-expect-error unplugin hook is callable in tests
      otherResult = plugin.transform(otherSource, otherConsumer);
      // @ts-expect-error unplugin hook is callable in tests
      eqResult = plugin.transform(eqSource, eqConsumer);
    } finally {
      endBuild(plugin);
    }
    expect(localResult).toBeUndefined();
    expect(otherResult).toBeUndefined();
    expect(eqResult).toBeUndefined();
  });
});
