import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

describe('Analyzer - External Bindings (useContainer)', () => {
  it('should parse parent container and resolve dependencies from it', () => {
      const fileName = 'external-test.ts';
      const fileContent = `
        import { defineBuilderConfig, declareContainerTokens } from '@djodjonx/neosyringe';

        class SharedKernel {}
        class FeatureService { constructor(k: SharedKernel) {} }

        const parentContainer = {};

        const parent = declareContainerTokens<{
          SharedKernel: SharedKernel;
        }>(parentContainer);

        export const container = defineBuilderConfig({
          useContainer: parent,
          injections: [
            { token: FeatureService }
          ]
        });
      `;

      const compilerHost = ts.createCompilerHost({});
      const originalGetSourceFile = compilerHost.getSourceFile;

      compilerHost.getSourceFile = (name, languageVersion) => {
          if (name === fileName) {
              return ts.createSourceFile(fileName, fileContent, languageVersion);
          }
          return originalGetSourceFile(name, languageVersion);
      };

      const program = ts.createProgram([fileName], {}, compilerHost);
      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      // 1. Verify SharedKernel is in parent provided tokens
      expect(graph.parentProvidedTokens).toBeDefined();
      const hasSharedKernel = Array.from(graph.parentProvidedTokens!).some(t => t.includes('SharedKernel'));
      expect(hasSharedKernel).toBe(true);

      // 2. Verify FeatureService is in graph
      const featureNode = Array.from(graph.nodes.keys()).find(k => k.includes('FeatureService'));
      expect(featureNode).toBeDefined();

      // 3. Verify legacy containers is set
      expect(graph.legacyContainers).toBeDefined();
      expect(graph.legacyContainers!.length).toBeGreaterThan(0);
  });
});

