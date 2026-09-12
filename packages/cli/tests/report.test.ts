import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../core/src/analyzer/Analyzer.js';
import { parseArgs, buildJsonReport } from '../src/report';

describe('CLI report — parseArgs', () => {
  it('parses --project and its value', () => {
    expect(parseArgs(['--project', './tsconfig.build.json'])).toEqual({
      project: './tsconfig.build.json',
      json: false,
      graph: false,
      mermaid: false,
    });
  });

  it('parses -p as a shorthand for --project', () => {
    expect(parseArgs(['-p', 'tsconfig.json'])).toEqual({ project: 'tsconfig.json', json: false, graph: false, mermaid: false });
  });

  it('parses --json', () => {
    expect(parseArgs(['--json'])).toEqual({ project: undefined, json: true, graph: false, mermaid: false });
  });

  it('parses --project and --json together, in either order', () => {
    expect(parseArgs(['--json', '--project', 'a.json'])).toEqual({ project: 'a.json', json: true, graph: false, mermaid: false });
    expect(parseArgs(['--project', 'a.json', '--json'])).toEqual({ project: 'a.json', json: true, graph: false, mermaid: false });
  });

  it('defaults to no project override and non-json when nothing is passed', () => {
    expect(parseArgs([])).toEqual({ project: undefined, json: false, graph: false, mermaid: false });
  });
});

describe('CLI report — buildJsonReport', () => {
  const createProgram = (fileName: string, fileContent: string) => {
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;
    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) return ts.createSourceFile(fileName, fileContent, languageVersion);
      return originalGetSourceFile(name, languageVersion);
    };
    return ts.createProgram([fileName], {}, compilerHost);
  };

  it('reports ok: true and an empty errors array when there are no errors', () => {
    const report = buildJsonReport([], '/project');
    expect(report).toEqual({ ok: true, errorCount: 0, errors: [] });
  });

  it('reports ok: false with structured file/line/column/type/message per error', () => {
    const fileName = '/project/container.ts';
    const source = `
      class Repository {}
      class UserService {
        constructor(private repo: Repository) {}
      }
      export const partial = definePartialConfig({
        injections: [{ token: UserService }]
      });
    `;
    const program = createProgram(fileName, source);
    const analyzer = new Analyzer(program);
    const errors = analyzer.extractAllErrors();
    expect(errors.length).toBeGreaterThan(0);

    const report = buildJsonReport(errors, '/project');
    expect(report.ok).toBe(false);
    expect(report.errorCount).toBe(errors.length);
    expect(report.errors[0]).toMatchObject({
      file: 'container.ts', // relative to cwd
      type: 'missing',
    });
    expect(report.errors[0].line).toBeGreaterThan(0);
    expect(report.errors[0].column).toBeGreaterThan(0);
    expect(report.errors[0].message).toContain('Repository');
  });
});
