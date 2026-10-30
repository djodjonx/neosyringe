import { neoSyringePlugin } from './packages/unplugin/dist/index.mjs';
const plugin = neoSyringePlugin.vite({ devtools: true });
let middleware;
plugin.configureServer({ middlewares: { use(fn) { middleware = fn; } } });
plugin.transform(`import { defineBuilderConfig } from '@djodjonx/neosyringe'; class Service {} export const container = defineBuilderConfig({ injections: [{token: Service}] });`, `${process.cwd()}/audit-devtools.ts`);
let body;
middleware({url: '/__neosyringe/data.json'}, { setHeader() {}, end(value) { body = value; } }, () => {});
console.log(JSON.stringify({ middlewareInstalled: typeof middleware === 'function', graphs: JSON.parse(body) }));
