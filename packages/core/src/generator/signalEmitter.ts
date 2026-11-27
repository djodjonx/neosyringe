import type { DependencyGraph } from '../analyzer/types';

/**
 * The signal of an initialization and of a factory context (topic 19).
 *
 * The generated file imports nothing from the product and its lib is `es2021`, which has no `AbortSignal` and no
 * `AbortController` (docs/release/compatibility.md, "Floor of the emitted code"). The signal is therefore a structural type
 * the output declares for itself, the same shape as `AbortSignalLike` of packages/neosyringe/src/types.ts, so a real
 * `AbortSignal` is assignable to it and the context the output types for a user factory is assignable to the public
 * `FactoryContext`. The controller is read from `globalThis` when it is needed, never when the module loads: a runtime
 * without one gets a small stand-in that has the same members.
 *
 * The aliases are written next to the class, and only when the class reads them: an async container (the signal and the
 * controller), or a container with a factory (the signal alone). Their names derive from the class name, as `${className}AsyncDisposal` does (`asyncDisposalTypes`). Types leave
 * no code behind.
 */

/** The name of the signal alias of the class `className`. */
export function signalTypeName(className: string): string {
  return `${className}Signal`;
}

/** The name of the controller alias of the class `className`. */
export function controllerTypeName(className: string): string {
  return `${className}Controller`;
}

/** True when the class reads the signal aliases: it initializes asynchronously, or one of its registrations is a factory. */
export function needsSignal(graph: DependencyGraph, hasAsync: boolean): boolean {
  if (hasAsync) return true;
  for (const node of graph.nodes.values()) {
    if (node.service.type === 'factory') return true;
  }
  for (const nodes of graph.multiNodes?.values() ?? []) {
    if (nodes.some((node) => node.service.type === 'factory')) return true;
  }
  return false;
}

/**
 * The aliases, as top-level declarations, each on a line of its own after a line break. Empty for a class that never names
 * them. The controller alias is for an async class only: a sync class never makes a controller of its own.
 */
export function signalTypes(className: string, used: boolean, hasAsync: boolean): string {
  if (!used) return '';
  const signal = signalTypeName(className);
  const text = `\ntype ${signal} = { readonly aborted: boolean; readonly reason?: unknown; addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void; removeEventListener(type: 'abort', listener: () => void): void };`;
  return hasAsync ? `${text}\ntype ${controllerTypeName(className)} = { readonly signal: ${signal}; abort(reason?: unknown): void };` : text;
}

/**
 * What a class that reads the aliases has: the signal a factory of the class receives, and the never-aborted signal of a
 * factory called outside an initialization.
 *
 * A sync class (it has no `_initController`, nothing to cancel) has the smallest form that gives a factory context a signal
 * that is never aborted: `_neoSignal` alone, which builds that signal on first use from the global controller, or from a
 * literal with the same members when the runtime has none. It has no `_neoCheck`, no `__neoController`, no stand-in.
 *
 * An async class has, for the initialization it cancels:
 * - `__neoController` makes a controller: the global one, or a stand-in with the same members (an abort calls the listeners
 *   once, in the order they were added; a listener that throws does not stop the others, and its error is reported to the
 *   host as an unhandled rejection, as a native signal reports it).
 * - `__neoIdle` is one signal that never aborts, built on first use and shared by every call and every scope of the class:
 *   a listener added to it is never called and never released, so a factory must not add one per call.
 * - `_neoSignal` is the signal of the initialization that is running (`_initRunning`), the idle one otherwise.
 * - `_neoCheck` throws the reason of an initialization that is cancelling.
 */
export function signalMembers(className: string, hasAsync: boolean): string {
  const signal = signalTypeName(className);
  if (!hasAsync) {
    return `private static __neoIdleSignal?: ${signal};

  private _neoSignal(): ${signal} {
    const __neoNative = (globalThis as { AbortController?: new () => { readonly signal: ${signal} } }).AbortController;
    return ${className}.__neoIdleSignal ??= __neoNative !== undefined ? new __neoNative().signal : { aborted: false, addEventListener() {}, removeEventListener() {} };
  }`;
  }
  const controller = controllerTypeName(className);
  const shared = `private static __neoIdleSignal?: ${signal};

  private static __neoController(): ${controller} {
    const __neoNative = (globalThis as { AbortController?: new () => ${controller} }).AbortController;
    if (__neoNative !== undefined) return new __neoNative();
    const __neoListeners = new Set<() => void>();
    let __neoAborted = false;
    let __neoReason: unknown;
    const __neoSignal: ${signal} = {
      get aborted() { return __neoAborted; },
      get reason() { return __neoReason; },
      addEventListener(_type, listener) { __neoListeners.add(listener); },
      removeEventListener(_type, listener) { __neoListeners.delete(listener); },
    };
    return {
      signal: __neoSignal,
      abort(reason) {
        if (__neoAborted) return;
        __neoAborted = true;
        __neoReason = reason;
        const __neoCalls = [...__neoListeners];
        __neoListeners.clear();
        for (const __neoListener of __neoCalls) {
          try { __neoListener(); } catch (__neoListenerError) { void Promise.reject(__neoListenerError); }
        }
      },
    };
  }

  private static __neoIdle(): ${signal} {
    return ${className}.__neoIdleSignal ??= ${className}.__neoController().signal;
  }`;
  return `${shared}

  private _neoSignal(): ${signal} {
    return this._initRunning && this._initController !== undefined ? this._initController.signal : ${className}.__neoIdle();
  }

  private _neoCheck(): void {
    if (this._initCancel !== undefined) throw this._initCancel.reason;
  }`;
}
