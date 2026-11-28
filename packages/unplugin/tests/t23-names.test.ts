import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { neoSyringePlugin } from '../src/index';

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

type Hooks = { transform: (code: string, id: string) => unknown };

function hasTransform(plugin: object): plugin is Hooks {
  return 'transform' in plugin && typeof plugin.transform === 'function';
}

function hooksFor(project: string): Hooks {
  const plugin = neoSyringePlugin.vite({ project });
  if (Array.isArray(plugin) || !hasTransform(plugin)) throw new Error('hook transform attendu');
  return plugin;
}

function codeOf(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'code' in result && typeof result.code === 'string') return result.code;
  throw new Error('le plugin n\'a rien transformé');
}

/** A project on disk: a default-exported provider, and one file that holds the containers. */
function workspace(): { transform: (source: string) => string } {
  const dir = mkdtempSync(path.join(tmpdir(), 't23-names-'));
  dirs.push(dir);
  if (cwdToRestore === undefined) cwdToRestore = process.cwd();
  process.chdir(dir);
  const config = path.join(dir, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: false, noLib: true, types: [], skipLibCheck: true },
  }));
  writeFileSync(path.join(dir, 'login.ts'), 'export default class Login {}\n');
  const entry = path.join(dir, 'container.ts');
  const hooks = hooksFor(config);
  return {
    transform: (source) => {
      writeFileSync(entry, source);
      return codeOf(hooks.transform(source, entry));
    },
  };
}

const HEADER = [
  "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
  "import Login from './login';",
].join('\n');

const TWO = [
  "export const first = defineBuilderConfig({ name: 'First', injections: [{ token: Login }] });",
  "export const second = defineBuilderConfig({ name: 'Second', injections: [{ token: Login }] });",
].join('\n');

function importAliases(code: string): string[] {
  return [...code.matchAll(/import \* as (\w+) from/g)].map((match) => match[1]);
}

describe('T23 the plugin names generated bindings from one pool per file (B4)', () => {
  it('T23-P4 two containers of one file import their provider under two different names', () => {
    const output = workspace().transform(`${HEADER}\n${TWO}\n`);
    const aliases = importAliases(output);
    expect(aliases).toHaveLength(2);
    expect(new Set(aliases).size).toBe(2);
    expect(output).not.toContain('defineBuilderConfig(');
  });

  it('T23-P4 a name the file already declares is never reused for a generated import', () => {
    const output = workspace().transform(`${HEADER}\nconst __neo_Import_0 = 'mine';\n${TWO}\nexport { __neo_Import_0 };\n`);
    expect(importAliases(output)).not.toContain('__neo_Import_0');
    expect(importAliases(output)).toHaveLength(2);
    expect(output.match(/const __neo_Import_0 = 'mine';/g)).toHaveLength(1);
  });

  it('T23-P4 a class the file declares with the generated class name keeps its name', () => {
    const body = "export const container = defineBuilderConfig({ name: 'Solo', injections: [{ token: Login }] });";
    const { transform } = workspace();
    const generated = /class (NeoContainer_\w+) \{/.exec(transform(`${HEADER}\n${body}\n`))?.[1];
    if (!generated) throw new Error('classe générée introuvable');
    const output = transform(`${HEADER}\n${body}\nexport class ${generated} { static mine = true; }\n`);
    expect(output.match(new RegExp(`class ${generated} \\{`, 'g'))).toHaveLength(1);
    expect(output).toContain(`class ${generated}_1 {`);
    expect(output).toContain(`new ${generated}_1(`);
  });

  it('T23-P4 a var hoisted out of a top-level block keeps its name out of the generated imports', () => {
    const output = workspace().transform(`${HEADER}\nif (Math.random()) { var __neo_Import_0 = 'mine'; }\n${TWO}\nexport { __neo_Import_0 };\n`);
    expect(importAliases(output)).not.toContain('__neo_Import_0');
    expect(importAliases(output)).toHaveLength(2);
    expect(output.match(/var __neo_Import_0 = 'mine';/g)).toHaveLength(1);
  });

  it('T23-P4 a var declared by a top-level for keeps the generated class name free', () => {
    const body = "export const container = defineBuilderConfig({ name: 'Solo', injections: [{ token: Login }] });";
    const { transform } = workspace();
    const generated = /class (NeoContainer_\w+) \{/.exec(transform(`${HEADER}\n${body}\n`))?.[1];
    if (!generated) throw new Error('classe générée introuvable');
    const output = transform(`${HEADER}\n${body}\nfor (var ${generated} = 0; ${generated} < 1; ${generated}++) { /* keep */ }\n`);
    expect(output).toContain(`for (var ${generated} = 0;`);
    expect(output.match(new RegExp(`class ${generated} \\{`, 'g'))).toBeNull();
    expect(output).toContain(`class ${generated}_1 {`);
  });
});
