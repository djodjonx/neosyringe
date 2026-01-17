import { describe, it, expect, vi, beforeEach } from 'vitest';
import init from '../src/index';
import * as ts from 'typescript';

// Partial mocks
vi.mock('@djodjonx/neosyringe-core/analyzer/Analyzer', () => {
  return {
    Analyzer: vi.fn().mockImplementation(() => ({
      extract: vi.fn().mockReturnValue({ nodes: new Map(), roots: [] })
    }))
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
});

