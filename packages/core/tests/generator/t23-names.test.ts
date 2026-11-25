import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import { NamePool } from '../../src/generator/fragments';
import { reservedNamesOf } from '../../src/generator/reservedNames';
import type { DependencyGraph, DependencyNode } from '../../src/analyzer/types';
import { createVirtualProgram } from '../helpers/createVirtualProgram';

interface RuntimeContainer {
  resolve: (token: unknown) => unknown;
  destroy: () => Promise<void>;
}

const opened: RuntimeContainer[] = [];

afterEach(async () => {
  for (const container of opened.splice(0)) await container.destroy().catch(() => undefined);
});

class Login {}

/** Runs a generated module. `./login` is the only module it can import. */
function run(code: string, names: string[]): Record<string, RuntimeContainer> {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const load = new Function('module', 'exports', 'require', js) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
  ) => void;
  load(record, record.exports, () => ({ default: Login }));
  const found: Record<string, RuntimeContainer> = {};
  for (const name of names) {
    const container = record.exports[name];
    if (!container) throw new Error(`generated module did not export ${name}`);
    opened.push(container);
    found[name] = container;
  }
  return found;
}

function createMultiFileProgram(files: Record<string, string>): ts.Program {
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile;
  host.getSourceFile = (name, version) => {
    const key = Object.keys(files).find((candidate) => name === candidate);
    if (key) return ts.createSourceFile(name, files[key], version, true);
    return original.call(host, name, version);
  };
  host.fileExists = (file) => file in files || ts.sys.fileExists(file);
  host.directoryExists = (dir) => dir === '/virtual/t23-names' || ts.sys.directoryExists(dir);
  return ts.createProgram(Object.keys(files), {}, host);
}

const TWO_CONTAINERS: Record<string, string> = {
  '/virtual/t23-names/login.ts': 'export default class Login {}',
  '/virtual/t23-names/container.ts': `
    import { defineBuilderConfig } from '@djodjonx/neosyringe';
    import Login from './login';
    function defineBuilderConfig(c: any) { return c; }
    export const first = defineBuilderConfig({ name: 'First', injections: [{ token: Login }] });
    export const second = defineBuilderConfig({ name: 'Second', injections: [{ token: Login }] });
  `,
};

function twoGraphs(): DependencyGraph[] {
  const graphs = new Analyzer(createMultiFileProgram(TWO_CONTAINERS)).extractAll()
    .filter((graph) => graph.sourceFileName?.endsWith('container.ts'));
  expect(graphs.map((graph) => graph.exportedVariableName).sort()).toEqual(['first', 'second']);
  return graphs;
}

function direct(graph: DependencyGraph, names?: NamePool): Generator {
  return new Generator(graph, true, undefined, false, false, undefined, undefined, { names });
}

/** What the plugin does to a file: each generated class, then the variable that holds it. */
function inlined(generators: Array<{ generator: Generator; variable: string }>, prelude = ''): string {
  const blocks = generators.map(
    ({ generator, variable }) => `${generator.generate()}\nexport const ${variable} = ${generator.generateInstantiation()};`,
  );
  return `${prelude}\n${blocks.join('\n')}`;
}

function declared(code: string, pattern: RegExp): string[] {
  return [...code.matchAll(pattern)].map((match) => match[1]);
}

describe('T23 generated names come from one pool per source file (B4)', () => {
  it('T23-P4 two containers of one file share a pool: distinct imports, distinct classes, both run', () => {
    const pool = new NamePool([]);
    const generators = twoGraphs().map((graph) => ({
      generator: direct(graph, pool),
      variable: graph.exportedVariableName ?? 'container',
    }));
    const code = inlined(generators);
    const imports = declared(code, /import \* as (\w+) from/g);
    const classes = declared(code, /^class (NeoContainer_\w+)/gm);
    expect(imports).toHaveLength(2);
    expect(new Set(imports).size).toBe(2);
    expect(classes).toHaveLength(2);
    expect(new Set(classes).size).toBe(2);
    const { first, second } = run(code, ['first', 'second']);
    expect(first.resolve(Login)).toBeInstanceOf(Login);
    expect(second.resolve(Login)).toBeInstanceOf(Login);
    expect(first.resolve(Login)).not.toBe(second.resolve(Login));
  });

  it('T23-P4 keeps today\'s visible names when nothing collides', () => {
    const [graph] = twoGraphs();
    const code = direct(graph, new NamePool([])).generate();
    expect(declared(code, /import \* as (\w+) from/g)).toEqual(['__neo_Import_0']);
    expect(declared(code, /^class (NeoContainer_\w+)/gm)).toHaveLength(1);
    const alone = new Generator(graph, false, '/out').generate();
    expect(alone).toContain('class NeoContainer {');
    expect(alone).toContain('class NeoServiceNotFoundError extends Error');
  });

  it('T23-P4 a user binding named like the generated container class is never redeclared', () => {
    const [graph] = twoGraphs();
    const probe = direct(graph).generateInstantiation();
    const taken = /new (NeoContainer_\w+)\(/.exec(probe)?.[1];
    if (!taken) throw new Error(`no class name in ${probe}`);
    const generator = direct(graph, new NamePool([taken]));
    const code = inlined(
      [{ generator, variable: graph.exportedVariableName ?? 'container' }],
      `class ${taken} { static user = true; }`,
    );
    const classes = declared(code, /^class (NeoContainer_\w+)/gm);
    expect(classes).toHaveLength(2);
    expect(new Set(classes).size).toBe(2);
    expect(generator.generateInstantiation()).not.toContain(`new ${taken}(`);
    const exported = graph.exportedVariableName ?? 'container';
    expect(run(code, [exported])[exported].resolve(Login)).toBeInstanceOf(Login);
  });

  it('T23-P4 a user binding named like the generated not-found error class is never redeclared', () => {
    const [graph] = twoGraphs();
    const probe = direct(graph).generate();
    const taken = /class (NeoServiceNotFoundError_\w+) extends Error/.exec(probe)?.[1];
    if (!taken) throw new Error('no error class name in the probe');
    const code = direct(graph, new NamePool([taken])).generate();
    expect(declared(code, /^class (NeoServiceNotFoundError_\w+) extends Error/gm)).toEqual([`${taken}_1`]);
    expect(code).toContain(`throw new ${taken}_1(`);
  });

  it('T23-P4 a user binding named like a generated import is never redeclared', () => {
    const [graph] = twoGraphs();
    const generator = direct(graph, new NamePool(['__neo_Import_0']));
    const code = generator.generate();
    expect(declared(code, /import \* as (\w+) from/g)).toEqual(['__neo_Import_0_1']);
    expect(code).toContain('__neo_Import_0_1.default');
    expect(code).not.toContain('__neo_Import_0.default');
  });

  it('T23-P4 a hoisted useValue const never takes the name of a user binding', () => {
    const service: DependencyNode['service'] = {
      tokenId: 'Port_1',
      type: 'value',
      valueSource: '"captured"',
      valueCapture: '__neoCapture_hand_0',
      lifecycle: 'singleton',
      isInterfaceToken: true,
      registrationNode: {} as ts.Node,
    };
    const graph: DependencyGraph = {
      containerId: 'Names',
      nodes: new Map([['Port_1', { service, dependencies: [] }]]),
      roots: ['Port_1'],
      exportedVariableName: 'container',
      variableExportModifier: 'export',
    };
    const generator = new Generator(graph, false, undefined, false, false, undefined, undefined, {
      names: new NamePool(['__neoCapture_hand_0']),
    });
    const code = `const __neoCapture_hand_0 = "user binding";\n${generator.generate()}`;
    expect(code.match(/const __neoCapture_hand_0 =/g)).toHaveLength(1);
    expect(run(code, ['container']).container.resolve('Port_1')).toBe('captured');
  });

  it('T23-P4 a capture marked as a read names a binding of the file and is never renamed', () => {
    const service: DependencyNode['service'] = {
      tokenId: 'Port_1',
      type: 'value',
      valueSource: '"unused"',
      valueCapture: 'userBinding',
      valueCaptureRead: true,
      lifecycle: 'singleton',
      isInterfaceToken: true,
      registrationNode: {} as ts.Node,
    };
    const graph: DependencyGraph = {
      containerId: 'Names',
      nodes: new Map([['Port_1', { service, dependencies: [] }]]),
      roots: ['Port_1'],
      exportedVariableName: 'container',
      variableExportModifier: 'export',
    };
    const generator = new Generator(graph, false, undefined, false, false, undefined, undefined, {
      names: new NamePool(['userBinding']),
    });
    const code = `const userBinding = "from the file";\n${generator.generate()}`;
    expect(run(code, ['container']).container.resolve('Port_1')).toBe('from the file');
  });

  it('T23-P9 two runs on the same graphs give the same code, whatever a pool did before', () => {
    const generate = (): string => {
      const pool = new NamePool([]);
      return inlined(twoGraphs().map((graph) => ({
        generator: direct(graph, pool),
        variable: graph.exportedVariableName ?? 'container',
      })));
    };
    const first = generate();
    new NamePool([]).forKey('noise');
    expect(generate()).toBe(first);
  });
});

describe('T23 reserved names of a source file (B4)', () => {
  /** The names the checker of a real program holds for the file, sorted. */
  function reserved(source: string): string[] {
    const program = createVirtualProgram('names.ts', source, {});
    const file = program.getSourceFile('names.ts');
    if (!file) throw new Error('missing names.ts');
    return [...reservedNamesOf(file, program.getTypeChecker())].sort();
  }

  const EVERY_KIND = `
      import Default, { named, other as renamed } from './m';
      import * as space from './n';
      import type { OnlyType } from './o';
      import legacy = require('./p');
      const plain = 1, { picked, nested: [deep, ...rest], ...spread } = { picked: 1, nested: [2] };
      let mutable = 2;
      var old = 3;
      function fn() { const inner = 1; return inner; }
      class Klass {}
      enum Color { Red }
      interface Shape {}
      type Alias = string;
      namespace Space { export const inside = 1; }
      export const exported = 1;
      export default class Fallback {}
      if (plain) { const blockScoped = 1; }
    `;
  const EVERY_KIND_NAMES = [
    'Alias', 'Color', 'Default', 'Fallback', 'Klass', 'OnlyType', 'Shape', 'Space', 'deep', 'exported',
    'fn', 'legacy', 'mutable', 'named', 'old', 'picked', 'plain', 'renamed', 'rest', 'space', 'spread',
  ];
  // `var` is hoisted to the module whatever statement holds it; `let` and `const` stay in their block.
  const HOISTED = `
      import { x } from './x';
      if (x) { var __neo_Import_0 = 1; }
      for (var NeoContainer = 0; ;) { break; }
      for (var key in x) {}
      try { var hidden = 1; } catch { var inCatch = 2; } finally { var inFinally = 3; }
      switch (x) { case 1: var inSwitch = 1; }
      { let blockLet = 1; const blockConst = 2; var inBlock = 3; }
      function fn() { var local = 1; return local; }
      class Klass { method() { var local = 1; return local; } }
      export {};
    `;
  const HOISTED_NAMES = [
    'Klass', 'NeoContainer', '__neo_Import_0', 'fn', 'hidden', 'inBlock', 'inCatch', 'inFinally', 'inSwitch', 'key', 'x',
  ];

  it('T23-P4 lists every top-level binding of a file, whatever declares it', () => {
    expect(reserved(EVERY_KIND)).toEqual(EVERY_KIND_NAMES);
  });

  it('T23-P4 lists a var declared in a top-level block, loop, try or switch', () => {
    expect(reserved(HOISTED)).toEqual(HOISTED_NAMES);
  });

  it('T23-P4 a source file that declares __neo_Import_0 keeps it out of the generated names', () => {
    const names = reserved('const __neo_Import_0 = 1; export const __neo_Import_1 = 2;');
    const pool = new NamePool(names);
    expect(pool.forKey('a', '__neo_Import_0')).toBe('__neo_Import_0_1');
    expect(pool.forKey('b', '__neo_Import_1')).toBe('__neo_Import_1_1');
    expect(pool.forKey('c', '__neo_Import_2')).toBe('__neo_Import_2');
  });

  it('T23-P4 a var hoisted out of a block keeps its name out of the generated names', () => {
    const pool = new NamePool(reserved('if (Math.random()) { var __neo_Import_0 = 1; }\nexport {};'));
    expect(pool.forKey('a', '__neo_Import_0')).toBe('__neo_Import_0_1');
  });
});
