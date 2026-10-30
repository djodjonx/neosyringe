import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { callsCanReachNeoSyringe, hasNeoSyringeMarkers } from '../src/markerUtils';
import { neoSyringePlugin } from '../src/index';

vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typescript')>();
  return {
    ...actual,
    findConfigFile: vi.fn(),
  };
});

describe('hasNeoSyringeMarkers', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns true when code contains defineBuilderConfig', () => {
    expect(hasNeoSyringeMarkers("const c = defineBuilderConfig({})")).toBe(true);
  });

  it('returns true when code contains useInterface', () => {
    expect(hasNeoSyringeMarkers("const t = useInterface<ILogger>()")).toBe(true);
  });

  it('returns false when code contains neither marker', () => {
    expect(hasNeoSyringeMarkers("const x = 42;")).toBe(false);
  });

  it('returns true when code contains both markers', () => {
    const code = "const t = useInterface<ILogger>(); const c = defineBuilderConfig({})";
    expect(hasNeoSyringeMarkers(code)).toBe(true);
  });

  it('T01-P6-filtre', () => {
    vi.mocked(ts.findConfigFile).mockReturnValue(undefined);
    expect(hasNeoSyringeMarkers("import { builder } from './b';\n")).toBe(true);
    expect(hasNeoSyringeMarkers("const URL = useProperty<string>(Api, 'url');\n")).toBe(true);

    const plugin = neoSyringePlugin.vite();
    // @ts-expect-error unplugin hook is callable in tests
    const transform = plugin.transform as (code: string, id: string) => string | undefined;
    // Unresolved alias: not a proven marker, so a missing tsconfig is not an error.
    expect(transform("import { builder } from './b';\nexport const c = builder({});\n", 'alias.ts')).toBeUndefined();
    // Reachable marker: still an error when tsconfig is missing.
    expect(() =>
      transform(
        "import { defineBuilderConfig as b } from '@djodjonx/neosyringe';\nexport const c = b({});\n",
        'marker.ts',
      ),
    ).toThrow(/Could not find tsconfig/);
    expect(() => transform("import { read } from 'node:fs';\nexport const n = read();\n", 'plain.ts')).not.toThrow();
    expect(() => transform("const URL = useProperty<string>(Api, 'url');\n", 'prop.ts')).toThrow(
      /Could not find tsconfig/,
    );

    const dir = mkdtempSync(path.join(tmpdir(), 't01-p6-barrel-'));
    dirs.push(dir);
    writeFileSync(
      path.join(dir, 'barrel.ts'),
      `export { defineBuilderConfig } from '@djodjonx/neosyringe';\n`,
    );
    expect(() =>
      transform(
        `import * as ns from './barrel';\nexport const c = ns.defineBuilderConfig({});\n`,
        path.join(dir, 'ns-consumer.ts'),
      ),
    ).toThrow(/Could not find tsconfig/);
    expect(() =>
      transform(
        `import { defineBuilderConfig as b } from './barrel';\nexport const c = b({});\n`,
        path.join(dir, 'alias-consumer.ts'),
      ),
    ).toThrow(/Could not find tsconfig/);
  });

  it('T01-P16-tier1', () => {
    expect(hasNeoSyringeMarkers('function local(n: number) { return n; }\nlocal(1);\nMath.max(1, 2);\n')).toBe(false);
    expect(hasNeoSyringeMarkers("import type { Something } from './something';\nMath.max(1, 2);\n")).toBe(false);
    expect(
      hasNeoSyringeMarkers("import { defineBuilderConfig as b } from '@djodjonx/neosyringe';\nexport const c = b({});\n"),
    ).toBe(true);
    expect(
      hasNeoSyringeMarkers("import * as neo from '@djodjonx/neosyringe';\nexport const c = neo.defineBuilderConfig({});\n"),
    ).toBe(true);
    expect(hasNeoSyringeMarkers("import { builder } from './barrel';\nexport const c = builder({});\n")).toBe(true);
    expect(
      hasNeoSyringeMarkers("import neo = require('@djodjonx/neosyringe');\nexport const c = neo.defineBuilderConfig({});\n"),
    ).toBe(true);
  });

  it('T01-P7-commentaire', () => {
    const code = "// defineBuilderConfig\nconst label = \"useInterface\";\nconst quiet = 1;\n";
    expect(hasNeoSyringeMarkers(code)).toBe(false);

    const plugin = neoSyringePlugin.vite();
    // @ts-expect-error unplugin hook is callable in tests
    const transform = plugin.transform as (code: string, id: string) => string | undefined;
    const output = transform(code, 'comment.ts');
    expect(output === undefined || output === code).toBe(true);
  });

  it('T01-P21-tier1-namespace-barrel', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-tier1-'));
    dirs.push(dir);
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2020,
    };
    writeFileSync(
      path.join(dir, 'named-barrel.ts'),
      `export { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';\n`,
    );
    writeFileSync(path.join(dir, 'star-as-barrel.ts'), `export * as neo from '@djodjonx/neosyringe';\n`);
    writeFileSync(path.join(dir, 'inner.ts'), `export { defineBuilderConfig } from '@djodjonx/neosyringe';\n`);
    writeFileSync(path.join(dir, 'star-named-barrel.ts'), `export * from './inner';\n`);
    writeFileSync(
      path.join(dir, 'local-barrel.ts'),
      `export function defineBuilderConfig(value: { ok: number }) { return value; }\n`,
    );
    writeFileSync(
      path.join(dir, 'foreign.ts'),
      `export function defineBuilderConfig(value: { ok: number }) { return value; }\n`,
    );
    writeFileSync(path.join(dir, 'foreign-barrel.ts'), `export { defineBuilderConfig } from './foreign';\n`);
    writeFileSync(path.join(dir, 'other-pkg-barrel.ts'), `export { defineBuilderConfig } from 'other-pkg';\n`);

    const reach = (file: string, code: string): boolean => callsCanReachNeoSyringe(code, path.join(dir, file), options);

    expect(
      reach(
        'named-consumer.ts',
        `import * as ns from './named-barrel';\nexport const c = ns.defineBuilderConfig({});\nexport const t = ns.useInterface<{}>();\n`,
      ),
    ).toBe(true);
    expect(
      reach(
        'star-as-consumer.ts',
        `import * as ns from './star-as-barrel';\nexport const c = ns.neo.defineBuilderConfig({});\n`,
      ),
    ).toBe(true);
    expect(
      reach(
        'star-named-consumer.ts',
        `import * as ns from './star-named-barrel';\nexport const c = ns.defineBuilderConfig({});\n`,
      ),
    ).toBe(true);
    expect(
      reach(
        'require-consumer.ts',
        `import x = require('./named-barrel');\nexport const c = x.defineBuilderConfig({});\n`,
      ),
    ).toBe(true);
    writeFileSync(
      path.join(dir, 'expdef.ts'),
      `import { defineBuilderConfig } from '@djodjonx/neosyringe';\nexport default defineBuilderConfig;\n`,
    );
    expect(reach('expdef-consumer.ts', `import d from './expdef';\nexport const c = d({});\n`)).toBe(true);
    expect(
      reach('expdef-ns-consumer.ts', `import * as q from './expdef';\nexport const c = q.default({});\n`),
    ).toBe(true);
    expect(
      reach(
        'local-consumer.ts',
        `import * as ns from './local-barrel';\nexport const c = ns.defineBuilderConfig({ ok: 1 });\n`,
      ),
    ).toBe(false);
    expect(
      reach(
        'foreign-consumer.ts',
        `import * as ns from './foreign-barrel';\nexport const c = ns.defineBuilderConfig({ ok: 1 });\n`,
      ),
    ).toBe(false);
    expect(
      reach(
        'other-pkg-consumer.ts',
        `import * as ns from './other-pkg-barrel';\nexport const c = ns.defineBuilderConfig({ ok: 1 });\n`,
      ),
    ).toBe(false);
  });

  it('T01-P25-tier1-export-default', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't01-tier1-expdef-'));
    dirs.push(dir);
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2020,
    };
    writeFileSync(
      path.join(dir, 'expdef.ts'),
      `import { defineBuilderConfig } from '@djodjonx/neosyringe';\nexport default defineBuilderConfig;\n`,
    );
    writeFileSync(
      path.join(dir, 'aliasdef.ts'),
      `import { defineBuilderConfig as z } from '@djodjonx/neosyringe';\nexport default z;\n`,
    );
    writeFileSync(path.join(dir, 'chain.ts'), `import d from './expdef';\nexport default d;\n`);
    writeFileSync(
      path.join(dir, 'localdef.ts'),
      `export default function defineBuilderConfig(value: { ok: number }) {\n  return value;\n}\n`,
    );
    writeFileSync(
      path.join(dir, 'otherdef.ts'),
      `import { defineBuilderConfig } from 'other-pkg';\nexport default defineBuilderConfig;\n`,
    );
    writeFileSync(
      path.join(dir, 'eqdef.ts'),
      `import { defineBuilderConfig } from '@djodjonx/neosyringe';\nexport = defineBuilderConfig;\n`,
    );

    const reach = (file: string, code: string): boolean => callsCanReachNeoSyringe(code, path.join(dir, file), options);

    expect(reach('direct.ts', `import d from './expdef';\nexport const c = d({});\n`)).toBe(true);
    expect(reach('alias.ts', `import d from './aliasdef';\nexport const c = d({});\n`)).toBe(true);
    expect(reach('chain-consumer.ts', `import d from './chain';\nexport const c = d({});\n`)).toBe(true);
    expect(reach('ns.ts', `import * as q from './expdef';\nexport const c = q.default({});\n`)).toBe(true);
    expect(reach('local.ts', `import d from './localdef';\nexport const c = d({ ok: 1 });\n`)).toBe(false);
    expect(reach('other.ts', `import d from './otherdef';\nexport const c = d({ ok: 1 });\n`)).toBe(false);
    expect(reach('eq.ts', `import d = require('./eqdef');\nexport const c = d({ ok: 1 });\n`)).toBe(false);
  });
});
