import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';

export class PropertyFinder {
  static find(
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

  static has(obj: ts.ObjectLiteralExpression, name: string): boolean {
    return PropertyFinder.find(obj, name) !== undefined;
  }

  /**
   * Finds the 'token' property assignment inside an injection object literal.
   * Returns the PropertyAssignment (not just the value) so the node is always
   * in the current source file — never a node from an imported declaration.
   */
  static findTokenAssignment(node: ts.Node): ts.PropertyAssignment | undefined {
    if (!TSContext.ts.isObjectLiteralExpression(node)) return undefined;
    return PropertyFinder.find(node, 'token');
  }
}
