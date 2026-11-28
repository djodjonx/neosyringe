import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph, ServiceDefinition } from '../../src/analyzer/types';
import { createFastProgram, warmLibCache } from '../fastProgram';
import { named } from '../helpers/t00-contract';

/**
 * T23 slice S3b, memory guard. The analyzer data S3b added to a ServiceDefinition (`factoryBindings`,
 * `tokenType`, `tokenBinding`, `implementationBinding`) is read once, where the registration is written, and
 * kept as plain data: strings, numbers and arrays of them. It never holds a ts.Node, ts.Symbol or ts.Type.
 * A definition outlives one transform in the plugin session, so a node or symbol kept in that data would keep
 * the whole Program and its TypeChecker alive for as long as the definition is cached.
 */

const DIR = '/virtual/t23/plain';

const FILES: Readonly<Record<string, string>> = {
  'lib.ts': [
    'export class Remote { n = 1; }',
    'export class Other { n = 2; }',
    'export interface IClock { now(): number }',
    'export interface IZone { name: string }',
    '',
  ].join('\n'),
  'main.ts': `
    import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
    import { Remote as Renamed, Other, type IClock, type IZone } from './lib';
    declare function defineBuilderConfig<T>(config: T): T;
    declare function useInterface<T>(): T;
    export class Local { constructor(readonly remote: Renamed) {} }
    export const box = defineBuilderConfig({
      name: 'Plain',
      injections: [
        { token: Renamed },
        { token: Local },
        { token: Other, useFactory: true, dependencies: [], provider: () => new Other() },
        { token: useInterface<IClock>(), useValue: { now: () => 1 } },
        { token: useInterface<IZone>(), useFactory: true, dependencies: [], provider: () => ({ name: String(new Renamed().n) }) },
      ],
    });
  `,
};

function analyse(): DependencyGraph {
  warmLibCache();
  const sources = new Map(Object.entries(FILES).map(([name, text]) => [`${DIR}/${name}`, text]));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return read(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => sources.has(name) || exists(name);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (name) => name === DIR || (directoryExists?.(name) ?? false);
  host.readFile = (name) => sources.get(name) ?? ts.sys.readFile(name);
  const program = createFastProgram([...sources.keys()], options, host);
  return named(new Analyzer(program).extractAll(), 'box');
}

/** Paths of every value under `value` that is not plain data: an object whose prototype is not Object or Array. */
function nonPlainPaths(value: unknown, path: string, seen: Set<object> = new Set()): string[] {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? [path] : [];
  }
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item, index) => nonPlainPaths(item, `${path}[${index}]`, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return [path];
  return Object.entries(value).flatMap(([key, item]) => nonPlainPaths(item, `${path}.${key}`, seen));
}

/** The S3b fields of a definition, by name. */
function bindingData(service: ServiceDefinition): Record<string, unknown> {
  return {
    factoryBindings: service.factoryBindings,
    tokenType: service.tokenType,
    tokenBinding: service.tokenBinding,
    implementationBinding: service.implementationBinding,
  };
}

describe('T23 S3b, the analyzer binding data holds no AST or checker object', () => {
  it('keeps factoryBindings, tokenType and the binding names as plain data', () => {
    const graph = analyse();
    const services = [...graph.nodes.values()].map((node) => node.service);
    const withBindings = services.filter((service) => service.factoryBindings !== undefined);
    const withTokenType = services.filter((service) => service.tokenType !== undefined);
    const withImplementation = services.filter((service) => service.implementationBinding !== undefined);
    // The fixture reaches every field, so a pass is not vacuous.
    expect(withBindings.length).toBeGreaterThan(0);
    expect(withTokenType.length).toBeGreaterThan(0);
    expect(withImplementation.length).toBeGreaterThan(0);
    const offenders = services.flatMap((service) =>
      nonPlainPaths(bindingData(service), `${String(service.tokenId)}`));
    expect(offenders).toEqual([]);
  });
});
