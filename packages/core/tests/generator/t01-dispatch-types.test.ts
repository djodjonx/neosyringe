import { dirname } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import { warmLibCache } from '../fastProgram';
import { named, programOf } from '../helpers/t00-contract';
import { checkStrict, formatDiagnostic, unsafeTypesMessage, type EmittedModule, type StrictInput } from '../helpers/t23-program';

/**
 * T01 types. The shared tables are typed: the output of the default emitter holds no unsafe type
 * (TYPES-SAFETY.md, "Méthodes générées") and compiles in a real strict Program, multi, parent and closed included.
 */

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

function source(options: string): string {
  return `
  ${STUB}
  interface T01Item { n: number }
  const item = useInterface<T01Item>();
  export class T01Inherited { n = 7; }
  export class T01Leaf { n = 1; }
  export class T01Consumer { constructor(readonly leaf: T01Leaf) {} }
  export const parent = defineBuilderConfig({ name: 'T01Parent', injections: [{ token: T01Inherited }] });
  export const box = defineBuilderConfig({
    name: 'T01Box',
    useContainer: parent,
    ${options}
    injections: [
      { token: item, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      { token: item, multi: true, useValue: { n: 3 } },
      { token: T01Leaf },
      { token: T01Consumer },
    ],
  });
`;
}

const CONSUMER = [
  "import { box } from './box.out.ts';",
  'export async function consume(token: unknown): Promise<void> {',
  '  const one: string = box.resolve<string>(token);',
  '  const every: number[] = box.resolveAll<number>(token);',
  '  const scope = box.createScope();',
  '  await scope.destroy();',
  '  await box.destroy();',
  '  void one;',
  '  void every;',
  '}',
  '',
].join('\n');

interface Variant {
  name: string;
  options: string;
  /** The tables the default emitter declares for this variant. */
  tables: readonly string[];
}

const VARIANTS: readonly Variant[] = [
  { name: 'full open', options: '', tables: ['__neoDispatch', '__neoLists'] },
  { name: 'minimal open', options: "runtime: { profile: 'minimal' },", tables: ['__neoDispatch', '__neoLists'] },
  {
    name: 'full closed',
    options: "optimization: { mode: 'closed', roots: [T01Consumer, { all: item }] },",
    tables: ['__neoRoots', '__neoRootLists'],
  },
  {
    name: 'minimal closed',
    options: "runtime: { profile: 'minimal' }, optimization: { mode: 'closed', roots: [T01Consumer, { all: item }] },",
    tables: ['__neoRoots', '__neoRootLists'],
  },
];

/** The default output of `text`: no unsafe type, the tables declared, and a strict Program that passes. */
function expectStrict(name: string, text: string, tables: readonly string[]): void {
  const dir = '/virtual/t01-types';
  const userFile = `${name.replace(/ /g, '-')}.ts`;
  const userPath = `${dir}/${userFile}`;
  const graphs = new Analyzer(programOf(userPath, text)).extractAll();
  const render = (graph: string): string => new Generator(named(graphs, graph), false, dirname(userPath), true, false).generate();
  const outputs: EmittedModule[] = [
    { file: 'box.out.ts', code: render('box') },
    { file: 'parent.out.ts', code: render('parent') },
  ];
  const box = outputs[0]?.code ?? '';
  for (const table of tables) {
    expect(box, `${name} declares ${table}`).toMatch(new RegExp(`private static ${table}\\b`));
  }
  for (const output of outputs) {
    expect(unsafeTypesMessage(output.code, output.file), `${name} ${output.file}`).toBe('');
  }
  const input: StrictInput = {
    dir,
    userSource: { file: userFile, text },
    outputs,
    consumer: { file: 'consumer.ts', code: CONSUMER },
    ambient: "declare const parent: typeof import('./parent.out.ts').parent;\n",
  };
  expect(checkStrict(input).map(formatDiagnostic), name).toEqual([]);
}

describe('T01 dispatch types', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('P16 the default output holds no unsafe type and passes a strict Program', () => {
    for (const variant of VARIANTS) expectStrict(variant.name, source(variant.options), variant.tables);
  }, 120_000);

  it('P19 a multi root also read by a factory passes a strict Program', () => {
    const text = `
  ${STUB}
  interface T01Item { n: number }
  const item = useInterface<T01Item>();
  interface T01Report { total: number }
  const report = useInterface<T01Report>();
  export const parent = defineBuilderConfig({ name: 'T01Parent', injections: [] });
  export const box = defineBuilderConfig({
    name: 'T01Box',
    optimization: { mode: 'closed', roots: [report, { all: item }] },
    injections: [
      { token: item, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      { token: item, multi: true, useValue: { n: 3 } },
      { token: report, useFactory: true, dependencies: [{ all: item }], provider: () => ({ total: 2 }) },
    ],
  });
`;
    expectStrict('multi root and factory', text, ['__neoRoots', '__neoRootLists', '__neoLists']);
  }, 120_000);
});
