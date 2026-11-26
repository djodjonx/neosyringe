import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';

/**
 * The tokens of a `resolveMany` call, when the call states them.
 * `literal`: every element is written in the call (an array literal, with spreads of array literals), in call order.
 * `dynamic`: some part is not (a variable, a call, a spread of a variable, a hole), and `node` is that part.
 */
export type LiteralTokenList =
  | { readonly kind: 'literal'; readonly elements: readonly ts.Expression[] }
  | { readonly kind: 'dynamic'; readonly node: ts.Expression };

function unwrap(expression: ts.Expression): ts.Expression {
  const api = TSContext.ts;
  let current = expression;
  while (
    api.isAsExpression(current)
    || api.isSatisfiesExpression(current)
    || api.isParenthesizedExpression(current)
    || api.isTypeAssertionExpression(current)
    || api.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Does not follow variables: a `const` array can still be mutated before the call, so its text says nothing about
 * what the call resolves.
 */
export function literalTokenList(expression: ts.Expression): LiteralTokenList {
  const api = TSContext.ts;
  const array = unwrap(expression);
  if (!api.isArrayLiteralExpression(array)) return { kind: 'dynamic', node: array };
  const pending: ts.Expression[] = [...array.elements].reverse();
  const elements: ts.Expression[] = [];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (api.isOmittedExpression(current)) return { kind: 'dynamic', node: current };
    if (!api.isSpreadElement(current)) {
      elements.push(current);
      continue;
    }
    const value = unwrap(current.expression);
    if (!api.isArrayLiteralExpression(value)) return { kind: 'dynamic', node: value };
    for (let index = value.elements.length - 1; index >= 0; index -= 1) {
      const inner = value.elements[index];
      if (inner !== undefined) pending.push(inner);
    }
  }
  return { kind: 'literal', elements };
}
