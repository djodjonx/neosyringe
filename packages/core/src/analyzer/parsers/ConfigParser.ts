import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type { AnalysisError, DependencyGraph, DependencyNode, RetentionReason, ScopeInput, TokenId, ValidationMode } from '../types';
import { getSimpleName } from '../utils/TokenUtils';

/*
 * Reading of the literal `optimization` and `runtime` blocks, and retention.
 * Discovery of builders and partials lives in ConfigCollector; the graph is built from its output
 * by graphAdapter.ts.
 */

const RETENTION_RANK: Record<RetentionReason['kind'], number> = {
  root: 5,
  eager: 4,
  'multi-contribution-of': 3,
  'dependency-of': 2,
  'parent-boundary': 1,
  unreachable: 0,
};

export interface OptimizationTarget {
  optimizationMode?: 'open' | 'closed';
  publicRoots?: TokenId[];
  publicMultiRoots?: TokenId[];
  eagerRoots?: TokenId[];
  runtimeProfile?: 'full' | 'minimal';
  initializationConcurrency?: number;
  scopeInputs?: ScopeInput[];
  errors?: AnalysisError[];
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    TSContext.ts.isAsExpression(current)
    || TSContext.ts.isParenthesizedExpression(current)
    || TSContext.ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function namedInitializer(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (!prop.name || !TSContext.ts.isIdentifier(prop.name) || prop.name.text !== name) continue;
    if (TSContext.ts.isPropertyAssignment(prop)) return prop.initializer;
    if (TSContext.ts.isShorthandPropertyAssignment(prop)) return prop.name;
  }
  return undefined;
}

function pushConfigError(target: OptimizationTarget, error: AnalysisError): void {
  if (!target.errors) target.errors = [];
  target.errors.push(error);
}

/**
 * Literal optimization only. A resolve() call in the file is not a root.
 * ADR006 lines 9-14. 04-api-et-diagnostics.md line 202.
 */
export function readOptimization(
  configObj: ts.ObjectLiteralExpression,
  target: OptimizationTarget,
  known: ReadonlySet<TokenId>,
  resolve: (expr: ts.Expression) => TokenId | null,
  aliases: ReadonlySet<TokenId> = new Set(),
): void {
  const optimization = namedInitializer(configObj, 'optimization');
  if (!optimization) return;
  const sourceFile = configObj.getSourceFile();
  const body = unwrapExpression(optimization);
  if (!TSContext.ts.isObjectLiteralExpression(body)) {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: "NEO_CONFIG_UNSUPPORTED: optimization roots must be a literal array of tokens or { all: token }.",
      node: optimization,
      sourceFile,
    });
    return;
  }
  const modeNode = namedInitializer(body, 'mode');
  const modeExpr = modeNode ? unwrapExpression(modeNode) : undefined;
  if (modeNode && !(modeExpr && TSContext.ts.isStringLiteral(modeExpr))) {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: "NEO_CONFIG_UNSUPPORTED: optimization mode must be the string literal 'open' or 'closed'.",
      node: modeNode,
      sourceFile,
    });
    return;
  }
  const modeText = modeExpr && TSContext.ts.isStringLiteral(modeExpr) ? modeExpr.text : undefined;
  if (modeText !== undefined && modeText !== 'open' && modeText !== 'closed') {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: `NEO_CONFIG_UNSUPPORTED: optimization mode '${modeText}' is not supported.`,
      node: modeNode ?? body,
      sourceFile,
    });
    return;
  }
  const mode = modeText === 'closed' ? 'closed' : 'open';
  const rootsNode = namedInitializer(body, 'roots');
  const eagerNode = namedInitializer(body, 'eager');
  if (mode === 'open' && (rootsNode || eagerNode)) {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: "NEO_CONFIG_UNSUPPORTED: optimization mode 'open' cannot declare roots or eager.",
      node: rootsNode ?? eagerNode ?? body,
      sourceFile,
    });
    return;
  }
  if (mode === 'open') {
    target.optimizationMode = 'open';
    return;
  }
  const roots = readRootList(rootsNode, known, resolve, sourceFile, target);
  const eager = readRootList(eagerNode, known, resolve, sourceFile, target, aliases);
  if (!roots) return;
  target.optimizationMode = 'closed';
  target.publicRoots = roots.filter((item) => !item.all).map((item) => item.id);
  target.publicMultiRoots = roots.filter((item) => item.all).map((item) => item.id);
  target.eagerRoots = (eager ?? []).map((item) => item.id);
}

/** `name` and `'name'` are the same property. Anything else is not a literal name. */
function literalPropertyName(name: ts.PropertyName): string | undefined {
  if (TSContext.ts.isIdentifier(name) || TSContext.ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/**
 * Initializer of `name` in an object literal. A spread or computed member could hide the
 * property, so it is reported as `opaque` instead of being skipped.
 */
function literalMember(
  obj: ts.ObjectLiteralExpression,
  name: string,
): { initializer?: ts.Expression; opaque?: ts.Node } {
  let initializer: ts.Expression | undefined;
  for (const prop of obj.properties) {
    if (TSContext.ts.isSpreadAssignment(prop)) return { opaque: prop };
    if (!prop.name) continue;
    if (TSContext.ts.isComputedPropertyName(prop.name)) return { opaque: prop };
    if (literalPropertyName(prop.name) !== name) continue;
    if (TSContext.ts.isPropertyAssignment(prop)) initializer = prop.initializer;
    else if (TSContext.ts.isShorthandPropertyAssignment(prop)) initializer = prop.name;
    else return { opaque: prop };
  }
  return { initializer };
}

/**
 * Literal `runtime.profile` only. Absent or `undefined` (for `runtime` or `profile`) is the
 * full profile. 04-api-et-diagnostics.md "BuilderConfig et profils".
 */
export function readRuntimeProfile(
  configObj: ts.ObjectLiteralExpression,
  target: OptimizationTarget,
): void {
  const runtime = literalMember(configObj, 'runtime').initializer;
  if (!runtime) return;
  const sourceFile = configObj.getSourceFile();
  const body = unwrapExpression(runtime);
  const unsupported = (node: ts.Node, message: string): void => {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message,
      node,
      sourceFile,
    });
  };
  const profileMessage = "NEO_CONFIG_UNSUPPORTED: runtime.profile must be the string literal 'full' or 'minimal'.";
  if (TSContext.ts.isIdentifier(body) && body.text === 'undefined') return;
  if (!TSContext.ts.isObjectLiteralExpression(body)) {
    unsupported(runtime, profileMessage);
    return;
  }
  const member = literalMember(body, 'profile');
  if (member.opaque) {
    unsupported(member.opaque, 'NEO_CONFIG_UNSUPPORTED: runtime must be an object literal without spread or computed members.');
    return;
  }
  const profileNode = member.initializer;
  if (!profileNode) return;
  const profile = unwrapExpression(profileNode);
  if (TSContext.ts.isIdentifier(profile) && profile.text === 'undefined') return;
  if (!TSContext.ts.isStringLiteral(profile) || (profile.text !== 'full' && profile.text !== 'minimal')) {
    unsupported(profileNode, profileMessage);
    return;
  }
  target.runtimeProfile = profile.text;
}

const INITIALIZATION_MESSAGE = 'NEO_CONFIG_UNSUPPORTED: initialization.concurrency must be a positive integer literal';

/** `initialization` of a partial. The type refuses it too (`PartialConfig` has no such member). */
export const PARTIAL_INITIALIZATION_MESSAGE =
  'NEO_CONFIG_UNSUPPORTED: initialization is not supported in a partial config: declare it on the builder.';

/**
 * Literal `initialization.concurrency` only: a positive integer literal, in an object literal with no spread or computed
 * member. Absent, or `undefined` (for `initialization` or `concurrency`), is the sequential default. Anything else is
 * `NEO_CONFIG_UNSUPPORTED` at the position of what is wrong: zero, a negative number (a prefix expression), a number
 * with a fraction or beyond the safe integers, a variable, a string, a spread or computed member, an `initialization` that
 * is not an object literal. The value is read at build time: it is never an argument of `initialize()`.
 */
export function readInitialization(
  configObj: ts.ObjectLiteralExpression,
  target: OptimizationTarget,
): void {
  const initialization = literalMember(configObj, 'initialization').initializer;
  if (!initialization) return;
  const sourceFile = configObj.getSourceFile();
  const unsupported = (node: ts.Node, reason: string): void => {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: `${INITIALIZATION_MESSAGE}: ${reason}.`,
      node,
      sourceFile,
    });
  };
  const body = unwrapExpression(initialization);
  if (TSContext.ts.isIdentifier(body) && body.text === 'undefined') return;
  if (!TSContext.ts.isObjectLiteralExpression(body)) {
    unsupported(initialization, 'initialization must be an object literal');
    return;
  }
  const member = literalMember(body, 'concurrency');
  if (member.opaque) {
    unsupported(member.opaque, 'initialization must be an object literal without spread or computed members');
    return;
  }
  const valueNode = member.initializer;
  if (!valueNode) return;
  const value = unwrapExpression(valueNode);
  if (TSContext.ts.isIdentifier(value) && value.text === 'undefined') return;
  if (!TSContext.ts.isNumericLiteral(value)) {
    unsupported(valueNode, 'a number literal is required');
    return;
  }
  const count = Number(value.text);
  if (!Number.isSafeInteger(count) || count < 1) {
    unsupported(valueNode, 'the number must be an integer of at least 1');
    return;
  }
  target.initializationConcurrency = count;
}

const SCOPE_INPUTS_MESSAGE =
  'NEO_CONFIG_UNSUPPORTED: scopeInputs must be a literal list of useInterface<T>() or useProperty(...) tokens.';

/** The message of an input that is an object: `{ token, multi }` is the form of a registration, not of an input. */
const SCOPE_INPUT_OBJECT_MESSAGE =
  'NEO_CONFIG_UNSUPPORTED: a scope input is a token, not an object: an input is never multi and has no option.';

/** `scopeInputs` of a partial. The type refuses it too (`PartialConfig` has no such member). */
export const PARTIAL_SCOPE_INPUTS_MESSAGE =
  'NEO_CONFIG_UNSUPPORTED: scopeInputs is not supported in a partial config in this version: declare it on the builder.';

/**
 * Literal `scopeInputs` only: an array literal with no spread whose elements are `useInterface<T>()` or
 * `useProperty(...)` tokens. A list that is not literal, a class token and an object element (`{ token, multi }`)
 * are `NEO_CONFIG_UNSUPPORTED`, each at its own position. A token listed twice, and a token a local or a folded
 * registration also provides, are duplicates: the second input, or the registration, is the position. The entries
 * that are refused are not inputs. `classify` answers the token id of an interface or property token, `undefined`
 * for anything else. `registered` maps each token a registration provides to the registration.
 */
export function readScopeInputs(
  configObj: ts.ObjectLiteralExpression,
  target: OptimizationTarget,
  classify: (expr: ts.Expression) => TokenId | undefined,
  registered: ReadonlyMap<TokenId, ts.Node>,
): void {
  const initializer = literalMember(configObj, 'scopeInputs').initializer;
  if (!initializer) return;
  const sourceFile = configObj.getSourceFile();
  const list = unwrapExpression(initializer);
  if (!TSContext.ts.isArrayLiteralExpression(list) || list.elements.some((element) => TSContext.ts.isSpreadElement(element))) {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: SCOPE_INPUTS_MESSAGE,
      node: initializer,
      sourceFile,
    });
    return;
  }
  const inputs: ScopeInput[] = [];
  const seen = new Set<TokenId>();
  for (const element of list.elements) {
    const expr = unwrapExpression(element);
    const tokenId = classify(expr);
    if (tokenId === undefined) {
      pushConfigError(target, {
        type: 'unsupported',
        code: 'NEO_CONFIG_UNSUPPORTED',
        message: TSContext.ts.isObjectLiteralExpression(expr) ? SCOPE_INPUT_OBJECT_MESSAGE : SCOPE_INPUTS_MESSAGE,
        node: element,
        sourceFile,
      });
      continue;
    }
    if (seen.has(tokenId)) {
      pushConfigError(target, {
        type: 'duplicate',
        code: 'NEO_DUPLICATE_PROVIDER',
        message: `Duplicate scope input: '${getSimpleName(tokenId)}' is already declared in scopeInputs.`,
        node: element,
        sourceFile,
      });
      continue;
    }
    seen.add(tokenId);
    const registration = registered.get(tokenId);
    if (registration) {
      pushConfigError(target, {
        type: 'duplicate',
        code: 'NEO_DUPLICATE_PROVIDER',
        message: `Duplicate registration: '${getSimpleName(tokenId)}' is a scope input, and this registration provides it too.`,
        node: registration,
        sourceFile: registration.getSourceFile(),
      });
      continue;
    }
    inputs.push({ tokenId, slot: inputs.length, node: element });
  }
  if (inputs.length > 0) target.scopeInputs = inputs;
}

function readRootList(
  node: ts.Expression | undefined,
  known: ReadonlySet<TokenId>,
  resolve: (expr: ts.Expression) => TokenId | null,
  sourceFile: ts.SourceFile,
  target: OptimizationTarget,
  aliases: ReadonlySet<TokenId> = new Set(),
): Array<{ id: TokenId; all: boolean }> | undefined {
  if (!node) return undefined;
  const list = unwrapExpression(node);
  if (!TSContext.ts.isArrayLiteralExpression(list)) {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: 'NEO_CONFIG_UNSUPPORTED: optimization roots must be a literal array of tokens or { all: token }.',
      node,
      sourceFile,
    });
    return undefined;
  }
  const refs: Array<{ id: TokenId; all: boolean }> = [];
  for (const element of list.elements) {
    if (TSContext.ts.isSpreadElement(element)) {
      pushConfigError(target, {
        type: 'unsupported',
        code: 'NEO_CONFIG_UNSUPPORTED',
        message: 'NEO_CONFIG_UNSUPPORTED: optimization roots must be a literal array of tokens or { all: token }.',
        node: element,
        sourceFile,
      });
      return undefined;
    }
    const ref = readOneRoot(element, resolve);
    if (!ref) {
      pushConfigError(target, {
        type: 'unsupported',
        code: 'NEO_CONFIG_UNSUPPORTED',
        message: 'NEO_CONFIG_UNSUPPORTED: optimization roots must be a literal array of tokens or { all: token }.',
        node: element,
        sourceFile,
      });
      return undefined;
    }
    if (!known.has(ref.id)) {
      pushConfigError(target, {
        type: 'missing',
        code: 'NEO_MISSING_PROVIDER',
        message: `NEO_MISSING_PROVIDER: root '${getSimpleName(ref.id)}' is not registered.`,
        node: element,
        sourceFile,
      });
      continue;
    }
    // An alias is not built by the container: it has no provider an eager root could construct. List its target.
    if (!ref.all && aliases.has(ref.id)) {
      pushConfigError(target, {
        type: 'unsupported',
        code: 'NEO_CONFIG_UNSUPPORTED',
        message: `NEO_CONFIG_UNSUPPORTED: eager root '${getSimpleName(ref.id)}' is an alias (useExisting): an alias builds nothing, so list the target in eager instead.`,
        node: element,
        sourceFile,
      });
      continue;
    }
    refs.push(ref);
  }
  return refs;
}

function readOneRoot(
  element: ts.Expression,
  resolve: (expr: ts.Expression) => TokenId | null,
): { id: TokenId; all: boolean } | undefined {
  const expr = unwrapExpression(element);
  if (TSContext.ts.isObjectLiteralExpression(expr)) {
    const allNode = namedInitializer(expr, 'all');
    if (!allNode || expr.properties.length !== 1) return undefined;
    const id = resolve(unwrapExpression(allNode));
    return id ? { id, all: true } : undefined;
  }
  const id = resolve(expr);
  return id ? { id, all: false } : undefined;
}

export function opaqueFactoryNames(graph: DependencyGraph): string[] {
  const names: string[] = [];
  const visit = (node: DependencyNode) => {
    if (node.service.opaque === true) names.push(getSimpleName(node.service.tokenId));
  };
  for (const node of graph.nodes.values()) visit(node);
  if (graph.multiNodes) {
    for (const nodes of graph.multiNodes.values()) nodes.forEach(visit);
  }
  return names;
}

/** Closed rejects compatible mode and opaque factories. ADR002 line 29. ADR006 line 57. */
export function closedModeDiagnostics(
  mode: 'open' | 'closed' | undefined,
  validation: ValidationMode,
  opaqueNames: readonly string[],
  node: ts.Node,
  sourceFile: ts.SourceFile,
): AnalysisError[] {
  if (mode !== 'closed') return [];
  const errors: AnalysisError[] = [];
  if (validation === 'compatible') {
    errors.push({
      type: 'unsupported',
      code: 'NEO_CLOSED_REQUIRES_STRICT',
      severity: 'error',
      message: "NEO_CLOSED_REQUIRES_STRICT: closed mode requires validation: 'strict'.",
      node,
      sourceFile,
    });
  }
  for (const name of opaqueNames) {
    errors.push({
      type: 'unsupported',
      code: 'NEO_FACTORY_DEPENDENCIES_REQUIRED',
      severity: 'error',
      message: `NEO_FACTORY_DEPENDENCIES_REQUIRED: factory '${name}' is opaque; closed mode requires a dependencies list.`,
      node,
      sourceFile,
    });
  }
  return errors;
}

function registrationKey(node: DependencyNode, tokenId: TokenId): string {
  return node.service.registrationId ?? tokenId;
}

function remember(reasons: Map<string, RetentionReason>, key: string, next: RetentionReason): void {
  const current = reasons.get(key);
  if (!current || RETENTION_RANK[next.kind] > RETENTION_RANK[current.kind]) reasons.set(key, next);
}

function markBoundary(graph: DependencyGraph, reasons: Map<string, RetentionReason>): void {
  for (const [tokenId, node] of graph.nodes) remember(reasons, registrationKey(node, tokenId), { kind: 'parent-boundary' });
  if (!graph.multiNodes) return;
  for (const [tokenId, nodes] of graph.multiNodes) {
    for (const node of nodes) remember(reasons, registrationKey(node, tokenId), { kind: 'parent-boundary' });
  }
}

function retainClosed(graph: DependencyGraph, reasons: Map<string, RetentionReason>): void {
  seedClosed(graph, reasons);
}

function seedClosed(graph: DependencyGraph, reasons: Map<string, RetentionReason>): void {
  for (const id of graph.publicRoots ?? []) markRoot(graph, reasons, id);
  for (const id of graph.publicMultiRoots ?? []) {
    const nodes = graph.multiNodes?.get(id) ?? [];
    for (const node of nodes) remember(reasons, registrationKey(node, id), { kind: 'root' });
  }
  for (const id of graph.eagerRoots ?? []) markEager(graph, reasons, id);
  const pending: Array<{ tokenId: TokenId; node: DependencyNode }> = [];
  for (const [tokenId, node] of graph.nodes) {
    const reason = reasons.get(registrationKey(node, tokenId));
    if (reason && reason.kind !== 'unreachable') pending.push({ tokenId, node });
  }
  if (graph.multiNodes) {
    for (const [tokenId, nodes] of graph.multiNodes) {
      for (const node of nodes) {
        const reason = reasons.get(registrationKey(node, tokenId));
        if (reason && reason.kind !== 'unreachable') pending.push({ tokenId, node });
      }
    }
  }
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    const mark = registrationKey(current.node, current.tokenId);
    if (seen.has(mark)) continue;
    seen.add(mark);
    followOne(graph, reasons, pending, current.node);
  }
  for (const [tokenId, node] of graph.nodes) {
    const key = registrationKey(node, tokenId);
    if (!reasons.has(key)) remember(reasons, key, { kind: 'unreachable' });
  }
  if (!graph.multiNodes) return;
  for (const [tokenId, nodes] of graph.multiNodes) {
    for (const node of nodes) {
      const key = registrationKey(node, tokenId);
      if (!reasons.has(key)) remember(reasons, key, { kind: 'unreachable' });
    }
  }
}

function markRoot(graph: DependencyGraph, reasons: Map<string, RetentionReason>, id: TokenId): void {
  const node = graph.nodes.get(id);
  if (node) remember(reasons, registrationKey(node, id), { kind: 'root' });
}

function markEager(graph: DependencyGraph, reasons: Map<string, RetentionReason>, id: TokenId): void {
  const node = graph.nodes.get(id);
  if (node) remember(reasons, registrationKey(node, id), { kind: 'eager' });
  const nodes = graph.multiNodes?.get(id);
  if (!nodes) return;
  for (const item of nodes) remember(reasons, registrationKey(item, id), { kind: 'eager' });
}

function followOne(
  graph: DependencyGraph,
  reasons: Map<string, RetentionReason>,
  pending: Array<{ tokenId: TokenId; node: DependencyNode }>,
  node: DependencyNode,
): void {
  const requester = node.service.tokenId;
  const seenDeps = new Set<TokenId>();
  for (const dep of node.service.factoryDependencies ?? []) {
    seenDeps.add(dep.tokenId);
    retainDependency(graph, reasons, pending, requester, dep.tokenId, dep.all);
  }
  for (const depId of node.dependencies) {
    if (seenDeps.has(depId)) continue;
    retainDependency(graph, reasons, pending, requester, depId, false);
  }
}

function retainDependency(
  graph: DependencyGraph,
  reasons: Map<string, RetentionReason>,
  pending: Array<{ tokenId: TokenId; node: DependencyNode }>,
  requester: TokenId,
  depId: TokenId,
  all: boolean,
): void {
  const multi = graph.multiNodes?.get(depId);
  if (all || multi) {
    for (const contribution of multi ?? []) {
      const key = registrationKey(contribution, depId);
      const before = reasons.get(key)?.kind;
      remember(reasons, key, { kind: 'multi-contribution-of', token: requester });
      if (reasons.get(key)?.kind !== before) pending.push({ tokenId: depId, node: contribution });
      else if (!before) pending.push({ tokenId: depId, node: contribution });
    }
  }
  const simple = graph.nodes.get(depId);
  if (!simple || all) return;
  const key = registrationKey(simple, depId);
  const before = reasons.get(key)?.kind;
  remember(reasons, key, { kind: 'dependency-of', token: requester });
  if (!before || reasons.get(key)?.kind !== before) pending.push({ tokenId: depId, node: simple });
}

/** One reason per registration. Open is a conservative boundary. ADR006 lines 16-24 and 47-50. */
export function assignRetention(graph: DependencyGraph): void {
  const reasons = new Map<string, RetentionReason>();
  if (graph.optimizationMode !== 'closed') {
    // Absent mode is sealed back to a boundary. Explicit open is already one.
    markBoundary(graph, reasons);
  } else {
    retainClosed(graph, reasons);
  }
  graph.retention = reasons;
}

/**
 * The boundary reason is written by {@link assignRetention}. Nothing is rewritten here.
 * ADR006 line 49.
 */
export function sealOpenParent(graph: DependencyGraph): void {
  if (graph.optimizationMode === 'closed' || graph.optimizationMode === 'open') return;
}

/** Tokens a closed container exports. Eager ids are not included. ADR006 lines 29-31. */
export function exportedRootIds(graph: DependencyGraph): { single: TokenId[]; multi: TokenId[] } {
  const single = graph.publicRoots ?? [];
  const multi = graph.publicMultiRoots ?? [];
  return { single: [...single], multi: [...multi] };
}
