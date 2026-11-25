import type * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type {
  AnalysisError,
  DependencyGraph,
  DependencyNode,
  ServiceDefinition,
  ValidationMode,
} from '../../src/analyzer/types';
import { TSContext } from '../../src/TSContext';
import { captureRoot, memoryProgram } from './memoryModules';

/**
 * Test-only oracle over the PUBLIC DependencyGraph / AnalysisError types.
 * It reads no private field, so the same dump runs on base da6641b (golden capture)
 * and on the snapshot-based analyzer. Paths are repo-relative, order is the analyzer's order.
 */
export const DUMP_ROOT = captureRoot('');
const ROOT_PREFIX = `${DUMP_ROOT}/`;

export function relative(fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/');
  return normalized.startsWith(ROOT_PREFIX) ? normalized.slice(ROOT_PREFIX.length) : normalized;
}

export interface ErrorDump {
  type: string;
  code: string | null;
  severity: string | null;
  message: string;
  file: string;
  start: number;
  end: number;
  tokenText: string | null;
  chain: readonly string[] | null;
  containerId: string | null;
}

export interface ServiceDump {
  tokenId: string;
  type: string;
  lifecycle: string;
  registration: string;
  registrationId: string | null;
  ownership: string | null;
  capturedInContainerId: string | null;
  valueCapture: string | null;
  isScoped: boolean | null;
  isAsync: boolean | null;
  isDisposable: boolean | null;
  isAsyncDisposable: boolean | null;
  isInterfaceToken: boolean | null;
  isValueToken: boolean | null;
  opaque: boolean | null;
  factorySource: string | null;
  valueSource: string | null;
  implementationLocalName: string | null;
  tokenLocalName: string | null;
  implementationSymbol: string | null;
  tokenSymbol: string | null;
  factoryDependencies: readonly string[] | null;
  dependencyEdges: readonly string[] | null;
  dependencies: readonly string[];
  optionalDependencies: readonly string[] | null;
}

export interface GraphDump {
  file: string | null;
  containerKey: string | null;
  containerId: string;
  containerName: string | null;
  exportedVariableName: string | null;
  variableExportModifier: string | null;
  variableStatementStart: number | null;
  defineBuilderConfigStart: number | null;
  defineBuilderConfigEnd: number | null;
  mode: string | null;
  profile: string | null;
  roots: readonly string[];
  publicRoots: readonly string[] | null;
  publicMultiRoots: readonly string[] | null;
  eagerRoots: readonly string[] | null;
  legacyContainers: readonly string[] | null;
  parentProvidedTokens: readonly string[] | null;
  parentResolvableTokens: readonly string[] | null;
  parentClassTokenSymbols: readonly string[] | null;
  parentHasAsyncInitialize: boolean | null;
  borrowed: readonly string[] | null;
  retention: readonly string[] | null;
  nodes: readonly ServiceDump[];
  multiNodes: readonly { token: string; items: readonly ServiceDump[] }[];
  errors: readonly ErrorDump[];
}

export interface FixtureDump {
  extractAll: GraphDump[] | { thrown: string };
  extractAllErrors: ErrorDump[] | { thrown: string };
  extractForFile: Record<string, ErrorDump[] | { thrown: string }>;
  extract: GraphDump | { thrown: string };
}

function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function dumpError(error: AnalysisError): ErrorDump {
  const start = error.node.getStart(error.sourceFile);
  return {
    type: error.type,
    code: orNull(error.code),
    severity: orNull(error.severity),
    message: error.message,
    file: relative(error.sourceFile.fileName),
    start,
    end: error.node.getEnd(),
    tokenText: orNull(error.context?.tokenText),
    chain: orNull(error.context?.chain),
    containerId: orNull(error.containerId),
  };
}

function dumpService(node: DependencyNode): ServiceDump {
  const service: ServiceDefinition = node.service;
  const registrationFile = service.registrationNode.getSourceFile();
  return {
    tokenId: service.tokenId,
    type: service.type,
    lifecycle: service.lifecycle,
    registration: `${relative(registrationFile.fileName)}:${service.registrationNode.getStart(registrationFile)}`,
    registrationId: orNull(service.registrationId),
    ownership: orNull(service.ownership),
    capturedInContainerId: orNull(service.capturedInContainerId),
    valueCapture: orNull(service.valueCapture),
    isScoped: orNull(service.isScoped),
    isAsync: orNull(service.isAsync),
    isDisposable: orNull(service.isDisposable),
    isAsyncDisposable: orNull(service.isAsyncDisposable),
    isInterfaceToken: orNull(service.isInterfaceToken),
    isValueToken: orNull(service.isValueToken),
    opaque: orNull(service.opaque),
    factorySource: orNull(service.factorySource),
    valueSource: orNull(service.valueSource),
    implementationLocalName: orNull(service.implementationLocalName),
    tokenLocalName: orNull(service.tokenLocalName),
    implementationSymbol: service.implementationSymbol ? service.implementationSymbol.getName() : null,
    tokenSymbol: service.tokenSymbol ? service.tokenSymbol.getName() : null,
    factoryDependencies: service.factoryDependencies
      ? service.factoryDependencies.map((dep) => `${dep.tokenId}|${dep.all}|${dep.source}|${dep.containerId}`)
      : null,
    dependencyEdges: service.dependencyEdges
      ? service.dependencyEdges.map((edge) => `${edge.tokenId}|${edge.paramIndex}|${edge.optional}|${edge.multi}|${edge.origin}`)
      : null,
    dependencies: [...node.dependencies],
    optionalDependencies: node.optionalDependencies ? [...node.optionalDependencies] : null,
  };
}

export function dumpGraph(graph: DependencyGraph): GraphDump {
  return {
    file: graph.sourceFileName === undefined ? null : relative(graph.sourceFileName),
    containerKey: orNull(graph.containerKey),
    containerId: graph.containerId,
    containerName: orNull(graph.containerName),
    exportedVariableName: orNull(graph.exportedVariableName),
    variableExportModifier: orNull(graph.variableExportModifier),
    variableStatementStart: orNull(graph.variableStatementStart),
    defineBuilderConfigStart: orNull(graph.defineBuilderConfigStart),
    defineBuilderConfigEnd: orNull(graph.defineBuilderConfigEnd),
    mode: orNull(graph.optimizationMode),
    profile: orNull(graph.runtimeProfile),
    roots: [...graph.roots],
    publicRoots: graph.publicRoots ? [...graph.publicRoots] : null,
    publicMultiRoots: graph.publicMultiRoots ? [...graph.publicMultiRoots] : null,
    eagerRoots: graph.eagerRoots ? [...graph.eagerRoots] : null,
    legacyContainers: graph.legacyContainers ? [...graph.legacyContainers] : null,
    parentProvidedTokens: graph.parentProvidedTokens ? [...graph.parentProvidedTokens] : null,
    parentResolvableTokens: graph.parentResolvableTokens ? [...graph.parentResolvableTokens] : null,
    parentClassTokenSymbols: graph.parentClassTokenSymbols
      ? [...graph.parentClassTokenSymbols].map(([token, symbol]) => `${token}|${symbol.getName()}`)
      : null,
    parentHasAsyncInitialize: orNull(graph.parentHasAsyncInitialize),
    borrowed: graph.borrowedRegistrations
      ? graph.borrowedRegistrations.map((item) => `${item.registrationId}|${item.tokenId}|${item.containerId}`)
      : null,
    retention: graph.retention
      ? [...graph.retention].map(([key, reason]) => `${key}|${reason.kind}${'token' in reason ? `|${reason.token}` : ''}`)
      : null,
    nodes: [...graph.nodes.values()].map(dumpService),
    multiNodes: graph.multiNodes
      ? [...graph.multiNodes].map(([token, items]) => ({ token, items: items.map(dumpService) }))
      : [],
    errors: (graph.errors ?? []).map(dumpError),
  };
}

/**
 * What the folded partials expect from their host. It is NOT part of GraphDump: the golden was captured
 * from base, which has no such field, so it is compared by its own test (t03c1-expects.test.ts).
 */
export function dumpExpectedExternal(graph: DependencyGraph): readonly string[] | null {
  return graph.expectedExternalTokens ? [...graph.expectedExternalTokens] : null;
}

function thrownOf(error: unknown): { thrown: string } {
  if (error instanceof Error) return { thrown: `${error.name}: ${error.message}` };
  return { thrown: String(error) };
}

function guarded<T>(read: () => T): T | { thrown: string } {
  try {
    return read();
  } catch (error: unknown) {
    return thrownOf(error);
  }
}

function sourceFilesOf(program: ts.Program): string[] {
  return program.getSourceFiles().filter((file) => !file.isDeclarationFile).map((file) => file.fileName);
}

/** One fixture, read through every public path of the analyzer. Each path gets its own Analyzer. */
export function dumpProgram(program: ts.Program, validation: ValidationMode): FixtureDump {
  return TSContext.runWithProjectRoot(DUMP_ROOT, () => {
    const options = { validation };
    const forFile: Record<string, ErrorDump[] | { thrown: string }> = {};
    for (const file of sourceFilesOf(program)) {
      forFile[relative(file)] = guarded(() => new Analyzer(program, options).extractForFile(file).errors.map(dumpError));
    }
    return {
      extractAll: guarded(() => new Analyzer(program, options).extractAll().map(dumpGraph)),
      extractAllErrors: guarded(() => new Analyzer(program, options).extractAllErrors().map(dumpError)),
      extractForFile: forFile,
      extract: guarded(() => dumpGraph(new Analyzer(program, options).extract())),
    };
  });
}

export function dumpFiles(files: ReadonlyMap<string, string>, validation: ValidationMode): FixtureDump {
  return dumpProgram(memoryProgram(files), validation);
}
