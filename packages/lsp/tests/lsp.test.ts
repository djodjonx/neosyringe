import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import init from '../src/index';
import * as ts from 'typescript';
import { TSContext } from '../../core/src/TSContext';

// Partial mocks
vi.mock('../../core/src/analyzer/index.ts', () => {
  class DuplicateRegistrationError extends Error {
    fileName: string;
    line: number;
    character: number;
    endOffset: number;
    constructor(message: string, node: any, sourceFile: any) {
      super(message);
      this.name = 'DuplicateRegistrationError';
      this.fileName = sourceFile?.fileName ?? '';
      this.line = 0;
      this.character = 0;
      this.endOffset = node?.getEnd?.() ?? 0;
    }
  }

  class TypeMismatchError extends Error {
    fileName: string;
    line: number;
    character: number;
    endOffset: number;
    constructor(message: string, node: any, sourceFile: any) {
      super(message);
      this.name = 'TypeMismatchError';
      this.fileName = sourceFile?.fileName ?? '';
      this.line = 0;
      this.character = 0;
      this.endOffset = node?.getEnd?.() ?? 0;
    }
  }

  return {
    Analyzer: vi.fn().mockImplementation(() => ({
      extract: vi.fn().mockReturnValue({ nodes: new Map(), roots: [] })
    })),
    DuplicateRegistrationError,
    TypeMismatchError
  };
});

describe('LSP Plugin', () => {
  let languageServiceMock: any;
  let pluginFactory: any;

  beforeEach(() => {
    vi.clearAllMocks();

    languageServiceMock = {
      getSemanticDiagnostics: vi.fn().mockReturnValue([]),
      getProgram: vi.fn(),
    };

    const modules = { typescript: ts };
    pluginFactory = init(modules);
  });

  it('should create a proxy language service', () => {
    const proxy = pluginFactory.create({ languageService: languageServiceMock } as any);
    expect(proxy).toBeDefined();
    expect(proxy.getSemanticDiagnostics).toBeDefined();
  });

  it('should pass through diagnostics if no program', () => {
    languageServiceMock.getProgram.mockReturnValue(undefined);

    const proxy = pluginFactory.create({ languageService: languageServiceMock } as any);
    const diags = proxy.getSemanticDiagnostics('file.ts');

    expect(diags).toEqual([]);
    expect(languageServiceMock.getSemanticDiagnostics).toHaveBeenCalledWith('file.ts');
  });

  it('should analyze file if it contains defineBuilderConfig', () => {
    const mockSourceFile = {
      getText: () => 'defineBuilderConfig({})',
      fileName: 'file.ts',
      isDeclarationFile: false,
    };

    const mockProgram = {
      getSourceFile: () => mockSourceFile,
      getSourceFiles: () => [mockSourceFile],
      getTypeChecker: () => ({}),
    };

    languageServiceMock.getProgram.mockReturnValue(mockProgram);

    const proxy = pluginFactory.create({ languageService: languageServiceMock } as any);
    proxy.getSemanticDiagnostics('file.ts');

    expect(languageServiceMock.getSemanticDiagnostics).toHaveBeenCalled();
  });

  it('should skip analysis if defineBuilderConfig is missing', () => {
      const mockSourceFile = {
        getText: () => 'const x = 1;',
        fileName: 'file.ts',
      };

      const mockProgram = {
        getSourceFile: () => mockSourceFile,
      };

      languageServiceMock.getProgram.mockReturnValue(mockProgram);

      const proxy = pluginFactory.create({ languageService: languageServiceMock } as any);
      proxy.getSemanticDiagnostics('file.ts');

      // Should exit early
      expect(languageServiceMock.getSemanticDiagnostics).toHaveBeenCalled();
  });

  describe('TSContext.projectRoot wiring', () => {
    const originalProjectRoot = (TSContext as any)._projectRoot;

    afterEach(() => {
      (TSContext as any)._projectRoot = originalProjectRoot;
    });

    it('should set TSContext.projectRoot from project.getCurrentDirectory()', () => {
      pluginFactory.create({
        languageService: languageServiceMock,
        project: { getCurrentDirectory: () => '/my/project' },
      } as any);

      expect(TSContext.projectRoot).toBe('/my/project');
    });

    it('should not set TSContext.projectRoot when project is absent', () => {
      (TSContext as any)._projectRoot = undefined;
      pluginFactory.create({ languageService: languageServiceMock } as any);

      // Falls back to process.cwd() — projectRoot must equal process.cwd()
      expect(TSContext.projectRoot).toBe(process.cwd());
    });
  });
});

