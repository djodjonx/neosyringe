import type { ValidationMode } from '../../src/analyzer/types';
import { captureRoot } from './memoryModules';

/**
 * Parity corpus of topic 03: one fixture per item of the acceptance list
 * (aliased imports, namespace imports, re-exports, several containers per file,
 * extends, parents incl. closed parent, nested partials, packages, optional deps,
 * non-NeoSyringe homonym markers, foreign-file positions).
 * Each fixture lives in its own folder of the virtual root.
 */
export interface CorpusFixture {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly validation?: ValidationMode;
}

const NEO = "import { defineBuilderConfig, definePartialConfig, useInterface, useProperty, declareContainerTokens } from '@djodjonx/neosyringe';";

function lines(...rows: string[]): string {
  return `${rows.join('\n')}\n`;
}

export const CORPUS: readonly CorpusFixture[] = [
  {
    name: 'aliased-imports',
    files: {
      'parts.ts': lines(
        NEO,
        'export class Logger {}',
        'export class Clock {}',
        'export const basePart = definePartialConfig({ injections: [{ token: Logger }, { token: Clock }] });',
        "export const parentBox = defineBuilderConfig({ name: 'AliasParent', injections: [{ token: Logger }] });",
      ),
      'app.ts': lines(
        NEO,
        "import { basePart as shared, Logger as Log, parentBox as ParentAlias } from './parts';",
        'export class App { constructor(public log: Log) {} }',
        "export const app = defineBuilderConfig({ name: 'AliasApp', extends: [shared], injections: [{ token: App }] });",
        'export class Child { constructor(public log: Log) {} }',
        "export const child = defineBuilderConfig({ name: 'AliasChild', useContainer: ParentAlias, injections: [{ token: Child }] });",
      ),
    },
  },
  {
    name: 'namespace-import',
    files: {
      'parts.ts': lines(
        NEO,
        'export class Repo {}',
        'export interface Settings { n: number }',
        'export const part = definePartialConfig({ injections: [{ token: Repo }, { token: useInterface<Settings>(), useValue: { n: 1 } }] });',
      ),
      'app.ts': lines(
        NEO,
        "import * as P from './parts';",
        'export class Svc { constructor(public repo: P.Repo) {} }',
        "export const app = defineBuilderConfig({ name: 'NsApp', extends: [P.part], injections: [{ token: Svc }] });",
      ),
    },
  },
  {
    name: 'reexport',
    files: {
      'parts.ts': lines(
        NEO,
        'export class Store {}',
        'export const part = definePartialConfig({ injections: [{ token: Store }] });',
        "export const box = defineBuilderConfig({ name: 'ReParent', injections: [{ token: Store }] });",
      ),
      'barrel.ts': lines("export * from './parts';", "export { part as renamedPart } from './parts';"),
      'app.ts': lines(
        NEO,
        "import { renamedPart, box, Store } from './barrel';",
        'export class Svc { constructor(public store: Store) {} }',
        "export const app = defineBuilderConfig({ name: 'ReApp', extends: [renamedPart], injections: [{ token: Svc }] });",
        'export class Other { constructor(public store: Store) {} }',
        "export const other = defineBuilderConfig({ name: 'ReOther', useContainer: box, injections: [{ token: Other }] });",
      ),
    },
  },
  {
    name: 'two-containers-one-file',
    files: {
      'many.ts': lines(
        NEO,
        'export class A {}',
        'export class B {}',
        "export const first = defineBuilderConfig({ name: 'First', injections: [{ token: A }] });",
        'export const second = defineBuilderConfig({ injections: [{ token: B }] });',
        "export default defineBuilderConfig({ name: 'Third', injections: [{ token: A }, { token: B }] });",
      ),
    },
  },
  {
    name: 'extends-order-dup',
    files: {
      'order.ts': lines(
        NEO,
        'class A {}',
        'class B {}',
        'class C {}',
        'class D {}',
        'interface Cfg { n: number }',
        'export const p1 = definePartialConfig({ injections: [{ token: A }, { token: B }, { token: useInterface<Cfg>(), useValue: { n: 1 } }] });',
        'export const p2 = definePartialConfig({ injections: [{ token: B }, { token: C }] });',
        "export const host = defineBuilderConfig({",
        "  name: 'ExtHost',",
        '  extends: [p1, p2],',
        '  injections: [',
        '    { token: C, scoped: true },',
        '    { token: D },',
        '    { token: D },',
        '    { token: A },',
        '    { token: useInterface<Cfg>(), useValue: { n: 2 } },',
        '  ],',
        '});',
      ),
    },
  },
  {
    name: 'parent-open',
    files: {
      'family.ts': lines(
        NEO,
        'export class Base {}',
        'export class Kid { constructor(public base: Base) {} }',
        'export class Grand { constructor(public kid: Kid, public base: Base) {} }',
        "export const parent = defineBuilderConfig({ name: 'OpenParent', injections: [{ token: Base }] });",
        "export const kid = defineBuilderConfig({ name: 'OpenKid', useContainer: parent, injections: [{ token: Kid }] });",
        "export const grand = defineBuilderConfig({ name: 'OpenGrand', useContainer: kid, injections: [{ token: Grand }] });",
      ),
    },
  },
  {
    name: 'parent-closed',
    files: {
      'closed.ts': lines(
        NEO,
        'export interface Port { n: number }',
        'export class Hidden {}',
        'export class Exposed { constructor(public hidden: Hidden) {} }',
        'export const closedParent = defineBuilderConfig({',
        "  name: 'ClosedParent',",
        "  optimization: { mode: 'closed', roots: [Exposed] },",
        '  injections: [{ token: Hidden }, { token: Exposed }],',
        '});',
        'export class User { constructor(public exposed: Exposed) {} }',
        "export const user = defineBuilderConfig({ name: 'ClosedUser', useContainer: closedParent, injections: [{ token: User }] });",
        'export const asyncParent = defineBuilderConfig({',
        "  name: 'AsyncParent',",
        '  injections: [{ token: useInterface<Port>(), dependencies: [], provider: async () => ({ n: 1 }) }],',
        '});',
        "export const asyncChild = defineBuilderConfig({ name: 'AsyncChild', useContainer: asyncParent, injections: [] });",
      ),
    },
  },
  {
    name: 'parent-declare-tokens',
    files: {
      'legacy.ts': lines(
        NEO,
        'export class Old {}',
        'export const legacyBox = declareContainerTokens<{ Old: Old }>({});',
        'export class Newer { constructor(public old: Old) {} }',
        "export const modern = defineBuilderConfig({ name: 'Modern', useContainer: legacyBox, injections: [{ token: Newer }] });",
      ),
      'aliased.ts': lines(
        NEO,
        "import { legacyBox as shim, Old } from './legacy';",
        'export class Fresh { constructor(public old: Old) {} }',
        "export const viaAlias = defineBuilderConfig({ name: 'ViaAlias', useContainer: shim, injections: [{ token: Fresh }] });",
      ),
    },
  },
  {
    name: 'nested-partials',
    files: {
      'nested.ts': lines(
        NEO,
        'export interface Cfg { n: number }',
        'class Inner {}',
        'class Outer { constructor(public inner: Inner) {} }',
        'export const inner = definePartialConfig({ injections: [{ token: Inner }, { token: useInterface<Cfg>(), useValue: { n: 3 } }] });',
        'export const outer = definePartialConfig({ extends: [inner], injections: [{ token: Outer }] });',
        "export const hostOne = defineBuilderConfig({ name: 'NestOne', extends: [outer], injections: [] });",
        "export const hostTwo = defineBuilderConfig({ name: 'NestTwo', extends: [inner, outer], injections: [] });",
      ),
      'bound.ts': lines(
        NEO,
        "import * as P from './nested';",
        "import { inner as renamedInner } from './nested';",
        "export const viaNs = defineBuilderConfig({ name: 'NestNs', extends: [P.inner], injections: [] });",
        "export const viaName = defineBuilderConfig({ name: 'NestName', extends: [renamedInner], injections: [] });",
      ),
    },
  },
  {
    name: 'packages',
    files: {
      'node_modules/pkg/index.ts': lines('export class PkgService {}', 'export class PkgUser { constructor(public service: PkgService) {} }'),
      'app.ts': lines(
        NEO,
        "import { PkgService, PkgUser } from './node_modules/pkg/index';",
        "export const app = defineBuilderConfig({ name: 'PkgApp', injections: [{ token: PkgService }, { token: PkgUser }] });",
      ),
    },
  },
  {
    name: 'optional-deps',
    files: {
      'optional.ts': lines(
        NEO,
        'class Present {}',
        'class Absent {}',
        'class Needs {',
        '  constructor(public a?: Present, public b: Absent | undefined = undefined, public c = 5) {}',
        '}',
        "export const app = defineBuilderConfig({ name: 'OptApp', injections: [{ token: Present }, { token: Needs }] });",
      ),
    },
  },
  {
    name: 'homonym-markers',
    files: {
      'fake.ts': lines(
        'function defineBuilderConfig(config: object): object { return config; }',
        'function useInterface<T>(): string { return "x"; }',
        'class Local {}',
        'export const fake = defineBuilderConfig({ name: "Fake", injections: [{ token: Local }] });',
        'export const token = useInterface<Local>();',
      ),
      'real.ts': lines(
        NEO,
        'class Real {}',
        "export const real = defineBuilderConfig({ name: 'Real', injections: [{ token: Real }] });",
      ),
    },
  },
  {
    name: 'foreign-positions',
    files: {
      'services.ts': lines(
        'export class Rest { constructor(...parts: string[]) {} }',
        'export class Fine {}',
        "export const forced = { n: 1 };",
      ),
      'app.ts': lines(
        NEO,
        "import { Rest, Fine, forced } from './services';",
        'interface Shape { n: number }',
        "export const app = defineBuilderConfig({ name: 'ForeignApp', injections: [{ token: Rest }, { token: Fine }, { token: useInterface<Shape>(), useValue: forced }] });",
      ),
    },
  },
  {
    name: 'multi-order',
    files: {
      'multi.ts': lines(
        NEO,
        'interface Plugin { run(): void }',
        'class One implements Plugin { run(): void {} }',
        'class Two implements Plugin { run(): void {} }',
        'class Host { constructor(public plugins: Plugin) {} }',
        'export const part = definePartialConfig({ injections: [{ token: useInterface<Plugin>(), provider: One, multi: true }] });',
        'export const app = defineBuilderConfig({',
        "  name: 'MultiApp',",
        '  extends: [part],',
        '  injections: [',
        '    { token: useInterface<Plugin>(), provider: Two, multi: true },',
        '    { token: useInterface<Plugin>(), provider: One, multi: true },',
        '    { token: Host },',
        '  ],',
        '});',
        "export const mixed = defineBuilderConfig({ name: 'Mixed', injections: [{ token: One }, { token: One, multi: true }] });",
      ),
    },
  },
  {
    name: 'expects',
    files: {
      'expects.ts': lines(
        NEO,
        'class Needed {}',
        'class Uses { constructor(public needed: Needed) {} }',
        'export const part = definePartialConfig({ expects: [Needed], injections: [{ token: Uses }] });',
        "export const good = defineBuilderConfig({ name: 'ExpGood', extends: [part], injections: [{ token: Needed }] });",
        "export const bad = defineBuilderConfig({ name: 'ExpBad', extends: [part], injections: [] });",
      ),
    },
  },
  {
    name: 'closed-mode-errors',
    files: {
      'closed.ts': lines(
        NEO,
        'class A {}',
        'class B {}',
        'export const unknownRoot = defineBuilderConfig({ name: "ClosedUnknown", optimization: { mode: "closed", roots: [B] }, injections: [{ token: A }] });',
        'export const badMode = defineBuilderConfig({ name: "ClosedBad", optimization: { mode: "weird" }, injections: [{ token: A }] });',
        'export const eagerOpen = defineBuilderConfig({ name: "OpenEager", optimization: { mode: "open", eager: [A] }, injections: [{ token: A }] });',
        'export const minimal = defineBuilderConfig({ name: "Minimal", runtime: { profile: "minimal" }, optimization: { mode: "closed", roots: [A], eager: [A] }, injections: [{ token: A }] });',
      ),
    },
  },
  {
    name: 'closed-multi-roots',
    files: {
      'roots.ts': lines(
        NEO,
        'interface Plugin { run(): void }',
        'class One implements Plugin { run(): void {} }',
        'class Two implements Plugin { run(): void {} }',
        'class Single {}',
        'const plugin = useInterface<Plugin>();',
        'export const app = defineBuilderConfig({',
        "  name: 'ClosedMulti',",
        '  optimization: { mode: "closed", roots: [Single, { all: plugin }], eager: [plugin] },',
        '  injections: [',
        '    { token: plugin, provider: One, multi: true },',
        '    { token: plugin, provider: Two, multi: true },',
        '    { token: Single },',
        '  ],',
        '});',
      ),
    },
  },
  {
    name: 'rejected-injection',
    files: {
      'rejected.ts': lines(
        NEO,
        'class Svc { constructor(public name: string) {} }',
        'class Fine {}',
        'export const app = defineBuilderConfig({',
        "  name: 'Rejected',",
        '  injections: [',
        "    { token: useProperty<string>(Svc, 'name') },",
        '    { token: Fine },',
        '    { token: Fine, ownership: "mine" },',
        '  ],',
        '});',
      ),
    },
  },
  {
    name: 'compatible-opaque-factory',
    validation: 'compatible',
    files: {
      'compat.ts': lines(
        NEO,
        'interface Port { n: number }',
        'interface Port2 { n: number }',
        'const port2 = useInterface<Port2>();',
        'export const loose = defineBuilderConfig({ name: "Loose", injections: [{ token: useInterface<Port>(), provider: () => ({ n: 1 }) }] });',
        'export const closedLoose = defineBuilderConfig({ name: "ClosedLoose", optimization: { mode: "closed", roots: [port2] }, injections: [{ token: port2, provider: () => ({ n: 1 }) }] });',
      ),
    },
  },
  {
    name: 'strict-factory-without-dependencies',
    files: {
      'strict.ts': lines(
        NEO,
        'interface Port { n: number }',
        'export const loose = defineBuilderConfig({ name: "Strict", injections: [{ token: useInterface<Port>(), provider: () => ({ n: 1 }) }] });',
      ),
    },
  },
  {
    name: 'disposable-transient',
    files: {
      'dispose.ts': lines(
        NEO,
        'class Conn { dispose(): void {} }',
        'class Svc { constructor(public conn: Conn) {} }',
        "export const box = defineBuilderConfig({ name: 'DispBox', injections: [{ token: Conn, lifecycle: 'transient' }, { token: Svc }] });",
        "export const part = definePartialConfig({ injections: [{ token: Conn, lifecycle: 'transient' }] });",
        "export const viaPart = defineBuilderConfig({ name: 'DispPart', extends: [part], injections: [{ token: Svc }] });",
      ),
    },
  },
  {
    name: 'diagnostics-mix',
    files: {
      'mix.ts': lines(
        NEO,
        'interface Logger { log(): void }',
        'class Impl { other(): void {} }',
        'class Dep {}',
        'class NeedsDep { constructor(public dep: Dep) {} }',
        'class CycleA { constructor(public b: CycleB) {} }',
        'class CycleB { constructor(public a: CycleA) {} }',
        'export const bad = defineBuilderConfig({',
        "  name: 'MixBad',",
        '  injections: [',
        '    { token: NeedsDep },',
        '    { token: useInterface<Logger>(), provider: Impl },',
        '    { token: CycleA },',
        '    { token: CycleB },',
        '    { token: CycleA },',
        '  ],',
        '});',
      ),
    },
  },
  {
    name: 'resolve-usages',
    files: {
      'container.ts': lines(
        NEO,
        'export class Known {}',
        'export class Unknown {}',
        "export const container = defineBuilderConfig({ name: 'Usage', injections: [{ token: Known }] });",
      ),
      'caller.ts': lines(
        "import { container, Known, Unknown } from './container';",
        'export const ok = container.resolve(Known);',
        'export const missing = container.resolve(Unknown);',
        'export const unknownReceiver = (somewhere as { resolve(token: unknown): unknown }).resolve(Known);',
        'declare const somewhere: unknown;',
      ),
    },
  },
  {
    name: 'bare-return',
    files: {
      'bare.ts': lines(
        NEO,
        'class A {}',
        "export function make() { return defineBuilderConfig({ name: 'Bare', injections: [{ token: A }] }); }",
      ),
    },
  },
  {
    name: 'duplicate-container-names',
    files: {
      'names.ts': lines(
        NEO,
        'class A {}',
        "export const one = defineBuilderConfig({ name: 'Same', injections: [{ token: A }] });",
        "export const two = defineBuilderConfig({ name: 'Same', injections: [{ token: A }] });",
      ),
    },
  },
  {
    name: 'parent-multi-all',
    files: {
      'open.ts': lines(
        NEO,
        'interface Plugin { name: string }',
        'interface Summary { names: string[] }',
        'const plugin = useInterface<Plugin>();',
        'const summary = useInterface<Summary>();',
        "export const parent = defineBuilderConfig({ name: 'MultiOpenParent', injections: [",
        "  { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },",
        "  { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },",
        '] });',
        "export const child = defineBuilderConfig({ name: 'MultiOpenChild', useContainer: parent, injections: [",
        '  { token: summary, useFactory: true, dependencies: [{ all: plugin }], provider: (context): Summary => ({ names: context.resolveAll(plugin).map((item) => item.name) }) },',
        '] });',
      ),
      'closed.ts': lines(
        NEO,
        'interface Plugin { name: string }',
        'interface Secret { name: string }',
        'interface Summary { names: string[] }',
        'const plugin = useInterface<Plugin>();',
        'const secret = useInterface<Secret>();',
        'const summary = useInterface<Summary>();',
        "export const parent = defineBuilderConfig({ name: 'MultiClosedParent', optimization: { mode: 'closed', roots: [{ all: plugin }] }, injections: [",
        "  { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },",
        "  { token: secret, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'hidden' }) },",
        '] });',
        "export const exported = defineBuilderConfig({ name: 'MultiClosedExported', useContainer: parent, injections: [",
        '  { token: summary, useFactory: true, dependencies: [{ all: plugin }], provider: (context): Summary => ({ names: context.resolveAll(plugin).map((item) => item.name) }) },',
        '] });',
        "export const leak = defineBuilderConfig({ name: 'MultiClosedLeak', useContainer: parent, injections: [",
        '  { token: summary, useFactory: true, dependencies: [{ all: secret }], provider: (context): Summary => ({ names: context.resolveAll(secret).map((item) => item.name) }) },',
        '] });',
      ),
      'partial.ts': lines(
        NEO,
        'interface Plugin { name: string }',
        'interface Summary { names: string[] }',
        'const plugin = useInterface<Plugin>();',
        'const summary = useInterface<Summary>();',
        "export const part = definePartialConfig({ injections: [{ token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'part' }) }] });",
        "export const host = defineBuilderConfig({ name: 'MultiPartialHost', extends: [part], injections: [",
        '  { token: summary, useFactory: true, dependencies: [{ all: plugin }], provider: (context): Summary => ({ names: context.resolveAll(plugin).map((item) => item.name) }) },',
        '] });',
      ),
    },
  },
  {
    name: 'expects-alias',
    files: {
      'base.ts': lines(
        NEO,
        'export class Needed {}',
        'export const basePart = definePartialConfig({ expects: [Needed], injections: [] });',
      ),
      'reexport.ts': lines("export { basePart as sharedOut } from './base';"),
      'app.ts': lines(
        NEO,
        "import { basePart as shared, Needed } from './base';",
        "import { sharedOut } from './reexport';",
        "import * as B from './base';",
        "export const viaAlias = defineBuilderConfig({ name: 'ExpAlias', extends: [shared], injections: [] });",
        "export const viaReexport = defineBuilderConfig({ name: 'ExpReexport', extends: [sharedOut], injections: [] });",
        "export const viaNamespace = defineBuilderConfig({ name: 'ExpNamespace', extends: [B.basePart], injections: [] });",
        "export const satisfied = defineBuilderConfig({ name: 'ExpSatisfied', extends: [shared], injections: [{ token: Needed }] });",
      ),
    },
  },
  {
    name: 'closed-parent-private',
    files: {
      'closed.ts': lines(
        NEO,
        'export class Secret {}',
        'export class Shown {}',
        'export class NeedsSecret { constructor(public secret: Secret) {} }',
        'export class NeedsShown { constructor(public shown: Shown) {} }',
        "export const parent = defineBuilderConfig({ name: 'PrivParent', optimization: { mode: 'closed', roots: [Shown] }, injections: [{ token: Shown }, { token: Secret }] });",
        "export const readsShown = defineBuilderConfig({ name: 'PrivReadsShown', useContainer: parent, injections: [{ token: NeedsShown }] });",
        "export const readsSecret = defineBuilderConfig({ name: 'PrivReadsSecret', useContainer: parent, injections: [{ token: NeedsSecret }] });",
        "export const ownsSecret = defineBuilderConfig({ name: 'PrivOwnsSecret', useContainer: parent, injections: [{ token: Secret }] });",
      ),
    },
  },
  {
    name: 'closed-extends-opaque',
    validation: 'compatible',
    files: {
      'closed.ts': lines(
        NEO,
        'interface Port2 { n: number }',
        'const port2 = useInterface<Port2>();',
        'export const part = definePartialConfig({ injections: [{ token: port2, provider: () => ({ n: 1 }) }] });',
        "export const closedHost = defineBuilderConfig({ name: 'ClosedHost', extends: [part], optimization: { mode: 'closed', roots: [port2] }, injections: [] });",
      ),
    },
  },
];

export function fixtureFiles(fixture: CorpusFixture): Map<string, string> {
  return new Map(Object.entries(fixture.files).map(([name, text]) => [captureRoot(`${fixture.name}/${name}`), text]));
}
