import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function packageDir(name: string): string {
  return path.join(root, 'packages', name);
}

function collectJs(dir: string, suffix: string, found: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJs(full, suffix, found);
    else if (entry.name.endsWith(suffix)) found.push(full);
  }
}

function publishedJs(dir: string): { esm: string[]; cjs: string[] } {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { files?: unknown };
  const files = Array.isArray(pkg.files) ? pkg.files.filter((item): item is string => typeof item === 'string') : [];
  if (!files.includes('dist')) throw new Error(`${dir} does not publish dist`);
  const esm: string[] = [];
  const cjs: string[] = [];
  collectJs(path.join(dir, 'dist'), '.mjs', esm);
  collectJs(path.join(dir, 'dist'), '.cjs', cjs);
  return { esm, cjs };
}

function isRequireCall(node: ts.Node): boolean {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'require';
}

function initializerCalls(statement: ts.VariableStatement): boolean {
  let call = false;
  const visit = (node: ts.Node): void => {
    if (call) return;
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (isRequireCall(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      call = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const declaration of statement.declarationList.declarations) {
    if (declaration.initializer) visit(declaration.initializer);
  }
  return call;
}

function isExportsAssign(statement: ts.ExpressionStatement): boolean {
  const expr = statement.expression;
  if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const left = expr.left;
  if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === 'exports') return true;
  return ts.isElementAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === 'exports';
}

function isDefinePropertyExports(statement: ts.ExpressionStatement): boolean {
  const expr = statement.expression;
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return false;
  const callee = expr.expression;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'Object' || callee.name.text !== 'defineProperty') return false;
  const target = expr.arguments[0];
  return target !== undefined && ts.isIdentifier(target) && target.text === 'exports';
}

/** Top-level statements that run on import. Import, export and declarations are allowed. */
function topLevelEffects(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const found: string[] = [];
  for (const statement of source.statements) {
    const allowed = ts.isImportDeclaration(statement)
      || ts.isExportDeclaration(statement)
      || ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement)
      || ts.isEmptyStatement(statement)
      || ts.isNotEmittedStatement(statement)
      || (ts.isVariableStatement(statement) && !initializerCalls(statement))
      || (ts.isExpressionStatement(statement) && (isExportsAssign(statement) || isDefinePropertyExports(statement)));
    if (allowed) continue;
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
    found.push(`${path.basename(file)}:${line}`);
  }
  return found;
}

describe('published sideEffects audit', () => {
  it('runtime ESM has no top-level executable statement', () => {
    const dir = packageDir('neosyringe');
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { sideEffects?: unknown };
    expect(pkg.sideEffects).toBe(false);
    const published = publishedJs(dir);
    expect(published.esm.length).toBeGreaterThan(0);
    expect(published.cjs.length).toBeGreaterThan(0);
    for (const file of [...published.esm, ...published.cjs]) {
      const text = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
      expect(source.statements.length).toBeGreaterThan(0);
    }
    for (const file of [...published.esm, ...published.cjs]) {
      expect(topLevelEffects(file)).toEqual([]);
    }
  });

  it('a package that calls createUnplugin at import does not set sideEffects false', () => {
    const dir = packageDir('unplugin');
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { sideEffects?: unknown };
    const calls = publishedJs(dir).esm.flatMap((file) => topLevelEffects(file));
    expect(calls.length).toBeGreaterThan(0);
    expect(pkg.sideEffects).not.toBe(false);
  });
});
