/**
 * The optional production observation (topic 22). A build that asks for it (`observation: true` of the plugin) writes, next to
 * the container class, a small class that keeps the counters of the container and publishes events to the sinks that are
 * subscribed, and the members of the container that reach it. A build that does not ask for it writes none of this: no
 * member, no helper, no clock read.
 *
 * What is published, and when:
 * - three phases, each with a `start` and an `end` event: `construct` (a creator builds a class or a factory value, and the
 *   end comes when a promise it returns settles), `initialize` (one async step of `initialize()`: its construct and the store
 *   of the value) and `dispose` (the disposer of one value). A cache hit builds nothing and publishes nothing.
 * - each event holds the scalars `containerId`, `scopeId`, `registrationId`, `phase` and `kind`; an end holds `outcome` and
 *   `durationMs` too, and `errorCode` when the operation failed with a `NEO_*` code. No value, token object, message or stack.
 * - a sink is isolated: a sink that throws or rejects changes nothing of the operation it observes.
 *
 * With no sink subscribed the helper reads no clock and builds no meta object: `begin` answers one of three end functions
 * the class made once, and those only update the counters. The counters (constructs, initializes, disposes, failures,
 * cancellations, what is in flight per phase, the scopes in use) are kept whether a sink listens or not: they are what
 * `stateSnapshot()` answers, and they cost an integer update each.
 *
 * The generated file imports nothing from the product and its lib is `es2021`: the types are written out, and the clock is
 * read from `globalThis` when a sink subscribes (`performance` is a global of the dom and node libs, not of es2021).
 */

/** The name of the observation class (and the prefix of its types) written next to the class `className`. */
export function observationName(className: string): string {
  return `${className}Obs`;
}

/** What the container members need of the build: the class they belong to, the id of the artifact, the shape of its states. */
export interface ObservationInput {
  className: string;
  /** The artifact key of the container: the opaque id every event of the container carries. */
  containerId: string;
  hasAsync: boolean;
  /** The profile has no `reconfiguring` state (the minimal profile of the optimized emitter). */
  minimal: boolean;
}

/**
 * The types and the class, as top-level declarations after a line break. A class declaration with no static initializer:
 * an unread container stays a pure declaration (T14).
 */
export function observationTypes(className: string): string {
  const name = observationName(className);
  return `
type ${name}Phase = 'construct' | 'initialize' | 'dispose';
type ${name}Event = Readonly<{ containerId: string; scopeId: string; registrationId: string; phase: ${name}Phase; kind: 'start' | 'end'; outcome?: 'ok' | 'error'; durationMs?: number; errorCode?: string }>;
type ${name}Sink = (event: ${name}Event) => unknown;
type ${name}End = (outcome: 'ok' | 'error', error?: unknown) => void;
type ${name}State = 'created' | 'initializing' | 'cancelling' | 'reconfiguring' | 'ready' | 'failed' | 'destroying' | 'destroyed';
type ${name}Snapshot = Readonly<{ state: ${name}State; constructs: number; initializes: number; disposes: number; failures: number; cancellations: number; inFlight: Readonly<{ construct: number; initialize: number; dispose: number }>; activeScopes: number }>;
class ${name} {
  private readonly _subs: Array<{ sink: ${name}Sink | undefined; readonly now: () => number }> = [];
  private readonly _done: Record<${name}Phase, number> = { construct: 0, initialize: 0, dispose: 0 };
  private readonly _flight: Record<${name}Phase, number> = { construct: 0, initialize: 0, dispose: 0 };
  private readonly _plain: Record<${name}Phase, ${name}End>;
  private _failures = 0;
  private _cancelled = 0;
  private _scopes = 0;
  private _scopeSeq = 0;

  constructor(private readonly _containerId: string) {
    const plain = (phase: ${name}Phase): ${name}End => (outcome) => this._settle(phase, outcome);
    this._plain = { construct: plain('construct'), initialize: plain('initialize'), dispose: plain('dispose') };
  }

  begin(phase: ${name}Phase, scopeId: string, registrationId: string): ${name}End {
    this._flight[phase] += 1;
    if (this._subs.length === 0) return this._plain[phase];
    return this._publishStart(phase, scopeId, registrationId);
  }

  private _publishStart(phase: ${name}Phase, scopeId: string, registrationId: string): ${name}End {
    const subs = this._subs.slice();
    const meta = { containerId: this._containerId, scopeId, registrationId, phase };
    const starts: number[] = [];
    for (const sub of subs) {
      const start = ${name}._read(sub.now);
      starts.push(start);
      if (sub.sink !== undefined && Number.isFinite(start)) ${name}._publish(sub.sink, { ...meta, kind: 'start' });
    }
    // Every call site ends an operation once, and this function cannot throw: a sink that was told a start is told one end.
    return (outcome, error) => {
      this._settle(phase, outcome);
      const errorCode = outcome === 'error' ? ${name}._codeOf(error) : undefined;
      subs.forEach((sub, index) => {
        const start = starts[index] ?? Number.NaN;
        if (sub.sink === undefined || !Number.isFinite(start)) return;
        const end = ${name}._read(sub.now);
        // A clock that fails at the end still lets the sink have its end, without a duration.
        const timing = Number.isFinite(end) ? { durationMs: Math.max(0, end - start) } : {};
        ${name}._publish(sub.sink, { ...meta, kind: 'end', outcome, ...timing, ...(errorCode === undefined ? {} : { errorCode }) });
      });
    };
  }

  private _settle(phase: ${name}Phase, outcome: 'ok' | 'error'): void {
    this._flight[phase] -= 1;
    if (outcome === 'ok') this._done[phase] += 1;
    else this._failures += 1;
  }

  subscribe(sink: ${name}Sink, options: { readonly now?: () => number } | undefined): () => void {
    const given = options?.now;
    if (given !== undefined && typeof given !== 'function') throw new TypeError('observe() needs options.now to be a function');
    const sub: { sink: ${name}Sink | undefined; readonly now: () => number } = { sink, now: given ?? ${name}._clock() };
    this._subs.push(sub);
    return () => {
      sub.sink = undefined;
      const at = this._subs.indexOf(sub);
      if (at >= 0) this._subs.splice(at, 1);
    };
  }

  scopeOpened(): string {
    this._scopes += 1;
    this._scopeSeq += 1;
    return 's' + this._scopeSeq;
  }

  scopeClosed(): void {
    this._scopes -= 1;
  }

  cancelled(): void {
    this._cancelled += 1;
  }

  snapshot(state: ${name}State): ${name}Snapshot {
    return {
      state,
      constructs: this._done.construct,
      initializes: this._done.initialize,
      disposes: this._done.dispose,
      failures: this._failures,
      cancellations: this._cancelled,
      inFlight: { construct: this._flight.construct, initialize: this._flight.initialize, dispose: this._flight.dispose },
      activeScopes: this._scopes,
    };
  }

  private static _clock(): () => number {
    const host = (globalThis as { performance?: { now(): number } }).performance;
    return host !== undefined && typeof host.now === 'function' ? () => host.now() : () => Date.now();
  }

  private static _read(now: () => number): number {
    try {
      return now();
    } catch {
      return Number.NaN;
    }
  }

  private static _publish(sink: ${name}Sink, event: ${name}Event): void {
    try {
      const result: unknown = sink(Object.freeze(event));
      // An async sink must not leave an unhandled rejection behind.
      if (result !== null && (typeof result === 'object' || typeof result === 'function')) void Promise.resolve(result).catch(() => {});
    } catch {
      // A defective sink never replaces the result of the operation it observes.
    }
  }

  private static _codeOf(error: unknown): string | undefined {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
    try {
      const code: unknown = Reflect.get(error, 'code');
      return typeof code === 'string' && /^NEO_[A-Z0-9_]+$/.test(code) ? code : undefined;
    } catch {
      return undefined;
    }
  }
}`;
}

/**
 * The state `stateSnapshot()` reports. An async container has one (`_state`). A sync container is ready from the start: it
 * is failed once an override failed it, and closed (destroying, then destroyed) once `destroy()` marked it.
 */
function stateExpression(input: ObservationInput): string {
  if (input.hasAsync) return 'this._state';
  const reconfiguring = input.minimal ? '' : "this._reconfiguring ? 'reconfiguring' : ";
  return `this._closed ? (this._destroyWork !== undefined ? 'destroying' : 'destroyed') : this._failure !== undefined ? 'failed' : ${reconfiguring}'ready'`;
}

/**
 * The members of the container class: the two public ones, `observe` and `stateSnapshot` (the minimal profile has these two
 * and nothing else of the full profile's surface), and the private ones the emitted code calls. The observation object is
 * made on first use and shared with every scope (`_neoAdopt`), so a scope reports under an id of its own and the counters
 * are those of the whole container.
 */
export function observationMembers(input: ObservationInput): string {
  const name = observationName(input.className);
  return `private _obs?: ${name};
  private _scopeId = 'root';
  private _scoped = false;
  private _neoDone = false;
  private readonly _neoOwned: Array<() => void> = [];

  /**
   * Subscribes a sink to the events of the whole container tree: the root and every scope made from it, whichever of them
   * took the sink (a sink taken through a scope also sees the events of the root and of its sibling scopes). Returns the
   * function that unsubscribes it. The clock of the sink is \`options.now\` when given, \`performance.now\` otherwise, read
   * only while a sink is subscribed. The container or the scope that took the sink lets go of it once its \`destroy()\` is
   * over, as it does at unsubscribe; a sink taken after that is never called. A sink must not call back into the container.
   */
  public observe(sink: ${name}Sink, options?: { readonly now?: () => number }): () => void {
    if (typeof sink !== 'function') throw new TypeError('observe() needs a function');
    if (this._neoDone) return () => undefined;
    const off = this._neoObs().subscribe(sink, options);
    const owned = this._neoOwned;
    const release = (): void => {
      off();
      const at = owned.indexOf(release);
      if (at >= 0) owned.splice(at, 1);
    };
    owned.push(release);
    return release;
  }

  private _neoRelease(): void {
    this._neoDone = true;
    for (const release of this._neoOwned.slice()) release();
  }

  /** The state of this container and the counters of the whole container: scalars only, a new object at each call. */
  public stateSnapshot(): ${name}Snapshot {
    return this._neoObs().snapshot(${stateExpression(input)});
  }

  private _neoObs(): ${name} {
    return this._obs ??= new ${name}(${JSON.stringify(input.containerId)});
  }

  private _neoAdopt(scope: ${input.className}): void {
    const __neoObs = this._neoObs();
    scope._obs = __neoObs;
    scope._scopeId = __neoObs.scopeOpened();
    scope._scoped = true;
  }

  private _neoSettle<T>(end: ${name}End, result: T): T;
  private _neoSettle(end: ${name}End, result: unknown): unknown {
    if (result === null || (typeof result !== 'object' && typeof result !== 'function') || typeof Reflect.get(result, 'then') !== 'function') {
      end('ok');
      return result;
    }
    return Promise.resolve(result).then(
      (value: unknown) => { end('ok'); return value; },
      (error: unknown) => { end('error', error); throw error; },
    );
  }

  private _neoRest(end: ${name}End, result: unknown): unknown {
    const settled = this._neoSettle(end, result);
    return settled === result ? undefined : settled;
  }`;
}

/** `this._neoObs().begin(...)` for a registration: scalars only, so the call site builds no object. */
export function observeBegin(phase: 'construct' | 'initialize' | 'dispose', registrationId: string): string {
  return `this._neoObs().begin('${phase}', this._scopeId, ${JSON.stringify(registrationId)})`;
}
