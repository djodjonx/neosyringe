import ts from 'typescript';
import { writeFileSync } from 'node:fs';
import { neoSyringePlugin } from './packages/unplugin/dist/index.mjs';

function compile(name, source) {
  const plugin = neoSyringePlugin.vite();
  const code = `import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';\n${source}`;
  const output = plugin.transform(code, `${process.cwd()}/audit-${name}.ts`);
  plugin.buildEnd();
  const generated = typeof output === 'string' ? output : output?.code ?? code;
  writeFileSync(`/private/tmp/neosyringe-${name}-generated.ts`, generated);
  const js = ts.transpileModule(generated, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {};
  new Function('exports', 'require', js)(exports, (id) => { throw new Error(`Unexpected runtime import: ${id}`); });
  return exports;
}

const cases = [
  ['baseline', `
    interface ILogger { name: string }
    class Logger implements ILogger { name = 'real'; }
    class Service { constructor(public logger: ILogger) {} }
    export const c = defineBuilderConfig({ injections: [
      { token: useInterface<ILogger>(), provider: Logger }, { token: Service }
    ] });
    export const run = () => ({ logger: c.resolve(Service).logger.name, singleton: c.resolve(Service) === c.resolve(Service) });
  `],
  ['override', `
    interface ILogger { name: string }
    class Logger implements ILogger { name = 'real'; }
    export const c = defineBuilderConfig({ injections: [{ token: useInterface<ILogger>(), provider: Logger }] });
    export const run = () => {
      const token = useInterface<ILogger>();
      c.override(token, () => ({ name: 'mock' }));
      const before = c.resolve(token).name;
      c.clearOverrides();
      return { before, after: c.resolve(token).name };
    };
  `],
  ['async', `
    interface IConfig { url: string }
    interface IDatabase { url: string }
    export const c = defineBuilderConfig({ injections: [
      { token: useInterface<IConfig>(), useValue: { url: 'db://test' } },
      { token: useInterface<IDatabase>(), provider: async (container) => ({ url: container.resolve(useInterface<IConfig>()).url }), useFactory: true }
    ] });
    export const run = async () => { await c.initialize(); return c.resolve(useInterface<IDatabase>()); };
  `],
  ['scoped', `
    interface ILogger { name: string }
    class Logger implements ILogger { name = 'real'; }
    class MockLogger implements ILogger { name = 'mock'; }
    class Service { constructor(public logger: ILogger) {} }
    const parent = defineBuilderConfig({ injections: [
      { token: useInterface<ILogger>(), provider: Logger }, { token: Service }
    ] });
    const child = defineBuilderConfig({ useContainer: parent, injections: [
      { token: useInterface<ILogger>(), provider: MockLogger, scoped: true }
    ] });
    export const run = () => ({ direct: child.resolve(useInterface<ILogger>()).name, throughService: child.resolve(Service).logger.name });
  `],
  ['factory_missing', `
    class Missing {}
    interface IService { dep: Missing }
    const c = defineBuilderConfig({ injections: [
      { token: useInterface<IService>(), provider: (container) => ({ dep: container.resolve(Missing) }), useFactory: true }
    ] });
    export const run = () => c.resolve(useInterface<IService>());
  `],
  ['wrong_container', `
    interface ILogger { name: string }
    const a = defineBuilderConfig({ injections: [{ token: useInterface<ILogger>(), useValue: { name: 'real' } }] });
    const b = defineBuilderConfig({ injections: [] });
    export const run = () => b.resolve(useInterface<ILogger>());
  `],
];

for (const [name, source] of cases) {
  let exports;
  try { exports = compile(name, source); }
  catch (error) { console.log(JSON.stringify({ name, phase: 'compile', error: error.message })); continue; }
  try { console.log(JSON.stringify({ name, compile: 'passed', result: await exports.run() })); }
  catch (error) { console.log(JSON.stringify({ name, compile: 'passed', phase: 'runtime', error: error.message })); }
}
