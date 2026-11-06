import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { GraphValidator, type GraphValidationResult } from '../../src/generator/GraphValidator';
import { createFastProgram } from '../fastProgram';

// One program for every child graph. extractAll keeps each defineBuilderConfig apart
// (packages/core/src/analyzer/Analyzer.ts:335).
const SOURCE = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
function defineBuilderConfig(config: any) { return config; }
function useInterface<T>(): any { return null; }

interface Plugin { name: string; }
interface Summary { names: string[]; }
interface Ghost { name: string; }
interface Needs { names: string[]; }
interface Secret { name: string; }
interface Leak { names: string[]; }

const plugin = useInterface<Plugin>();
const summary = useInterface<Summary>();
const ghost = useInterface<Ghost>();
const needs = useInterface<Needs>();
const secret = useInterface<Secret>();
const leak = useInterface<Leak>();

export const openParent = defineBuilderConfig({
  name: 'OpenParent',
  injections: [
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
  ],
});

export const openChild = defineBuilderConfig({
  name: 'OpenChild',
  useContainer: openParent,
  injections: [
    {
      token: summary,
      useFactory: true,
      dependencies: [{ all: plugin }],
      provider: (context): Summary => ({ names: context.resolveAll(plugin).map((item) => item.name) }),
    },
  ],
});

export const soloChild = defineBuilderConfig({
  name: 'SoloChild',
  useContainer: openParent,
  injections: [
    { token: plugin, useFactory: true, dependencies: [], provider: () => ({ name: 'solo' }) },
  ],
});

export const emptyParent = defineBuilderConfig({
  name: 'EmptyParent',
  injections: [],
});

export const missingChild = defineBuilderConfig({
  name: 'MissingChild',
  useContainer: emptyParent,
  injections: [
    {
      token: needs,
      useFactory: true,
      dependencies: [{ all: ghost }],
      provider: (context): Needs => ({ names: context.resolveAll(ghost).map((item) => item.name) }),
    },
  ],
});

export const closedParent = defineBuilderConfig({
  name: 'ClosedParent',
  optimization: { mode: 'closed', roots: [{ all: plugin }] },
  injections: [
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
  ],
});

export const closedChild = defineBuilderConfig({
  name: 'ClosedChild',
  useContainer: closedParent,
  injections: [
    {
      token: summary,
      useFactory: true,
      dependencies: [{ all: plugin }],
      provider: (context): Summary => ({ names: context.resolveAll(plugin).map((item) => item.name) }),
    },
  ],
});

export const closedPrivateParent = defineBuilderConfig({
  name: 'ClosedPrivateParent',
  optimization: { mode: 'closed', roots: [{ all: plugin }] },
  injections: [
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
    { token: secret, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'hidden' }) },
  ],
});

export const closedPrivateChild = defineBuilderConfig({
  name: 'ClosedPrivateChild',
  useContainer: closedPrivateParent,
  injections: [
    {
      token: leak,
      useFactory: true,
      dependencies: [{ all: secret }],
      provider: (context): Leak => ({ names: context.resolveAll(secret).map((item) => item.name) }),
    },
  ],
});
`;

const FILE_NAME = path.join('/virtual/t08-all', 'child.ts');

function createProgram(fileName: string, fileContent: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const sources = new Map([[fileName, fileContent]]);
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return read(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => sources.has(name) || exists(name);
  return createFastProgram([fileName], options, host);
}

describe('T08 child { all } of a parent multi token', () => {
  let graphs: DependencyGraph[];

  beforeAll(() => {
    const program = createProgram(FILE_NAME, SOURCE);
    graphs = new Analyzer(program, { validation: 'strict' }).extractAll();
  });

  function graphNamed(name: string): DependencyGraph {
    const graph = graphs.find((item) => item.containerId === name);
    if (!graph) throw new Error(`missing graph ${name}`);
    return graph;
  }

  function reported(result: GraphValidationResult): Array<{ code: string | undefined; message: string }> {
    return result.errors.map((error) => ({ code: error.code, message: error.message }));
  }

  it('T08-ALL-CORE open parent multi returns no error', () => {
    const result = new GraphValidator().validateAll(graphNamed('OpenChild'));
    expect(reported(result)).toEqual([]);
  });

  it('T08-ALL-CORE single provider on a parent multi token is a duplicate', () => {
    const result = new GraphValidator().validateAll(graphNamed('SoloChild'));
    // GraphValidator.ts:62-68 pushes type duplicate and no code.
    expect(reported(result)).toEqual([
      {
        code: undefined,
        message:
          "Duplicate registration: 'Plugin' is already registered in the parent container. Use 'scoped: true' to override.",
      },
    ]);
  });

  it('T08-ALL-CORE ghost is NEO_MISSING_PROVIDER', () => {
    const result = new GraphValidator().validateAll(graphNamed('MissingChild'));
    expect(reported(result)).toEqual([
      {
        code: 'NEO_MISSING_PROVIDER',
        message: "Missing injection: 'Ghost' required by 'Needs' is not registered.",
      },
    ]);
  });

  it('T08-ALL-CORE closed exported multi has no error and private multi is refused', () => {
    const exported = new GraphValidator().validateAll(graphNamed('ClosedChild'));
    expect(reported(exported)).toEqual([]);

    const hidden = new GraphValidator().validateAll(graphNamed('ClosedPrivateChild'));
    expect(reported(hidden)).toEqual([
      {
        code: 'NEO_MISSING_PROVIDER',
        message: "Missing injection: 'Secret' required by 'Leak' is not registered.",
      },
    ]);
  });
});
