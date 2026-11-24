/** AST check: a comment may say "any". An explicit unsafe type or a suppression may not. */
export function assertNoUnsafeTypes(ts, source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) throw new Error(`invalid TypeScript: ${filename}`);
  const failures = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) failures.push(`unsafe type at ${node.getStart(file)}`);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      let inner = node.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (
        (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner))
        && inner.type.kind === ts.SyntaxKind.UnknownKeyword
      ) {
        failures.push(`double assertion through unknown at ${node.getStart(file)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia)
      && /@ts-(ignore|nocheck)\b/.test(scanner.getTokenText())
    ) {
      failures.push('type-check suppression');
    }
  }
  if (failures.length) throw new Error(`${filename}: ${failures.join(', ')}`);
}
