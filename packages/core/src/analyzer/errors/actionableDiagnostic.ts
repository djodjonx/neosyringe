import { relative } from 'node:path';
import type { AnalysisError, DiagnosticCode, DiagnosticReason } from '../types';
import { toStableDiagnostic, type ContainerLookup, type StableDiagnostic } from './stableDiagnostic';

/**
 * A diagnostic a person can act on: where it is, which stable code it has, the dependency chain that led to it
 * and one targeted fix. The CLI text, the CLI JSON and the language service plugin all start from this shape.
 */
export interface ActionableDiagnostic {
  /** The stable `NEO_*` code, or the error type when the error has no code yet. */
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  readonly message: string;
  /** The tokens from the consumer to the cause. Empty when the analyzer recorded none. */
  readonly chain: readonly string[];
  /** One fix, written from the token and the consumer of the chain. Absent when the error has no code. */
  readonly hint?: string;
}

export interface ActionableOptions {
  /** Names the owning container. Not needed for the fields of this shape. */
  readonly lookup?: ContainerLookup;
  /** When given, `file` is relative to this directory (the working directory of a CLI). */
  readonly root?: string;
}

/**
 * What a hint may name: the token the error is about, the consumer that asked for it, and the cause of the code when
 * the analyzer recorded one (`context.reason`).
 */
type HintInput = Pick<StableDiagnostic, 'token' | 'chain'> & { readonly reason?: DiagnosticReason };

function quoted(token: string | undefined, fallback: string): string {
  return token === undefined ? fallback : `'${token}'`;
}

/**
 * One fix per code, kept in step with the "Fix:" lines of docs/api/errors.md.
 * `Record<DiagnosticCode, ...>` makes a new code a compile error until it has a hint.
 */
const HINTS: Record<DiagnosticCode, (input: HintInput) => string> = {
  NEO_MISSING_PROVIDER: ({ token, chain }) => {
    const consumer = chain?.[0];
    const where = consumer === undefined ? 'this container' : `the same container as '${consumer}'`;
    return `Register ${quoted(token, 'the missing token')} in ${where}, in a parent container (useContainer) or in an extended partial.`;
  },
  NEO_CYCLE: () => 'Break the cycle: introduce an intermediate abstraction, or invert one dependency of the chain.',
  // `scoped: true` only overrides a token of the parent container: it fixes no other duplicate.
  NEO_DUPLICATE_PROVIDER: ({ token, reason }) =>
    reason === 'parent-override'
      ? `Remove the duplicate registration of ${quoted(token, 'the token')}, or add scoped: true to override the token of the parent.`
      : `Keep one declaration of ${quoted(token, 'the token')}: remove the duplicate.`,
  NEO_FACTORY_DEPENDENCIES_REQUIRED: () =>
    'Add a dependencies list to the factory: dependencies: [] when it needs nothing, else the tokens it reads from its context.',
  NEO_ASYNC_TRANSIENT: () => "Remove lifecycle: 'transient': an async factory is always a singleton.",
  NEO_DISPOSABLE_TRANSIENT_CAPTURED: () =>
    'Do not let a singleton hold a disposable transient: make the dependency a singleton, or make its consumer transient.',
  // Many causes share this code: a cause the analyzer does not tag gets the one sentence that holds for all of them.
  NEO_CONFIG_UNSUPPORTED: ({ reason }) => {
    switch (reason) {
      case 'value-owned':
        return "Register a factory with ownership: 'owned' instead of useValue, or remove ownership from the useValue registration.";
      case 'open-mode-roots':
        return "Remove roots and eager, or set optimization.mode to 'closed'.";
      case 'unsupported-mode':
        return "Set optimization.mode to 'open' or 'closed'.";
      case 'eager-alias':
        return 'List the target of the alias in eager: an alias builds nothing.';
      case 'partial-scope-inputs':
        return 'Declare scopeInputs on the builder (defineBuilderConfig): a partial cannot declare it.';
      case 'partial-initialization':
        return 'Declare initialization on the builder (defineBuilderConfig): a partial cannot declare it.';
      default:
        return 'Rewrite this option in the form the message above accepts: the build reads only forms it can resolve without running your code.';
    }
  },
  NEO_UNKNOWN_CONTAINER: ({ reason }) =>
    reason === 'dynamic-list'
      ? 'Give resolveMany a literal list of tokens, without spread, so the build can read every token.'
      : 'Call resolve on a const assigned from defineBuilderConfig: the build cannot tell which container this receiver is.',
  NEO_MULTI_REQUIRES_RESOLVE_ALL: ({ token }) =>
    `Use resolveAll(${quoted(token, 'the token')}) for a multi token: resolve() answers one object.`,
  NEO_UNDECLARED_FACTORY_DEP: () =>
    'Resolve through the factory context and list the token in dependencies: do not call resolve on a captured container.',
  NEO_FACTORY_CONTEXT_EXPIRED: () =>
    'Use the factory context only while the factory runs: resolve what you need before it returns.',
  NEO_TOKEN_BOUNDARY_UNSUPPORTED: () =>
    'Describe the external token in the token manifest of the package that owns it, or register it in this project.',
  NEO_ROOT_NOT_EXPORTED: ({ token }) =>
    `Add ${quoted(token, 'the token')} to optimization.roots of the closed container, or resolve one of its roots.`,
  NEO_CLOSED_REQUIRES_STRICT: () => "Use validation: 'strict' with a closed container, or set optimization.mode to 'open'.",
};

/** The fix of a diagnostic, or `undefined` when it has no stable code. Never read from the message. */
export function fixHintOf(diagnostic: Pick<StableDiagnostic, 'code'> & HintInput): string | undefined {
  return diagnostic.code === undefined ? undefined : HINTS[diagnostic.code](diagnostic);
}

/** The fix of an analysis error: `fixHintOf` over its stable fields and the `context.reason` the analyzer set. */
export function fixHintOfError(error: AnalysisError, lookup?: ContainerLookup): string | undefined {
  const reason = error.context?.reason;
  return fixHintOf({ ...toStableDiagnostic(error, lookup), ...(reason !== undefined ? { reason } : {}) });
}

/**
 * Converts an analysis error into an `ActionableDiagnostic`.
 * Code, severity, position and chain are copied from `toStableDiagnostic`: the message is never parsed.
 */
export function toActionableDiagnostic(error: AnalysisError, options: ActionableOptions = {}): ActionableDiagnostic {
  const stable = toStableDiagnostic(error, options.lookup);
  const hint = fixHintOfError(error, options.lookup);
  return {
    code: stable.code ?? stable.type,
    severity: stable.severity,
    file: options.root !== undefined ? relative(options.root, stable.file) : stable.file,
    line: stable.line,
    column: stable.column,
    message: stable.message,
    chain: stable.chain ?? [],
    ...(hint !== undefined ? { hint } : {}),
  };
}

/** `Dependency chain: A -> B`, or `undefined` when the diagnostic has no chain. */
export function chainLineOf(diagnostic: Pick<ActionableDiagnostic, 'chain'>): string | undefined {
  return diagnostic.chain.length > 0 ? `Dependency chain: ${diagnostic.chain.join(' -> ')}` : undefined;
}

/** `Fix: <hint>`, or `undefined` when the diagnostic has no hint. */
export function fixLineOf(diagnostic: Pick<ActionableDiagnostic, 'hint'>): string | undefined {
  return diagnostic.hint ? `Fix: ${diagnostic.hint}` : undefined;
}

/** The text of one diagnostic: position and code, message, then the chain and the fix when there are any. */
export function formatDiagnostic(diagnostic: ActionableDiagnostic): string {
  const lines = [
    `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity} ${diagnostic.code}`,
    diagnostic.message,
  ];
  const chain = chainLineOf(diagnostic);
  const fix = fixLineOf(diagnostic);
  if (chain !== undefined) lines.push(chain);
  if (fix !== undefined) lines.push(fix);
  return lines.join('\n');
}
