import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// In-memory consumer, same host shape as audit/historical/audit-types.mjs:1-18.
// The fixture sources import the real package types. Nothing is left open.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const virtualFile = path.join(repoRoot, 't03-virtual-consumer.ts');
const srcTypes = './packages/neosyringe/src/types';
const distTypesFile = path.join(repoRoot, 'packages/neosyringe/dist/index.d.mts');

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
};

function compile(source: string, options: ts.CompilerOptions = compilerOptions): number[] {
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);

  host.fileExists = (fileName) => fileName === virtualFile || originalFileExists(fileName);
  host.readFile = (fileName) => (fileName === virtualFile ? source : originalReadFile(fileName));
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (fileName === virtualFile) {
      const version = typeof languageVersionOrOptions === 'object'
        ? languageVersionOrOptions.languageVersion
        : languageVersionOrOptions;
      return ts.createSourceFile(fileName, source, version, true, ts.ScriptKind.TS);
    }
    return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
  };

  const program = ts.createProgram([virtualFile], options, host);
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file !== undefined && path.resolve(diagnostic.file.fileName) === path.resolve(virtualFile))
    .map((diagnostic) => diagnostic.code);
}

const equalHelpers = `
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
`;

function historicalAudit(from: string): string {
  return `
import { defineBuilderConfig, useInterface } from '${from}';
interface ILogger { name: string }
const c = defineBuilderConfig({ injections: [{ token: useInterface<ILogger>(), provider: async () => ({ name: 'real' }), useFactory: true }] });
c.initialize();
c.override(useInterface<ILogger>(), () => ({ name: 'mock' }));
c.clearOverrides();
c.on('resolve', () => {});
`;
}

function resolveInference(from: string): string {
  return `
import { defineBuilderConfig, useInterface } from '${from}';
${equalHelpers}
class Logger { name = 'app'; }
interface ILogger { name: string }
const tokenInterface = useInterface<ILogger>();
const c = defineBuilderConfig({
  injections: [
    { token: Logger },
    { token: tokenInterface, provider: () => ({ name: 'port' }), useFactory: true },
  ],
});
const logger = c.resolve(Logger);
const viaInterface = c.resolve(tokenInterface);
type _Logger = Assert<Equal<typeof logger, Logger>>;
type _ILogger = Assert<Equal<typeof viaInterface, ILogger>>;
`;
}

describe('T03 public types', () => {
  it('T03-A01 historical audit-types consumer has zero diagnostics', () => {
    // audit/historical/audit-types.mjs:5-10
    expect(compile(historicalAudit(srcTypes))).toEqual([]);
  });

  it('T03-A02 resolve(Logger) is Logger and resolve(interface token) is ILogger', () => {
    expect(compile(resolveInference(srcTypes))).toEqual([]);
  });

  it('T03-A03 incompatible assignment is diagnostic 2322', () => {
    const source = `
import { defineBuilderConfig } from '${srcTypes}';
class Logger { name = 'app'; }
const c = defineBuilderConfig({ injections: [{ token: Logger }] });
const n: number = c.resolve(Logger);
void n;
`;
    expect(source.includes('any')).toBe(false);
    expect(compile(source)).toEqual([2322]);
  });

  it('T03-A04 minimal profile hides on and override', () => {
    const source = `
import { defineBuilderConfig, useInterface } from '${srcTypes}';
interface ILogger { name: string }
class Logger { name = 'app'; }
const c = defineBuilderConfig({
  runtime: { profile: 'minimal' },
  injections: [{ token: Logger }],
});
c.resolve(Logger);
c.on('resolve', () => {});
c.override(useInterface<ILogger>(), () => ({ name: 'mock' }));
`;
    expect(compile(source)).toEqual([2339, 2339]);
  });

  it('T03-A04 undecidable runtime.profile is a type error', () => {
    // `declare const` keeps the union. A const initializer is narrowed to 'full'.
    const source = `
import { defineBuilderConfig } from '${srcTypes}';
declare const profile: 'full' | 'minimal';
defineBuilderConfig({ runtime: { profile } });
`;
    // 2769: no overload matches. The profile guard lives on the constraint,
    // and the `never` trap is the other candidate. Same refusal as 2345.
    expect(compile(source)).toEqual([2769]);
  });

  it('T03-A05 async factory unwraps to Client', () => {
    const accepted = `
import { defineBuilderConfig, useInterface } from '${srcTypes}';
${equalHelpers}
interface Client { endpoint: string }
const clientToken = useInterface<Client>();
const c = defineBuilderConfig({
  injections: [{
    token: clientToken,
    useFactory: true,
    provider: async () => ({ endpoint: '/api' }),
  }],
});
const client = c.resolve(clientToken);
type _Client = Assert<Equal<typeof client, Client>>;
`;
    const rejected = `
import { defineBuilderConfig, useInterface } from '${srcTypes}';
interface Client { endpoint: string }
const clientToken = useInterface<Client>();
defineBuilderConfig({
  injections: [{
    token: clientToken,
    useFactory: true,
    provider: async () => 1,
  }],
});
`;
    expect(compile(accepted)).toEqual([]);
    // 2769: EnsureFactory still rejects Promise<number> for Client.
    expect(compile(rejected)).toEqual([2769]);
  });

  it('T03-A06 provider and useValue are disjoint', () => {
    const conflict = `
import { defineBuilderConfig, useInterface } from '${srcTypes}';
interface ILogger { name: string }
class Logger { name = 'app'; }
defineBuilderConfig({
  injections: [{
    token: useInterface<ILogger>(),
    provider: Logger,
    useValue: { name: 'both' },
  }],
});
`;
    const valid = `
import { defineBuilderConfig, useInterface } from '${srcTypes}';
interface ILogger { name: string }
class Logger { name = 'app'; }
class ConsoleLogger implements ILogger { name = 'console'; }
defineBuilderConfig({
  injections: [
    { token: Logger },
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<ILogger>(), provider: () => ({ name: 'f' }), useFactory: true },
    { token: useInterface<ILogger>(), useValue: { name: 'v' } },
    { token: useInterface<ILogger>(), provider: ConsoleLogger, multi: true },
    { token: useInterface<ILogger>(), provider: ConsoleLogger, scoped: true },
  ],
});
`;
    // 2769: provider and useValue stay disjoint (useValue is not undefined).
    expect(compile(conflict)).toEqual([2769]);
    expect(compile(valid)).toEqual([]);
  });

  it('T03-A06 annotated Injection[] rejects provider and useValue', () => {
    const source = `
import { defineBuilderConfig, useInterface, type Injection } from '${srcTypes}';
interface ILogger { name: string }
class Logger { name = 'app'; }
const inj: Injection[] = [{ token: useInterface<ILogger>(), provider: Logger, useValue: { name: 'b' } }];
defineBuilderConfig({ injections: inj });
`;
    expect(compile(source)).toEqual([2322]);
  });

  it('T03-A06 plain variable rejects provider and useValue', () => {
    const source = `
import { defineBuilderConfig, useInterface } from '${srcTypes}';
interface ILogger { name: string }
class Logger { name = 'app'; }
const inj = [{ token: useInterface<ILogger>(), provider: Logger, useValue: { name: 'b' } }];
defineBuilderConfig({ injections: inj });
`;
    expect(compile(source)).toEqual([2769]);
  });

  it('T03-A06 definePartialConfig extends rejects provider and useValue', () => {
    const source = `
import { defineBuilderConfig, definePartialConfig, useInterface } from '${srcTypes}';
interface ILogger { name: string }
class Logger { name = 'app'; }
const p = definePartialConfig({
  injections: [{ token: useInterface<ILogger>(), provider: Logger, useValue: { name: 'b' } }],
});
defineBuilderConfig({ extends: [p] });
`;
    expect(compile(source)).toEqual([2322]);
  });

  it('T03-A06 Injection annotation rejects provider and useValue', () => {
    const source = `
import { useInterface, type Injection } from '${srcTypes}';
interface ILogger { name: string }
class ConsoleLogger implements ILogger { name = 'console'; }
const useValue = { name: 'b' };
const i: Injection<ILogger> = { token: useInterface<ILogger>(), provider: ConsoleLogger, useValue };
void i;
`;
    expect(compile(source)).toEqual([2322]);
  });

  it('T03-A04 undecidable RuntimeProfile annotation is refused', () => {
    const source = `
import { defineBuilderConfig, type RuntimeProfile } from '${srcTypes}';
class Logger { name = 'app'; }
const runtime: RuntimeProfile = { profile: 'minimal' };
const c = defineBuilderConfig({ runtime });
c.on('resolve', () => {});
c.override(Logger, () => new Logger());
`;
    expect(compile(source)).toEqual([2769]);
  });

  it('T03-A04 undecidable runtime includes undefined is refused', () => {
    const source = `
import { defineBuilderConfig } from '${srcTypes}';
declare const rt: { profile: 'minimal' } | undefined;
defineBuilderConfig({ runtime: rt }).on('resolve', () => {});
`;
    expect(compile(source)).toEqual([2769]);
  });

  it('T03-A04 undecidable widened BuilderConfig is refused', () => {
    const source = `
import { defineBuilderConfig, type BuilderConfig } from '${srcTypes}';
declare const cfg: BuilderConfig;
defineBuilderConfig(cfg).on('resolve', () => {});
`;
    expect(compile(source)).toEqual([2769]);
  });

  it('T03-A04 undefined profile literal is the full container', () => {
    const onAndOverride = (body: string) => `
import { defineBuilderConfig } from '${srcTypes}';
class Logger { name = 'app'; }
const c = defineBuilderConfig(${body});
c.on('resolve', () => {});
c.override(Logger, () => new Logger());
`;
    expect(compile(onAndOverride('{ runtime: { profile: undefined } }'))).toEqual([]);
    expect(compile(onAndOverride('{ runtime: {} }'))).toEqual([]);
    expect(compile(onAndOverride('{}'))).toEqual([]);
  });

  it('T03 minimal profile is assignable to AsyncContainer', () => {
    const source = `
import { defineBuilderConfig, type AsyncContainer } from '${srcTypes}';
class Logger { name = 'app'; }
const c = defineBuilderConfig({
  runtime: { profile: 'minimal' },
  injections: [{ token: Logger }],
});
const a: AsyncContainer = c;
void a;
`;
    expect(compile(source)).toEqual([]);
  });

  it('T03 injections as const are accepted', () => {
    // A const binding is what makes the array readonly. An inline `as const`
    // argument is still accepted by a mutable Injection[] (TS 5.9).
    const source = `
import { defineBuilderConfig, useInterface } from '${srcTypes}';
interface ILogger { name: string }
class Logger { name = 'app'; }
const injections = [
  { token: Logger },
  { token: useInterface<ILogger>(), provider: () => ({ name: 'f' }), useFactory: true },
  { token: useInterface<ILogger>(), useValue: { name: 'v' } },
] as const;
defineBuilderConfig({ injections });
`;
    expect(compile(source)).toEqual([]);
  });

  it('T03-R3 exemple cible complet compiles with a contextually typed factory', () => {
    // 04-api-et-diagnostics.md "Exemple cible complet", import path aside.
    const source = `
import { defineBuilderConfig, useInterface } from '${srcTypes}';

interface Config { endpoint: string }
interface Client { endpoint: string; dispose(): Promise<void> }

const configToken = useInterface<Config>();
const clientToken = useInterface<Client>();

const container = defineBuilderConfig({
  name: 'application',
  optimization: { mode: 'closed', roots: [clientToken] },
  injections: [
    { token: configToken, useValue: { endpoint: '/api' } },
    {
      token: clientToken,
      useFactory: true,
      dependencies: [configToken],
      provider: async context => {
        const config = context.resolve(configToken);
        return {
          endpoint: config.endpoint,
          async dispose() { /* fermeture des ressources possédées */ }
        };
      }
    }
  ]
});

await container.initialize();
const client = container.resolve(clientToken);
await container.destroy();
`;
    expect(compile(source)).toEqual([]);
  });

  it('T03-R3 factory of all contributions compiles with resolveAll', () => {
    // 04-api-et-diagnostics.md "Factory dépendant de toutes les contributions".
    const source = `
import { defineBuilderConfig, useInterface } from '${srcTypes}';
interface Middleware { name: string }
class Pipeline {
  constructor(readonly middlewares: Middleware[]) {}
}
const middlewareToken = useInterface<Middleware>();
const pipelineToken = useInterface<Pipeline>();
defineBuilderConfig({
  injections: [
    {
      token: pipelineToken,
      useFactory: true,
      dependencies: [{ all: middlewareToken }],
      provider: context => new Pipeline(context.resolveAll(middlewareToken))
    }
  ]
});
`;
    expect(compile(source)).toEqual([]);
  });

  it('T03-R3 untyped factory parameter is FactoryContext', () => {
    const source = `
import { defineBuilderConfig, type FactoryContext } from '${srcTypes}';
${equalHelpers}
class Logger { name = 'app'; }
class Logger2 { name = 'other'; }
defineBuilderConfig({
  injections: [
    { token: Logger2, provider: (c) => {
      type _C = Assert<Equal<typeof c, FactoryContext>>;
      return c.resolve(Logger);
    }, useFactory: true },
  ],
});
`;
    expect(compile(source)).toEqual([]);
  });

  it.skipIf(!fs.existsSync(distTypesFile))(
    'T03 built declarations accept the full profile and inferred resolve',
    () => {
      // Resolve packages/neosyringe/dist/index.d.mts. Importing that file
      // directly is TS2846, so the host maps the package name onto it.
      const builtOptions: ts.CompilerOptions = {
        ...compilerOptions,
        baseUrl: repoRoot,
        paths: { '@djodjonx/neosyringe': ['packages/neosyringe/dist/index.d.mts'] },
      };
      const fromPackage = '@djodjonx/neosyringe';
      expect(compile(historicalAudit(fromPackage), builtOptions)).toEqual([]);
      expect(compile(resolveInference(fromPackage), builtOptions)).toEqual([]);
    },
  );
});
