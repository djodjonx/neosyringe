import ts from 'typescript';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { neoSyringePlugin } from './packages/unplugin/dist/index.mjs';
const require = createRequire(import.meta.url);
const runtime = require('./packages/neosyringe/dist/index.cjs');
function compile(name, source) {
  const plugin = neoSyringePlugin.vite();
  const code = name === 'false_positive_marker' ? source : `import { defineBuilderConfig, useInterface, useProperty, IDisposable } from '@djodjonx/neosyringe';\n${source}`;
  const output = plugin.transform(code, `${process.cwd()}/edge-${name}.ts`);
  plugin.buildEnd();
  const generated = typeof output === 'string' ? output : output?.code ?? code;
  writeFileSync(`/private/tmp/neosyringe-edge-${name}.ts`, generated);
  const js = ts.transpileModule(generated, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  new Function('exports', 'require', js)(exports, (id) => id === '@djodjonx/neosyringe' ? runtime : require(id));
  return exports;
}
const cases = [
  ['concurrent_init', `
    interface IResource { id: number }
    let count = 0;
    const c = defineBuilderConfig({ injections: [{ token: useInterface<IResource>(), provider: async () => { const id = ++count; await Promise.resolve(); return {id}; } }] });
    export const run = async () => { await Promise.all([c.initialize(), c.initialize()]); return { factoryCalls: count, cachedId: c.resolve(useInterface<IResource>()).id }; };
  `],
  ['multi_async', `
    interface IResource { id: number }
    const c = defineBuilderConfig({ injections: [
      { token: useInterface<IResource>(), provider: async () => ({id: 1}), multi: true },
      { token: useInterface<IResource>(), provider: async () => ({id: 2}), multi: true }
    ] });
    export const run = () => ({ initializeType: typeof c.initialize, itemTypes: c.resolveAll(useInterface<IResource>()).map(x => ({ promise: x instanceof Promise, id: x.id })) });
  `],
  ['multi_dispose', `
    interface IResource { dispose(): void }
    let disposed = 0;
    class A implements IDisposable { dispose() { disposed++; } }
    class B implements IDisposable { dispose() { disposed++; } }
    const c = defineBuilderConfig({ injections: [
      { token: useInterface<IResource>(), provider: A, multi: true },
      { token: useInterface<IResource>(), provider: B, multi: true }
    ] });
    export const run = () => { const n = c.resolveAll(useInterface<IResource>()).length; c.destroy(); return { created: n, disposed }; };
  `],
  ['generic_tokens', `
    interface Repo<T> { value: T }
    interface User { name: string }
    interface Order { total: number }
    const c = defineBuilderConfig({ injections: [
      { token: useInterface<Repo<User>>(), useValue: { value: { name: 'alice' } } },
      { token: useInterface<Repo<Order>>(), useValue: { value: { total: 42 } } }
    ] });
    export const run = () => c.resolve(useInterface<Repo<User>>());
  `],
  ['property_variable', `
    class Api { constructor(public url: string) {} }
    const URL = useProperty<string>(Api, 'url');
    const c = defineBuilderConfig({ injections: [{ token: URL, provider: () => 'https://example.test' }, { token: Api }] });
    export const run = () => c.resolve(Api).url;
  `],
  ['inherited_constructor', `
    class Logger { name = 'logger' }
    class Base { constructor(public logger: Logger) {} }
    class Derived extends Base {}
    const c = defineBuilderConfig({ injections: [{ token: Logger }, { token: Derived }] });
    export const run = () => ({ injected: c.resolve(Derived).logger !== undefined });
  `],
  ['alias_marker', `
    import { defineBuilderConfig as defineDI } from '@djodjonx/neosyringe';
    class Service {}
    const c = defineDI({ injections: [{ token: Service }] });
    export const run = () => c.resolve(Service);
  `],
  ['namespace_marker', `
    import * as di from '@djodjonx/neosyringe';
    class Service {}
    const c = di.defineBuilderConfig({ injections: [{ token: Service }] });
    export const run = () => c.resolve(Service);
  `],
  ['false_positive_marker', `
    function defineBuilderConfig(config: any) { return { business: true, config }; }
    const c = defineBuilderConfig({ injections: [] });
    export const run = () => ({ business: c.business, constructorName: c.constructor.name });
  `],
];
for (const [name, source] of cases) {
  let exports;
  try { exports = compile(name, source); }
  catch (error) { console.log(JSON.stringify({name, phase: 'transform_or_module_execution', error: error.message})); continue; }
  try { console.log(JSON.stringify({name, transformed: true, result: await exports.run()})); }
  catch (error) { console.log(JSON.stringify({name, phase: 'run', error: error.message})); }
}
