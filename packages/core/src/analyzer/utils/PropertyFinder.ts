import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';

/**
 * Finds a named property assignment inside an object literal expression.
 * Returns `undefined` if the property is not found or is not an assignment.
 */
export function findProperty(
  obj: ts.ObjectLiteralExpression,
  name: string
): ts.PropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (
      TSContext.ts.isPropertyAssignment(prop) &&
      TSContext.ts.isIdentifier(prop.name) &&
      prop.name.text === name
    ) {
      return prop;
    }
  }
  return undefined;
}

/**
 * Returns `true` if the object literal contains a named property assignment.
 */
export function hasProperty(obj: ts.ObjectLiteralExpression, name: string): boolean {
  return findProperty(obj, name) !== undefined;
}

/**
 * Finds the `token` property assignment inside an injection object literal.
 * Returns the `PropertyAssignment` (not just the value) so the node is always
 * in the current source file — never a node from an imported declaration.
 */
export function findTokenAssignment(node: ts.Node): ts.PropertyAssignment | undefined {
  if (!TSContext.ts.isObjectLiteralExpression(node)) return undefined;
  return findProperty(node, 'token');
}
