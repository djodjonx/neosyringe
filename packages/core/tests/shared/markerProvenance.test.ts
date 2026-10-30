import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  formatUnsupportedMarker,
  resolveNeoMarker,
  sourceFileUsesMarker,
  type NeoMarkerResolution,
} from '../../src/analyzer/shared/markerProvenance';

const PACKAGE_FILE = '/virtual/pkg/neosyringe.ts';

const PACKAGE_SOURCE = `
export function defineBuilderConfig(config: object): object { return config; }
export function definePartialConfig(config: object): object { return config; }
export function declareContainerTokens(value: unknown): unknown { return value; }
export function useInterface(): unknown { return undefined; }
export function useProperty(): unknown { return undefined; }
`;

function compile(files: Record<string, string>, resolvePackage: boolean): {
  program: ts.Program;
  checker: ts.TypeChecker;
  source: (fileName: string) => ts.SourceFile;
} {
  const virtual = new Map<string, string>(Object.entries(files));
  if (resolvePackage) virtual.set(PACKAGE_FILE, PACKAGE_SOURCE);

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    noLib: true,
    baseUrl: '/virtual',
    paths: resolvePackage ? { '@djodjonx/neosyringe': ['pkg/neosyringe.ts'] } : {},
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalDirectoryExists = host.directoryExists?.bind(host);

  const textOf = (fileName: string): string | undefined => virtual.get(fileName.replace(/\\/g, '/'));
  const blocked = (fileName: string): boolean => {
    if (resolvePackage) return false;
    const name = fileName.replace(/\\/g, '/');
    return name.includes('@djodjonx/neosyringe') || name.includes('/virtual/pkg/');
  };

  host.getCurrentDirectory = () => '/virtual';
  host.directoryExists = (directoryName) => {
    const name = directoryName.replace(/\\/g, '/');
    if (name === '/virtual' || name.startsWith('/virtual/')) return true;
    return originalDirectoryExists?.(directoryName) ?? false;
  };
  host.fileExists = (fileName) => {
    if (textOf(fileName) !== undefined) return true;
    if (blocked(fileName)) return false;
    return originalFileExists(fileName);
  };
  host.readFile = (fileName) => {
    const text = textOf(fileName);
    if (text !== undefined) return text;
    if (blocked(fileName)) return undefined;
    return originalReadFile(fileName);
  };
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = textOf(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    if (blocked(fileName)) return undefined;
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  const program = ts.createProgram(Object.keys(files), options, host);
  const checker = program.getTypeChecker();
  return {
    program,
    checker,
    source(fileName: string) {
      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) throw new Error(`fichier virtuel absent: ${fileName}`);
      return sourceFile;
    },
  };
}

function callIncluding(sourceFile: ts.SourceFile, needle: string): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && node.getText(sourceFile).includes(needle)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`appel introuvable: ${needle}`);
  return found;
}

function markerOf(
  files: Record<string, string>,
  entry: string,
  needle: string,
  resolvePackage: boolean,
): NeoMarkerResolution {
  const { checker, source } = compile(files, resolvePackage);
  return resolveNeoMarker(checker, callIncluding(source(entry), needle));
}

function loadsPackage(files: Record<string, string>, resolvePackage: boolean): boolean {
  const { program } = compile(files, resolvePackage);
  return program
    .getSourceFiles()
    .some((file) => file.fileName.replace(/\\/g, '/').endsWith('/pkg/neosyringe.ts'));
}

const ALIAS = `
import { defineBuilderConfig as builder } from '@djodjonx/neosyringe';
export const c = builder({ injections: [] });
`;

const NAMESPACE = `
import * as neo from '@djodjonx/neosyringe';
export const partial = neo.definePartialConfig({});
export const legacy = neo.declareContainerTokens(null);
export const prop = neo['useProperty']();
export const other = neo.notAMarker();
`;

const NAMED_REEXPORT = {
  '/virtual/reexport.ts': `export { useInterface as iface } from '@djodjonx/neosyringe';\n`,
  '/virtual/alias-app.ts': `import { iface as token } from './reexport';\nexport const t = token();\n`,
};

const NAMED_NAMESPACE = {
  '/virtual/named-barrel.ts': `export { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';\n`,
  '/virtual/named-ns-app.ts': `import * as ns from './named-barrel';\nexport const c = ns.defineBuilderConfig({});\nexport const port = ns.useInterface();\n`,
};

describe('markerProvenance', () => {
  it('P26 alias and namespace resolve to the marker name', () => {
    const aliasFiles = { '/virtual/alias.ts': ALIAS };
    expect(loadsPackage(aliasFiles, false)).toBe(false);
    expect(loadsPackage(aliasFiles, true)).toBe(true);
    expect(markerOf(aliasFiles, '/virtual/alias.ts', 'builder(', false)).toBe('defineBuilderConfig');
    expect(markerOf(aliasFiles, '/virtual/alias.ts', 'builder(', true)).toBe('defineBuilderConfig');

    expect(markerOf({ '/virtual/ns.ts': NAMESPACE }, '/virtual/ns.ts', 'neo.definePartialConfig', false)).toBe(
      'definePartialConfig',
    );
    expect(markerOf({ '/virtual/ns.ts': NAMESPACE }, '/virtual/ns.ts', 'neo.declareContainerTokens', true)).toBe(
      'declareContainerTokens',
    );
    expect(markerOf({ '/virtual/ns.ts': NAMESPACE }, '/virtual/ns.ts', "neo['useProperty']", false)).toBe(
      'useProperty',
    );
    expect(markerOf({ '/virtual/ns.ts': NAMESPACE }, '/virtual/ns.ts', 'neo.notAMarker', true)).toBe(null);

    expect(markerOf(NAMED_REEXPORT, '/virtual/alias-app.ts', 'token(', false)).toBe('useInterface');
    expect(markerOf(NAMED_REEXPORT, '/virtual/alias-app.ts', 'token(', true)).toBe('useInterface');
    expect(markerOf(NAMED_NAMESPACE, '/virtual/named-ns-app.ts', 'ns.defineBuilderConfig', false)).toBe(
      'defineBuilderConfig',
    );
    expect(markerOf(NAMED_NAMESPACE, '/virtual/named-ns-app.ts', 'ns.useInterface', true)).toBe('useInterface');
  });

  it('P27 star barrel export star as and export default chains', () => {
    const star = {
      '/virtual/star-barrel.ts': `export * from '@djodjonx/neosyringe';\n`,
      '/virtual/star-app.ts': `import { defineBuilderConfig as built } from './star-barrel';\nexport const c = built({});\n`,
    };
    const nestedStar = {
      '/virtual/inner-star.ts': `export * from '@djodjonx/neosyringe';\n`,
      '/virtual/outer-star.ts': `export * from './inner-star';\n`,
      '/virtual/nested-app.ts': `import { useInterface as ui } from './outer-star';\nexport const t = ui();\n`,
    };
    const starNamespace = {
      '/virtual/star-barrel.ts': `export * from '@djodjonx/neosyringe';\n`,
      '/virtual/star-ns-app.ts': `import * as neo from './star-barrel';\nexport const c = neo.defineBuilderConfig({});\nexport const url = neo.useProperty();\n`,
    };
    const starAs = {
      '/virtual/star-as.ts': `export * as neo from '@djodjonx/neosyringe';\n`,
      '/virtual/star-as-app.ts': `import { neo } from './star-as';\nexport const c = neo.defineBuilderConfig({});\n`,
    };
    const nestedStarAs = {
      '/virtual/star-as.ts': `export * as neo from '@djodjonx/neosyringe';\n`,
      '/virtual/nested-ns-app.ts': `import * as ns from './star-as';\nexport const port = ns.neo.useInterface();\n`,
    };
    const exportDefault = {
      '/virtual/defaults.ts': `import { defineBuilderConfig } from '@djodjonx/neosyringe';\nexport default defineBuilderConfig;\n`,
      '/virtual/default-app.ts': `import build from './defaults';\nexport const c = build({});\n`,
    };
    const defaultChain = {
      '/virtual/partial.ts': `import { definePartialConfig as partial } from '@djodjonx/neosyringe';\nexport default partial;\n`,
      '/virtual/forward.ts': `import inner from './partial';\nexport default inner;\n`,
      '/virtual/chain-app.ts': `import build from './forward';\nexport const c = build({});\n`,
    };
    const namedChain = {
      '/virtual/first.ts': `export { defineBuilderConfig as aliased } from '@djodjonx/neosyringe';\n`,
      '/virtual/second.ts': `export { aliased as forwarded } from './first';\n`,
      '/virtual/chain-named-app.ts': `import { forwarded } from './second';\nexport const c = forwarded({});\n`,
    };
    const cycle = {
      '/virtual/cycle-a.ts': `export * from './cycle-b';\n`,
      '/virtual/cycle-b.ts': `export * from './cycle-a';\n`,
      '/virtual/cycle-app.ts': `import { defineBuilderConfig as built } from './cycle-a';\nexport const c = built({});\n`,
    };

    for (const resolvePackage of [false, true]) {
      expect(loadsPackage(star, resolvePackage)).toBe(resolvePackage);
      expect(markerOf(star, '/virtual/star-app.ts', 'built(', resolvePackage)).toBe('defineBuilderConfig');
      expect(markerOf(nestedStar, '/virtual/nested-app.ts', 'ui(', resolvePackage)).toBe('useInterface');
      expect(markerOf(starNamespace, '/virtual/star-ns-app.ts', 'neo.defineBuilderConfig', resolvePackage)).toBe(
        'defineBuilderConfig',
      );
      expect(markerOf(starNamespace, '/virtual/star-ns-app.ts', 'neo.useProperty', resolvePackage)).toBe(
        'useProperty',
      );
      expect(markerOf(starAs, '/virtual/star-as-app.ts', 'neo.defineBuilderConfig', resolvePackage)).toBe(
        'defineBuilderConfig',
      );
      expect(markerOf(nestedStarAs, '/virtual/nested-ns-app.ts', 'ns.neo.useInterface', resolvePackage)).toBe(
        'useInterface',
      );
      expect(markerOf(exportDefault, '/virtual/default-app.ts', 'build(', resolvePackage)).toBe(
        'defineBuilderConfig',
      );
      expect(markerOf(defaultChain, '/virtual/chain-app.ts', 'build(', resolvePackage)).toBe('definePartialConfig');
      expect(markerOf(namedChain, '/virtual/chain-named-app.ts', 'forwarded(', resolvePackage)).toBe(
        'defineBuilderConfig',
      );
      expect(markerOf(cycle, '/virtual/cycle-app.ts', 'built(', resolvePackage)).toBe(null);
    }
  });

  it('P28 homonym shadow and other package are null', () => {
    const homonym = `
function defineBuilderConfig(value: { ok: number }) { return { ok: value.ok }; }
export const local = defineBuilderConfig({ ok: 1 });
`;
    const shadow = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
export function outer(defineBuilderConfig: (value: { shadowed: boolean }) => { shadowed: boolean }) {
  return defineBuilderConfig({ shadowed: true });
}
export function inner() {
  const defineBuilderConfig = (value: { shadowed: boolean }) => ({ shadowed: value.shadowed });
  return defineBuilderConfig({ shadowed: true });
}
`;
    const hides = {
      '/virtual/hides.ts': `
export function defineBuilderConfig(value: { ok: number }) { return { ok: value.ok }; }
export class useInterface { id = 1; }
export const useProperty = (value: { ok: number }) => ({ ok: value.ok });
export * from '@djodjonx/neosyringe';
`,
      '/virtual/hides-app.ts': `
import { defineBuilderConfig as built, useInterface as Iface, useProperty as prop } from './hides';
export const a = built({ ok: 1 });
export const b = Iface();
export const c = prop({ ok: 2 });
`,
    };
    const otherImport = `
import { defineBuilderConfig } from 'other-pkg';
export const built = defineBuilderConfig({ ok: 1 });
`;
    const otherStar = {
      '/virtual/other-barrel.ts': `export * from 'other-pkg';\n`,
      '/virtual/other-star-app.ts': `import { defineBuilderConfig as built } from './other-barrel';\nexport const c = built({ ok: 1 });\n`,
    };
    const otherNamespace = `
import * as box from 'other-pkg';
export const built = box.defineBuilderConfig({ ok: 3 });
`;
    const otherNamed = {
      '/virtual/other-named.ts': `export { defineBuilderConfig } from 'other-pkg';\n`,
      '/virtual/other-named-app.ts': `import * as ns from './other-named';\nexport const built = ns.defineBuilderConfig({ ok: 4 });\n`,
    };

    expect(markerOf({ '/virtual/homonym.ts': homonym }, '/virtual/homonym.ts', 'defineBuilderConfig(', false)).toBe(
      null,
    );
    const shadowed = compile({ '/virtual/shadow.ts': shadow }, false);
    const shadowFile = shadowed.source('/virtual/shadow.ts');
    const shadowCalls = shadowFile.statements.flatMap((statement) => {
      const found: ts.CallExpression[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) found.push(node);
        ts.forEachChild(node, visit);
      };
      visit(statement);
      return found;
    });
    expect(shadowCalls.map((call) => resolveNeoMarker(shadowed.checker, call))).toEqual([null, null]);

    expect(markerOf(hides, '/virtual/hides-app.ts', 'built(', true)).toBe(null);
    expect(markerOf(hides, '/virtual/hides-app.ts', 'Iface(', true)).toBe(null);
    expect(markerOf(hides, '/virtual/hides-app.ts', 'prop(', true)).toBe(null);
    expect(markerOf({ '/virtual/other.ts': otherImport }, '/virtual/other.ts', 'defineBuilderConfig(', false)).toBe(
      null,
    );
    expect(markerOf(otherStar, '/virtual/other-star-app.ts', 'built(', false)).toBe(null);
    expect(markerOf({ '/virtual/other-ns.ts': otherNamespace }, '/virtual/other-ns.ts', 'box.defineBuilderConfig', false)).toBe(
      null,
    );
    expect(markerOf(otherNamed, '/virtual/other-named-app.ts', 'ns.defineBuilderConfig', false)).toBe(null);

    const plain = compile({
      '/virtual/plain.ts': `export const n = Math.max(1, 2);\n`,
    }, false);
    const plainFile = plain.source('/virtual/plain.ts');
    expect(resolveNeoMarker(plain.checker, plainFile)).toBe(null);
  });

  it('P29 unsupported computed access reports NEO_CONFIG_UNSUPPORTED', () => {
    const entry = '/virtual/computed.ts';
    const sourceText = [
      "import * as neo from '@djodjonx/neosyringe';",
      "const key: string = 'defineBuilderConfig';",
      'export const c = neo[key]({ injections: [] });',
      '',
    ].join('\n');
    const { checker, source } = compile({ [entry]: sourceText }, true);
    const sourceFile = source(entry);
    const call = callIncluding(sourceFile, 'neo[key]');
    const column = sourceText.split('\n')[2].indexOf('neo[key]') + 1;

    expect(resolveNeoMarker(checker, call)).toEqual({ code: 'NEO_CONFIG_UNSUPPORTED' });
    expect(formatUnsupportedMarker(call)).toBe(
      `NEO_CONFIG_UNSUPPORTED: non-analysable config form at /virtual/computed.ts:3:${column}. ` +
        'Supported alternative: a direct call, an import alias, or a property access such as neo.defineBuilderConfig({ ... }).',
    );

    const foreign = `
import * as box from 'other-pkg';
const key: string = 'defineBuilderConfig';
export const built = box[key]({ ok: 1 });
`;
    expect(markerOf({ '/virtual/foreign-computed.ts': foreign }, '/virtual/foreign-computed.ts', 'box[key]', false)).toBe(
      null,
    );

    const literal = `
import * as neo from '@djodjonx/neosyringe';
export const c = neo['defineBuilderConfig']({});
export const missing = neo['notAMarker']();
`;
    expect(markerOf({ '/virtual/literal.ts': literal }, '/virtual/literal.ts', "neo['defineBuilderConfig']", false)).toBe(
      'defineBuilderConfig',
    );
    expect(markerOf({ '/virtual/literal.ts': literal }, '/virtual/literal.ts', "neo['notAMarker']", true)).toBe(null);
  });

  it('W5 sourceFileUsesMarker', () => {
    const withMarker = compile({
      '/virtual/with-marker.ts': `
import { useProperty as prop } from '@djodjonx/neosyringe';
export class Api { url = ''; }
export const first = prop<string>(Api, 'url');
export const second = prop<string>(Api, 'url');
`,
    }, false);
    expect(sourceFileUsesMarker(withMarker.checker, withMarker.source('/virtual/with-marker.ts'))).toBe(true);

    const importedOnly = compile({
      '/virtual/imported-only.ts': `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
export const label = 'defineBuilderConfig';
void defineBuilderConfig;
`,
    }, true);
    expect(sourceFileUsesMarker(importedOnly.checker, importedOnly.source('/virtual/imported-only.ts'))).toBe(false);

    const homonym = compile({
      '/virtual/homonym-file.ts': `
function defineBuilderConfig(value: { ok: number }) { return value; }
export const local = defineBuilderConfig({ ok: 1 });
`,
    }, false);
    expect(sourceFileUsesMarker(homonym.checker, homonym.source('/virtual/homonym-file.ts'))).toBe(false);
  });
});
