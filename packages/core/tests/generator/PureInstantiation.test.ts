import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { Generator } from '../../src/generator/Generator';
import type { DependencyGraph, DependencyNode } from '../../src/analyzer/types';

function serviceNode(): DependencyNode {
  const fileName = path.join(tmpdir(), 't14-p8-service.ts');
  const sourceText = 'export class Service {}\n';
  const options: ts.CompilerOptions = {
    noLib: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
  };
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2020, true);
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (name === fileName) return sourceFile;
    return originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  host.readFile = (name) => (name === fileName ? sourceText : ts.sys.readFile(name));
  const program = ts.createProgram([fileName], options, host);
  const statement = sourceFile.statements[0];
  if (!ts.isClassDeclaration(statement) || !statement.name) {
    throw new Error('classe Service absente');
  }
  const symbol = program.getTypeChecker().getSymbolAtLocation(statement.name);
  if (!symbol) throw new Error('symbole Service absent');
  return {
    service: {
      tokenId: 'Service',
      implementationSymbol: symbol,
      registrationNode: statement,
      type: 'explicit',
      lifecycle: 'singleton',
    },
    dependencies: [],
  };
}

describe('T14 pure instantiation', () => {
  it('T14-P8-generate-instantiation', () => {
    const graph: DependencyGraph = {
      containerId: 'TestContainer',
      nodes: new Map([['Service', serviceNode()]]),
      roots: [],
      exportedVariableName: 'container',
      variableExportModifier: 'export',
    };
    const generator = new Generator(graph);
    const expression = generator.generateInstantiation();
    expect(expression.startsWith('/* @__PURE__ */ new NeoContainer')).toBe(true);

    const code = generator.generate();
    const pureLines = code.split('\n').filter((line) => line.includes('/* @__PURE__ */'));
    expect(pureLines).toHaveLength(1);
    expect(pureLines[0]).toContain('new NeoContainer');
    expect(pureLines[0]).not.toContain('initialize');
    expect(pureLines[0]).not.toContain('destroy');
    const providerLines = code.split('\n').filter((line) => line.includes('return new '));
    expect(providerLines.length).toBeGreaterThan(0);
    for (const line of providerLines) {
      expect(line).not.toContain('/* @__PURE__ */');
    }
  });
});
