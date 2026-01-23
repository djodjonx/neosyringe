import { describe, it, expect } from 'vitest';
import { CallExpressionUtils } from '../../src/analyzer/utils/CallExpressionUtils';
import * as ts from 'typescript';

describe('CallExpressionUtils', () => {
  /**
   * Helper to create a call expression from source code
   */
  function createCallExpression(code: string): ts.CallExpression | null {
    const sourceFile = ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true);
    let callExpr: ts.CallExpression | null = null;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        callExpr = node;
        return;
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return callExpr;
  }

  describe('isDefineBuilderConfig', () => {
    it('should return true for defineBuilderConfig call', () => {
      const code = `defineBuilderConfig({ name: 'App', injections: [] })`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isDefineBuilderConfig(callExpr!)).toBe(true);
    });

    it('should return false for other calls', () => {
      const code = `definePartialConfig({ injections: [] })`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isDefineBuilderConfig(callExpr!)).toBe(false);
    });

    it('should return false for non-identifier expressions', () => {
      const code = `obj.method()`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isDefineBuilderConfig(callExpr!)).toBe(false);
    });
  });

  describe('isDefinePartialConfig', () => {
    it('should return true for definePartialConfig call', () => {
      const code = `definePartialConfig({ injections: [] })`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isDefinePartialConfig(callExpr!)).toBe(true);
    });

    it('should return false for other calls', () => {
      const code = `defineBuilderConfig({ name: 'App' })`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isDefinePartialConfig(callExpr!)).toBe(false);
    });
  });

  describe('isDeclareContainerTokens', () => {
    it('should return true for declareContainerTokens call', () => {
      const code = `declareContainerTokens<{ ILogger: ILogger }>()`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isDeclareContainerTokens(callExpr!)).toBe(true);
    });

    it('should return false for other calls', () => {
      const code = `defineBuilderConfig({ name: 'App' })`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isDeclareContainerTokens(callExpr!)).toBe(false);
    });
  });

  describe('isConfigCall', () => {
    it('should return true for defineBuilderConfig', () => {
      const code = `defineBuilderConfig({ name: 'App' })`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isConfigCall(callExpr!)).toBe(true);
    });

    it('should return true for definePartialConfig', () => {
      const code = `definePartialConfig({ injections: [] })`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isConfigCall(callExpr!)).toBe(true);
    });

    it('should return true for declareContainerTokens', () => {
      const code = `declareContainerTokens<{ ILogger: ILogger }>()`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isConfigCall(callExpr!)).toBe(true);
    });

    it('should return false for other calls', () => {
      const code = `someOtherFunction()`;
      const callExpr = createCallExpression(code);

      expect(callExpr).toBeTruthy();
      expect(CallExpressionUtils.isConfigCall(callExpr!)).toBe(false);
    });
  });
});
