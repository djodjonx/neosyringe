import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));

import * as esbuild from 'esbuild';
import { rollup } from 'rollup';
import * as ts from 'typescript';
import type { ProgramTransformerExtras } from 'ts-patch';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { neoSyringePlugin } from '../src/index';
import neoSyringeTransformer from '../src/transformer';

/**
 * T23 B5 step 6, inline layout. The generated code is written into the user's file, so every identifier
 * it uses must be bound there: the local name of a renamed import, a class the container only gets from
 * a partial of another file, a default export, a namespace member. Each case is checked twice, through the
 * real plugin (the bundle runs and resolves the instance) and through the ts-patch transformer (a strict
 * Program over the transformed text has no diagnostic).
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const extras: ProgramTransformerExtras = { ts };

const dirs: string[] = [];
let cwdToRestore: string | undefined;

afterEach(() => {
  if (cwdToRestore !== undefined) {
    process.chdir(cwdToRestore);
    cwdToRestore = undefined;
  }
  TSContext.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Workspace { dir: string; project: string }

/** A strict project on disk. The directory is a real path, so the program and the plugin spell it alike. */
function workspace(files: Record<string, string>): Workspace {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 't23-bindings-')));
  dirs.push(dir);
  if (cwdToRestore === undefined) cwdToRestore = process.cwd();
  process.chdir(dir);
  const project = path.join(dir, 'tsconfig.json');
  writeFileSync(project, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      lib: ['ES2022'],
      types: [],
      baseUrl: REPO,
      paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
    },
  }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return { dir, project };
}

function exists(file: string): boolean {
  return ts.sys.fileExists(file);
}

/** Bundles `app.ts` through the real rollup plugin, runs the bundle and returns what `app.ts` exports. */
async function run(files: Record<string, string>): Promise<Record<string, unknown>> {
  const space = workspace(files);
  const runtime = path.join(REPO, 'packages/neosyringe/dist/index.mjs');
  const build = await rollup({
    input: path.join(space.dir, 'app.ts'),
    plugins: [
      {
        name: 'resolve-neo',
        resolveId(sourceId, importer) {
          if (sourceId === '@djodjonx/neosyringe') return runtime;
          if (!importer || !sourceId.startsWith('./')) return null;
          const sibling = path.resolve(path.dirname(importer), `${sourceId}.ts`);
          return exists(sibling) ? sibling : null;
        },
      },
      neoSyringePlugin.rollup({ project: space.project, debug: false }),
      {
        name: 'strip-ts',
        async transform(sourceText, id) {
          if (!id.endsWith('.ts')) return null;
          const transformed = await esbuild.transform(sourceText, {
            loader: 'ts', target: 'es2022', format: 'esm', sourcemap: true, sourcefile: id,
          });
          return { code: transformed.code, map: transformed.map };
        },
      },
    ],
    onwarn() {},
  });
  let code = '';
  try {
    const generated = await build.generate({ format: 'esm' });
    const chunk = generated.output.find((item) => item.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('chunk absent');
    code = chunk.code;
  } finally {
    await build.close();
  }
  const bundle = path.join(space.dir, 'bundle.mjs');
  writeFileSync(bundle, code);
  const loaded: Record<string, unknown> = await import(pathToFileURL(bundle).href);
  return loaded;
}

type Hooks = { transform: (code: string, id: string) => unknown };

function hasTransform(plugin: object): plugin is Hooks {
  return 'transform' in plugin && typeof plugin.transform === 'function';
}

/** What the real plugin writes for `app.ts`. */
function transformedApp(files: Record<string, string>): string {
  const space = workspace(files);
  const plugin = neoSyringePlugin.vite({ project: space.project, debug: false });
  if (Array.isArray(plugin) || !hasTransform(plugin)) throw new Error('hook transform attendu');
  const result = plugin.transform(files['app.ts'] ?? '', path.join(space.dir, 'app.ts'));
  if (typeof result !== 'object' || result === null || !('code' in result) || typeof result.code !== 'string') {
    throw new Error("le plugin n'a rien transformé");
  }
  return result.code;
}

/** `TS2304 app.ts:12:9 message`, one line per diagnostic of the user's files in the transformed program. */
function diagnosticsOf(files: Record<string, string>): string[] {
  const space = workspace(files);
  const config = ts.readConfigFile(space.project, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, space.dir, undefined, space.project);
  const program = ts.createProgram([path.join(space.dir, 'app.ts')], parsed.options);
  const transformed = neoSyringeTransformer(program, undefined, {}, extras);
  const found: string[] = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(transformed)) {
    const file = diagnostic.file;
    if (!file || file.fileName.includes('node_modules') || !file.fileName.startsWith(space.dir)) continue;
    const position = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    found.push(`TS${diagnostic.code} ${path.basename(file.fileName)}:${position.line + 1}:${position.character + 1} ${message}`);
  }
  return found;
}

const NEO = "import { defineBuilderConfig } from '@djodjonx/neosyringe';";

const RENAMED: Record<string, string> = {
  'dep.ts': "export class Logger { readonly label = 'dep logger'; }\n",
  'app.ts': `${NEO}
import { Logger as Renamed } from './dep';

export class Service { constructor(readonly logger: Renamed) {} }

export const container = defineBuilderConfig({
  name: 'RenamedImport',
  injections: [{ token: Renamed }, { token: Service }],
});

export const label: string = container.resolve<Service>(Service).logger.label;
`,
};

/** The provider (not the token) is the renamed import: its local binding comes from the provider expression. */
const RENAMED_PROVIDER: Record<string, string> = {
  'dep.ts': "export class Logger { readonly label = 'dep provider'; }\n",
  'app.ts': `${NEO}
import { Logger as Renamed } from './dep';

export class Output { readonly label: string = 'token'; }
export class Service { constructor(readonly output: Output) {} }

export const container = defineBuilderConfig({
  name: 'RenamedProvider',
  injections: [{ token: Output, provider: Renamed }, { token: Service }],
});

export const label: string = container.resolve<Service>(Service).output.label;
`,
};

describe('T23-G2 a renamed import keeps its local binding', () => {
  it('T23-G2 the bundle runs and resolves the class under the name the file imports it with', async () => {
    const exported = await run(RENAMED);
    expect(exported.label).toBe('dep logger');
  });

  it('T23-G2 the transformed program has no unbound name', () => {
    expect(diagnosticsOf(RENAMED)).toEqual([]);
  });

  it('T23-G2 the container class reads the class by the local binding of the import, with no extra import', () => {
    const code = transformedApp(RENAMED);
    expect(code).toContain('return new Renamed();');
    // One registration is the linear case of the dispatcher (packages/core/src/generator/dispatchEmitter.ts:37, DISPATCH_LINEAR_MAX).
    // It keys the class by the local binding, `Renamed`, not by the exported name `Logger`.
    expect(code).toMatch(/if \(token === Renamed\) return this\._get_Logger_[a-f0-9]+\(\);/);
    expect(code).toContain('this.instances.has(Renamed)');
    expect(code).not.toMatch(/new Logger\(/);
    expect(code).not.toContain('__neo_Import_');
  });

  it('T23-G2 a provider imported under another name: the bundle runs and the program has no unbound name', async () => {
    expect(diagnosticsOf(RENAMED_PROVIDER)).toEqual([]);
    const exported = await run(RENAMED_PROVIDER);
    expect(exported.label).toBe('dep provider');
  });

  it('T23-G2 a provider imported under another name: the container class builds it by the local binding', () => {
    const code = transformedApp(RENAMED_PROVIDER);
    expect(code).toContain('return new Renamed();');
    expect(code).not.toMatch(/new Logger\(/);
    expect(code).not.toContain('__neo_Import_');
  });
});

/** The consumer of a partial's class, written in the container's file: it imports the class as a type only. */
function consumerOf(importLine: string, typeName: string, partialName: string): string {
  return `${NEO}
import { part } from './part';
${importLine}

export class Consumer { constructor(readonly remote: ${typeName}) {} }

export const container = defineBuilderConfig({
  name: '${partialName}',
  extends: [part],
  injections: [{ token: Consumer }],
});

export const greeting: string = container.resolve<Consumer>(Consumer).remote.greet();
`;
}

/** A partial of another file registers a class provider under a class token the container's own file imports as a type only. */
const PARTIAL_PROVIDER: Record<string, string> = {
  'base.ts': "export class Base { greet(): string { return 'base'; } }\n",
  'part.ts': `import { definePartialConfig } from '@djodjonx/neosyringe';
import { Base } from './base';
export class Remote extends Base { greet(): string { return 'from the partial'; } }
export const part = definePartialConfig({
  injections: [{ token: Base, provider: Remote }],
});
`,
  'app.ts': consumerOf("import type { Base } from './base';", 'Base', 'PartialProvider'),
};

const PARTIAL_CLASS_TOKEN: Record<string, string> = {
  'part.ts': `import { definePartialConfig } from '@djodjonx/neosyringe';
export class Remote { greet(): string { return 'from the partial'; } }
export const part = definePartialConfig({
  injections: [{ token: Remote }],
});
`,
  'app.ts': consumerOf("import type { Remote } from './part';", 'Remote', 'PartialClass'),
};

const PARTIAL_DEFAULT: Record<string, string> = {
  'remote.ts': "export default class Remote { greet(): string { return 'from the default export'; } }\n",
  'part.ts': `import { definePartialConfig } from '@djodjonx/neosyringe';
import Remote from './remote';
export const part = definePartialConfig({
  injections: [{ token: Remote }],
});
`,
  'app.ts': consumerOf("import type Remote from './remote';", 'Remote', 'PartialDefault'),
};

/** The partial reaches its class through a namespace import: `deps.Remote` is not a name the partial binds. */
const PARTIAL_NAMESPACE: Record<string, string> = {
  'base.ts': "export class Base { greet(): string { return 'base'; } }\n",
  'deps.ts': `import { Base } from './base';
export class Remote extends Base { greet(): string { return 'from the namespace'; } }
`,
  'part.ts': `import { definePartialConfig } from '@djodjonx/neosyringe';
import { Base } from './base';
import * as deps from './deps';
export const part = definePartialConfig({
  injections: [{ token: Base, provider: deps.Remote }],
});
`,
  'app.ts': consumerOf("import type { Base } from './base';", 'Base', 'PartialNamespace'),
};

/** The container's own file reaches the provider through a namespace import. */
const OWN_NAMESPACE: Record<string, string> = {
  'deps.ts': "export class Stamp { value(): string { return 'from the own namespace'; } }\n",
  'app.ts': `import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import * as deps from './deps';

export interface IStamp { value(): string }
const stamp = useInterface<IStamp>();

export class Consumer { constructor(readonly stamp: IStamp) {} }

export const container = defineBuilderConfig({
  name: 'OwnNamespace',
  injections: [{ token: stamp, provider: deps.Stamp }, { token: Consumer }],
});

export const greeting: string = container.resolve<Consumer>(Consumer).stamp.value();
`,
};

/**
 * The partial's factory is copied into the container's file, so the names its text reads must be bound there:
 * a class its file declares and exports, a class its file imports, a namespace its file imports.
 */
const PARTIAL_FACTORY_OWN: Record<string, string> = {
  'part.ts': `import { definePartialConfig } from '@djodjonx/neosyringe';
export class Remote { constructor(readonly note: string) {} greet(): string { return this.note; } }
export const part = definePartialConfig({
  injections: [{ token: Remote, useFactory: true, dependencies: [], provider: () => new Remote('from the partial factory') }],
});
`,
  'app.ts': consumerOf("import type { Remote } from './part';", 'Remote', 'PartialFactoryOwn'),
};

const PARTIAL_FACTORY_IMPORTED: Record<string, string> = {
  'remote.ts': 'export class Remote { constructor(readonly note: string) {} greet(): string { return this.note; } }\n',
  'part.ts': `import { definePartialConfig } from '@djodjonx/neosyringe';
import { Remote as Built } from './remote';
export const part = definePartialConfig({
  injections: [{ token: Built, useFactory: true, dependencies: [], provider: () => new Built('from the imported class') }],
});
`,
  'app.ts': consumerOf("import type { Remote } from './remote';", 'Remote', 'PartialFactoryImported'),
};

const PARTIAL_FACTORY_NAMESPACE: Record<string, string> = {
  'base.ts': "export class Base { greet(): string { return 'base'; } }\n",
  'deps.ts': `import { Base } from './base';
export class Remote extends Base { constructor(readonly note: string) { super(); } greet(): string { return this.note; } }
`,
  'part.ts': `import { definePartialConfig } from '@djodjonx/neosyringe';
import { Base } from './base';
import * as deps from './deps';
export const part = definePartialConfig({
  injections: [{ token: Base, useFactory: true, dependencies: [], provider: () => new deps.Remote('from the namespace factory') }],
});
`,
  'app.ts': consumerOf("import type { Base } from './base';", 'Base', 'PartialFactoryNamespace'),
};

/** An object shorthand reads a name and writes the key: `{ Remote }` is `{ Remote: ns.Remote }`, not `{ ns.Remote }`. */
const PARTIAL_FACTORY_SHORTHAND: Record<string, string> = {
  'part.ts': `import { definePartialConfig } from '@djodjonx/neosyringe';
export class Remote { constructor(readonly note: string) {} greet(): string { return this.note; } }
export const part = definePartialConfig({
  injections: [{
    token: Remote,
    useFactory: true,
    dependencies: [],
    provider: () => { const bag = { Remote }; return new bag.Remote('from the shorthand'); },
  }],
});
`,
  'app.ts': consumerOf("import type { Remote } from './part';", 'Remote', 'PartialFactoryShorthand'),
};

const VARIANTS: ReadonlyArray<{ name: string; files: Record<string, string>; expected: string }> = [
  { name: 'a class provider of a partial, under a class token the file imports as a type', files: PARTIAL_PROVIDER, expected: 'from the partial' },
  { name: 'a class token of a partial, imported as a type only', files: PARTIAL_CLASS_TOKEN, expected: 'from the partial' },
  { name: 'a default export registered by a partial', files: PARTIAL_DEFAULT, expected: 'from the default export' },
  { name: 'a provider a partial reaches through a namespace import', files: PARTIAL_NAMESPACE, expected: 'from the namespace' },
  { name: 'a provider the container file reaches through a namespace import', files: OWN_NAMESPACE, expected: 'from the own namespace' },
  { name: 'a factory of a partial that builds a class its own file declares', files: PARTIAL_FACTORY_OWN, expected: 'from the partial factory' },
  { name: 'a factory of a partial that builds a class its file imports under another name', files: PARTIAL_FACTORY_IMPORTED, expected: 'from the imported class' },
  { name: 'a factory of a partial that builds a class through a namespace import', files: PARTIAL_FACTORY_NAMESPACE, expected: 'from the namespace factory' },
  { name: 'a factory of a partial that reads a class through an object shorthand', files: PARTIAL_FACTORY_SHORTHAND, expected: 'from the shorthand' },
];

describe('T23-G3 every identifier the output uses is bound in the file it is written into', () => {
  // `%s`, not `$name`: vitest cuts an interpolated `$name` at 40 characters, so a `-t` filter could not pick one variant.
  const titled = VARIANTS.map((variant) => [variant.name, variant] as const);

  it.each(titled)('T23-G3 the bundle runs and resolves: %s', async (_name, { files, expected }) => {
    const exported = await run(files);
    expect(exported.greeting).toBe(expected);
  });

  it.each(titled)('T23-G3 the transformed program has no unbound name: %s', (_name, { files }) => {
    expect(diagnosticsOf(files)).toEqual([]);
  });
});

/** A closed container reads its dependencies through typed accessors: the types they name are bound in the file. */
const TYPED_INLINE: Record<string, string> = {
  'shapes.ts': 'export interface IShape { readonly sides: number }\n',
  'app.ts': `import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import type { IShape } from './shapes';

interface IHidden { readonly label: string }
const shape = useInterface<IShape>();
const hidden = useInterface<IHidden>();

export class Drawing { constructor(readonly shape: IShape, readonly hidden: IHidden) {} }

export const container = defineBuilderConfig({
  name: 'TypedInline',
  optimization: { mode: 'closed', roots: [Drawing] },
  injections: [
    { token: shape, useFactory: true, dependencies: [], provider: () => ({ sides: 4 }) },
    { token: hidden, useFactory: true, dependencies: [], provider: () => ({ label: 'square' }) },
    { token: Drawing },
  ],
});

export const description: string = (() => {
  const drawing = container.resolve<Drawing>(Drawing);
  return drawing.hidden.label + ' ' + String(drawing.shape.sides);
})();
`,
};

describe('T23-P8 typed getters in the inline layout', () => {
  it('T23-P8 a type of another file is named through `import type`, a type of the file by its own name', () => {
    const code = transformedApp(TYPED_INLINE);
    expect(code).toContain("import type { IShape as __neo_Type_IShape } from './shapes';");
    expect(code).toMatch(/private _direct_IShape_\w+\(\): __neo_Type_IShape \{/);
    expect(code).toMatch(/private _direct_IHidden_\w+\(\): IHidden \{/);
  });

  it('T23-P8 the transformed program has no diagnostic and the bundle runs', async () => {
    expect(diagnosticsOf(TYPED_INLINE)).toEqual([]);
    const exported = await run(TYPED_INLINE);
    expect(exported.description).toBe('square 4');
  });
});

/** The type of a wrong provider is reported in the inline layout too (a closed container reads its dependencies directly). */
describe('T23-P8 inline layout', () => {
  it('T23-P8 a class token registered with a provider of another type is reported in the transformed program', () => {
    const files: Record<string, string> = {
      'app.ts': `${NEO}
export class Leaf { n = 1; }
export class Stranger { label = 'stranger'; }
export class Wants { constructor(readonly leaf: Leaf) {} }

export const container = defineBuilderConfig({
  name: 'WrongProvider',
  optimization: { mode: 'closed', roots: [Wants] },
  injections: [{ token: Leaf, provider: Stranger }, { token: Wants }],
});
`,
    };
    const found = diagnosticsOf(files).filter((line) => line.startsWith('TS2345 app.ts'));
    expect(found.length).toBe(1);
    expect(found[0]).toContain('Stranger');
    expect(found[0]).toContain('Leaf');
  });
});

/**
 * A class token whose constructor is not public (the usual singleton) is registered with a factory: nothing
 * calls `new` on it, so the program is valid, and the typed accessors must not need a public constructor.
 */
const PRIVATE_SINGLETON_APP = `${NEO}
export class Clock { private constructor(readonly tick: number) {} static make(): Clock { return new Clock(7); } }
export class Reader { constructor(readonly clock: Clock) {} }

export const container = defineBuilderConfig({
  name: 'PrivateSingleton',
  optimization: { mode: 'closed', roots: [Reader] },
  injections: [
    { token: Clock, useFactory: true, dependencies: [], provider: () => Clock.make() },
    { token: Reader },
  ],
});

export const tick: number = container.resolve<Reader>(Reader).clock.tick;
`;

const PRIVATE_SINGLETON_DEFAULT: Record<string, string> = {
  'clock.ts': 'export default class Clock { private constructor(readonly tick: number) {} static make(): Clock { return new Clock(9); } }\n',
  'app.ts': `${NEO}
import Clock from './clock';

export class Reader { constructor(readonly clock: Clock) {} }

export const container = defineBuilderConfig({
  name: 'PrivateDefault',
  optimization: { mode: 'closed', roots: [Reader] },
  injections: [
    { token: Clock, useFactory: true, dependencies: [], provider: () => Clock.make() },
    { token: Reader },
  ],
});

export const tick: number = container.resolve<Reader>(Reader).clock.tick;
`,
};

const PRIVATE_VARIANTS: ReadonlyArray<readonly [string, Record<string, string>, number]> = [
  ['a class declared in the container file', { 'app.ts': PRIVATE_SINGLETON_APP }, 7],
  ['a default export imported by the container file', PRIVATE_SINGLETON_DEFAULT, 9],
];

describe('T23-P8 a class token with a private constructor, registered with a factory', () => {
  it.each(PRIVATE_VARIANTS)('T23-P8 the transformed program has no diagnostic: %s', (_name, files) => {
    expect(diagnosticsOf(files)).toEqual([]);
  });

  it.each(PRIVATE_VARIANTS)('T23-P8 the bundle runs and resolves the factory result: %s', async (_name, files, expected) => {
    const exported = await run(files);
    expect(exported.tick).toBe(expected);
  });
});

/** A token that is a value alias of a class (`const Alias = Clock`): a value, never a type, so the getters do not name it as one. */
const ALIAS_FACTORY: Record<string, string> = {
  'app.ts': `${NEO}
export class Clock { constructor(readonly tick: number) {} }
const Alias = Clock;

export class Reader { constructor(readonly clock: Clock) {} }

export const container = defineBuilderConfig({
  name: 'AliasFactory',
  optimization: { mode: 'closed', roots: [Reader] },
  injections: [
    { token: Alias, useFactory: true, dependencies: [], provider: () => new Clock(11) },
    { token: Reader },
  ],
});

export const tick: number = container.resolve<Reader>(Reader).clock.tick;
`,
};

const ALIAS_PROVIDER: Record<string, string> = {
  'app.ts': `${NEO}
export class Clock { readonly tick = 12; }
const Alias = Clock;

export class Reader { constructor(readonly clock: Clock) {} }

export const container = defineBuilderConfig({
  name: 'AliasProvider',
  optimization: { mode: 'closed', roots: [Reader] },
  injections: [
    { token: Alias },
    { token: Reader },
  ],
});

export const tick: number = container.resolve<Reader>(Reader).clock.tick;
`,
};

const ALIAS_VARIANTS: ReadonlyArray<readonly [string, Record<string, string>, number]> = [
  ['a factory registered under the alias', ALIAS_FACTORY, 11],
  ['a class provider registered under the alias', ALIAS_PROVIDER, 12],
];

describe('T23-P8 a token that is a local value alias of a class', () => {
  it.each(ALIAS_VARIANTS)('T23-P8 the transformed program has no diagnostic: %s', (_name, files) => {
    expect(diagnosticsOf(files)).toEqual([]);
  });

  it.each(ALIAS_VARIANTS)('T23-P8 the bundle runs and resolves the class: %s', async (_name, files, expected) => {
    const exported = await run(files);
    expect(exported.tick).toBe(expected);
  });
});

/** A hoisted useValue is read under its declared type: its literals keep the union the interface asks for. */
const LITERAL_VALUE: Record<string, string> = {
  'app.ts': `import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export interface IKind { kind: 'a' | 'b' }
const kind = useInterface<IKind>();

export class Reads { constructor(readonly k: IKind) {} }

export const container = defineBuilderConfig({
  name: 'LiteralValue',
  optimization: { mode: 'closed', roots: [Reads] },
  injections: [
    { token: kind, useValue: { kind: 'a' } },
    { token: Reads },
  ],
});

export const kindRead: string = container.resolve<Reads>(Reads).k.kind;
`,
};

describe('T23-P8 a hoisted useValue with literal types', () => {
  it('T23-P8 the transformed program has no diagnostic', () => {
    expect(diagnosticsOf(LITERAL_VALUE)).toEqual([]);
  });

  it('T23-P8 the bundle runs and resolves the value', async () => {
    const exported = await run(LITERAL_VALUE);
    expect(exported.kindRead).toBe('a');
  });
});

/** The partial's factory reads a type of `types.ts` in a type position only: that module must not become a runtime dependency. */
function typeOnlyRead(typesText: string, importLine: string, typeText: string): Record<string, string> {
  return {
    'types.ts': typesText,
    'part.ts': `import { definePartialConfig } from '@djodjonx/neosyringe';
${importLine}
export class Remote { greet(): string { return 'typed read'; } }
export const part = definePartialConfig({
  injections: [{ token: Remote, useFactory: true, dependencies: [], provider: (): ${typeText} => new Remote() }],
});
`,
    'app.ts': consumerOf("import type { Remote } from './part';", 'Remote', 'TypeOnlyRead'),
  };
}

const TYPE_ONLY_VARIANTS: ReadonlyArray<readonly [string, Record<string, string>, string]> = [
  [
    'a named type',
    typeOnlyRead('export interface IRemote { greet(): string }\n', "import type { IRemote } from './types';", 'IRemote'),
    "import type { IRemote as __neo_Type_IRemote } from './types';",
  ],
  [
    'a namespace import of types',
    typeOnlyRead('export interface IRemote { greet(): string }\n', "import type * as shapes from './types';", 'shapes.IRemote'),
    "import type * as __neo_Type_Module from './types';",
  ],
  [
    'a default export',
    typeOnlyRead('export default interface IRemote { greet(): string }\n', "import type IRemote from './types';", 'IRemote'),
    "import type { default as __neo_Type_default } from './types';",
  ],
];

/** The only read of `IA` in the partial's factory sits inside a marker the plugin rewrites: nothing is left to import. */
const DROPPED_READ: Record<string, string> = {
  'part.ts': [
    "import { definePartialConfig, useInterface } from '@djodjonx/neosyringe';",
    'export interface IA { n: number }',
    'export interface IR { n: number }',
    'export const part = definePartialConfig({',
    '  injections: [',
    '    {',
    '      token: useInterface<IR>(),',
    '      useFactory: true,',
    '      dependencies: [useInterface<IA>()],',
    '      provider: (k: { resolve(token: unknown): unknown }) => k.resolve(useInterface<IA>()),',
    '    },',
    '  ],',
    '});',
    '',
  ].join('\n'),
  'app.ts': [
    "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
    "import { part, type IA } from './part';",
    'class AImpl implements IA { n = 4; }',
    'export const container = defineBuilderConfig({',
    '  extends: [part],',
    '  injections: [{ token: useInterface<IA>(), provider: AImpl }],',
    '});',
    '',
  ].join('\n'),
};

/** Without `import type`, esbuild under `verbatimModuleSyntax` keeps the module an import names. */
function runtimeImportsOf(code: string): string[] {
  const emitted = esbuild.transformSync(code, {
    loader: 'ts',
    format: 'esm',
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  }).code;
  return [...emitted.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? '');
}

describe('T23-G3 a rewrite adds a runtime dependency only where the user text reads a value', () => {
  it.each(TYPE_ONLY_VARIANTS)('T23-G3 a name the copied factory reads only as a type is imported with `import type`: %s', (_name, files, line) => {
    const code = transformedApp(files);
    expect(runtimeImportsOf(code)).not.toContain('./types');
    expect(code).toContain(line);
  });

  it.each(TYPE_ONLY_VARIANTS)('T23-G3 that type read is bound in the transformed program and the bundle runs: %s', async (_name, files) => {
    expect(diagnosticsOf(files)).toEqual([]);
    const exported = await run(files);
    expect(exported.greeting).toBe('typed read');
  });

  it('T23-G3 a name whose every read the plugin rewrites registers no import', () => {
    const code = transformedApp(DROPPED_READ);
    expect(code).not.toContain('__neo_Import_');
    // The typed getter of the partial's own token `IR` is bound by an `import type`; `IA`, whose only read the
    // plugin rewrites, is bound by none beyond the one the user wrote.
    const importLines = code.split('\n').filter((line) => /^import\b/.test(line));
    expect(importLines.filter((line) => line.includes('__neo_Type_'))).toEqual(["import type { IR as __neo_Type_IR } from './part';"]);
    expect(importLines.filter((line) => /\bIA\b/.test(line))).toEqual(["import { part, type IA } from './part';"]);
    // No module beyond the ones the user's own imports name.
    const userModules = runtimeImportsOf(DROPPED_READ['app.ts'] ?? '');
    expect(runtimeImportsOf(code).filter((module) => !userModules.includes(module))).toEqual([]);
  });
});

/** The partial reads a name the container's own file exports: the container file must not import itself. */
function ownFileFiles(exportLine: string, importedName: string): Record<string, string> {
  return {
    'part.ts': `import { definePartialConfig } from '@djodjonx/neosyringe';
import { ${importedName} } from './app';
export class Note { constructor(readonly text: string) {} }
export const part = definePartialConfig({
  injections: [{ token: Note, useFactory: true, dependencies: [], provider: () => new Note(new ${importedName}().label()) }],
});
`,
    'app.ts': `import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { part, type Note } from './part';

class Tag { label(): string { return 'from the container file'; } }
${exportLine}

export class Consumer { constructor(readonly note: Note) {} }

export const container = defineBuilderConfig({
  name: 'OwnFileBinding',
  extends: [part],
  injections: [{ token: Consumer }],
});

export const greeting: string = container.resolve<Consumer>(Consumer).note.text;
`,
  };
}

const OWN_FILE_VARIANTS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['an export under its own name', ownFileFiles('export { Tag };', 'Tag')],
  ['an export under another name than the class', ownFileFiles('export { Tag as Label };', 'Label')],
];

describe('T23-G3 a factory copied into the file that already holds what it reads', () => {
  it.each(OWN_FILE_VARIANTS)('T23-G3 the container file does not import itself: %s', (_name, files) => {
    const code = transformedApp(files);
    expect(code).not.toMatch(/from '\.\/app'/);
    // The class is read by the name the container file gives it, `Tag`, whatever name it exports it under.
    expect(code).toMatch(/new __neo_Import_\d+\.Note\(new Tag\(\)\.label\(\)\)/);
  });

  it.each(OWN_FILE_VARIANTS)('T23-G3 the transformed program has no diagnostic and the bundle runs: %s', async (_name, files) => {
    expect(diagnosticsOf(files)).toEqual([]);
    const exported = await run(files);
    expect(exported.greeting).toBe('from the container file');
  });
});

/** The parent and the class its child reads both live in the container file: the child reads `Logger` by its own name. */
const PARENT_CLASS_OWN_FILE: Record<string, string> = {
  'app.ts': `${NEO}

export class Logger { readonly label = 'logger of the container file'; }
export class Svc { constructor(readonly l: Logger) {} }

export const parent = defineBuilderConfig({ name: 'OwnParent', injections: [{ token: Logger }] });
export const child = defineBuilderConfig({ name: 'OwnChild', useContainer: parent, injections: [{ token: Svc }] });

export const label: string = child.resolve<Svc>(Svc).l.label;
export const isLogger: boolean = child.resolve<Svc>(Svc).l instanceof Logger;
`,
};

describe('T23-G4 a parent class declared in the container file is read by its own name', () => {
  it('T23-G4 the container file does not import itself and reads the parent class as `Logger`', () => {
    const code = transformedApp(PARENT_CLASS_OWN_FILE);
    expect(code).not.toMatch(/from '\.\/app'/);
    expect(code).toMatch(/new Svc\(this\._resolveInternal\(Logger\)\)/);
  });

  it('T23-G4 the transformed program has no diagnostic and the bundle runs', async () => {
    expect(diagnosticsOf(PARENT_CLASS_OWN_FILE)).toEqual([]);
    const exported = await run(PARENT_CLASS_OWN_FILE);
    expect(exported.label).toBe('logger of the container file');
    expect(exported.isLogger).toBe(true);
  });
});
