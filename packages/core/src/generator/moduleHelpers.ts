import type { HelperId, NamePool } from './fragments';
import { emitFactoryContextAlias, leaseFunction, contextClassDeclaration, policyFunction, policyAlias, type LeaseForm } from './factoryLeaseEmitter';
import { emitManyAliases, type ManyNames } from './manyEmitter';
import { controllerFunction, signalAliases } from './signalEmitter';

/**
 * Helpers written once in the module of the output and used by every container the module holds (stage G, "Round 4" of
 * docs/benchmarks/stage-f-compile-overhead.md).
 *
 * Each of them is a stateless factory or class: the controller factory (`__neoController`), the lease, the context class, the
 * policy builder and `formatToken`. A call makes its own listener set, expiry flag, reason or policy table in its own closure, so
 * two containers that call one of them share text and no state. What holds state stays a member of its class: the idle
 * signal and its listeners (`__neoIdleSignal`, `__neoIdle`), the state machine, `_initController`, `_initAborted`, the policy
 * cache of a declaration.
 *
 * The registry is optional. A Generator that gets none (a container of its own file, `generate()` of a unit test) writes the same
 * helpers as private static members of its class, as it always did. The plugin session gives one registry to every
 * Generator of a source file, renders the block once and writes it in front of the first top-level statement that is not an
 * import or a prologue directive, so a container in a nested scope, or in a hoisted function that runs early, sees it too.
 */

/** The helpers a registry can hold. The three `factory*` ids are the ones of the catalog of `factoryLeaseHelpers`. */
export type SharedHelperId = 'controller' | 'formatToken' | Extract<HelperId, 'factoryPolicy' | 'factoryLease' | 'factoryContext'>;

/** True for the ids of the factory helpers a registry holds (the policy builder, the lease and the context class). */
export function isFactoryHelper(id: HelperId): id is Extract<HelperId, 'factoryPolicy' | 'factoryLease' | 'factoryContext'> {
  return id === 'factoryPolicy' || id === 'factoryLease' || id === 'factoryContext';
}

/**
 * What the text of a container calls: the expression that names each helper. Inline, a member of the class; shared, a name
 * of the module.
 */
export interface HelperRefs {
  readonly controller: string;
  readonly lease: string;
  /** The class a factory context is made with: `new ${contextClass}(...)`. */
  readonly contextClass: string;
  readonly policyOf: string;
  /** The type of a policy, as the fields of a declaration name it. */
  readonly policyType: string;
  readonly formatToken: string;
  /**
   * What follows the `read` argument of a lease call: nothing for the lease of the class, which reads the signal of its host
   * itself; for the lease of the module, the reader `() => this._neoSignal()`, written where the private member is reachable.
   */
  readonly leaseSignal: string;
}

/** The refs of a class that carries its helpers. */
export function inlineRefs(className: string): HelperRefs {
  return {
    controller: `${className}.__neoController`,
    lease: `${className}.__neoLease`,
    contextClass: `${className}.__neoContext`,
    policyOf: `${className}.__neoPolicyOf`,
    policyType: `ReturnType<typeof ${className}.__neoPolicyOf>`,
    formatToken: `${className}.formatToken`,
    leaseSignal: '',
  };
}

const PREFERRED: Readonly<Record<SharedHelperId | 'signal' | 'controllerType' | 'context' | 'policy', string>> = {
  controller: '__neoSharedController',
  formatToken: '__neoSharedFormatToken',
  factoryPolicy: '__neoSharedPolicyOf',
  factoryLease: '__neoSharedLease',
  factoryContext: '__neoSharedContext',
  signal: '__NeoSharedSignal',
  controllerType: '__NeoSharedController',
  context: '__NeoSharedContext',
  policy: '__NeoSharedPolicy',
};

/** `formatToken`, as the text of its function or of a static member of a class. */
export function formatTokenText(head: string): string {
  return `${head}(token: unknown): string {
    if (typeof token === 'function') return token.name || String(token);
    if (typeof token !== 'string') return String(token);
    const parts = token.split('_');
    const last = parts[parts.length - 1];
    if (parts.length > 1 && /^[a-f0-9]{6,12}$/i.test(last)) {
      return parts.slice(0, -1).join('_');
    }
    return token;
  }`;
}

/** The helpers shared by the containers of one source file, and the names the pool of that file gave them. */
export class ModuleHelpers {
  private readonly claimed = new Set<SharedHelperId>();
  private readonly many: ManyNames;
  private readonly aliases: { readonly signal: string; readonly controller: string; readonly context: string; readonly policy: string };

  constructor(private readonly names: NamePool) {
    const key = (id: string, preferred: string): string => names.forKey(`shared:${id}`, preferred);
    this.many = {
      token: key('many-token', '__NeoSharedToken'),
      values: key('many-values', '__NeoSharedValues'),
      overrideEntry: key('many-override-entry', '__NeoSharedOverrideEntry'),
      overrideInvalid: key('many-override-invalid', '__NeoSharedOverrideInvalid'),
      overrideGuard: key('many-override-guard', '__NeoSharedOverrideGuard'),
    };
    this.aliases = {
      signal: key('signal', PREFERRED.signal),
      controller: key('controller-type', PREFERRED.controllerType),
      context: key('context-type', PREFERRED.context),
      policy: key('policy-type', PREFERRED.policy),
    };
  }

  private nameOf(id: SharedHelperId): string {
    return this.names.forKey(`shared:${id}`, PREFERRED[id]);
  }

  /** The refs of a container that calls the helpers of this module. */
  refs(): HelperRefs {
    return {
      controller: this.nameOf('controller'),
      lease: this.nameOf('factoryLease'),
      contextClass: this.nameOf('factoryContext'),
      policyOf: this.nameOf('factoryPolicy'),
      policyType: this.aliases.policy,
      formatToken: this.nameOf('formatToken'),
      leaseSignal: ', () => this._neoSignal()',
    };
  }

  /** A container calls this helper: the block holds it. Calling it twice is harmless. */
  claim(id: SharedHelperId): void {
    this.claimed.add(id);
  }

  /** True when one container asked for a helper. */
  get used(): boolean {
    return this.claimed.size > 0;
  }

  /**
   * The block, as text, or an empty string when no container claimed anything. It holds type aliases, `function`s and one
   * `class`, and no `const`, `let` or `var`. The `class` is not hoisted: the block must be written before any statement that
   * can run a factory (the plugin writes it before the first statement that is not an import or a prologue directive), or a
   * hoisted function that holds a container and is called ahead of the block finds the class in its temporal dead zone.
   * The type aliases are written only for what a claimed helper reads, so no alias is left unused.
   */
  render(): string {
    const has = (id: SharedHelperId): boolean => this.claimed.has(id);
    const controller = has('controller');
    const lease = has('factoryLease');
    const context = lease || has('factoryContext');
    const policyOf = has('factoryPolicy');
    const policy = lease || policyOf;
    const signal = controller || context;
    const form: LeaseForm = { signal: this.aliases.signal, context: this.aliases.context, policy: this.aliases.policy, names: this.many };
    const blocks: string[] = [];
    if (signal) blocks.push(signalAliases(this.aliases.signal, controller ? this.aliases.controller : undefined));
    if (context) blocks.push(`${emitManyAliases(this.many)}\n${emitFactoryContextAlias(form)}`);
    if (policy) blocks.push(policyAlias(form));
    if (controller) blocks.push(controllerFunction(this.nameOf('controller'), this.aliases.controller));
    if (has('formatToken')) blocks.push(formatTokenText(`function ${this.nameOf('formatToken')}`));
    if (policyOf) blocks.push(policyFunction(this.nameOf('factoryPolicy'), form));
    if (context) blocks.push(contextClassDeclaration(this.nameOf('factoryContext'), form));
    if (lease) blocks.push(leaseFunction(this.nameOf('factoryLease'), this.nameOf('factoryContext'), form));
    if (blocks.length === 0) return '';
    return `// -- Shared helpers --\n${blocks.join('\n')}\n`;
  }
}
