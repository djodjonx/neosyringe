/**
 * The text of `initialize()`, `_startInitialize()` and `_runInitialize()` as the emitter writes it after topic 19, for the
 * graph MIXED of f11-concurrency-runtime.test.ts: a bounded concurrency of 1, or none, must write exactly this. The quoted
 * token keys are replaced by "K" and the hash of a creator name by `H` (both depend on the virtual file), nothing else is
 * touched. Topic 11 froze the text of cd61e36 here; topic 19 changed `initialize` (not `async`, one options argument, the
 * signal checks between the steps) and this literal moved with it, in the same commit. The sequential order of the
 * steps, which is what a concurrency of 1 promises, is pinned by the effect log of P1, a frozen literal of cd61e36.
 * The perf round of stage F (docs/benchmarks/stage-f-compile-overhead.md, "Runtime cost") moved it once more: without a
 * signal `_startInitialize` answers the work itself, and the controller is made by the first read of a signal.
 */
export const FROZEN_INITIALIZE_FULL = `public initialize(options?: { readonly signal?: NeoContainerSignal }): Promise<void> {
    if ((this._state === 'initializing' || this._state === 'cancelling') && this._syncInit > 0) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));
    const __neoUser = options?.signal;
    if (this._state === 'initializing' || this._state === 'cancelling') {
      if (__neoUser !== undefined && __neoUser !== this._initSignal) return Promise.reject(this._neoFail('NEO_INIT_OPTIONS_CONFLICT', 'initialize() is running with another signal'));
      return this._initObserved ?? Promise.resolve().then((): Promise<void> | undefined => this._initObserved);
    }
    if (this._state === 'ready') return Promise.resolve();
    if (this._state === 'failed') return Promise.reject(this._failure);
    if (this._state === 'destroying' || this._state === 'destroyed') {
      return Promise.reject(this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed'));
    }
    if (this._state === 'reconfiguring') return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));
    if (__neoUser !== undefined && (__neoUser === null || typeof __neoUser.addEventListener !== 'function' || typeof __neoUser.removeEventListener !== 'function')) return Promise.reject(new TypeError('initialize() needs an AbortSignal in options.signal'));
    return this._startInitialize(__neoUser);
  }

  private _startInitialize(__neoUser: NeoContainerSignal | undefined): Promise<void> {
    this._state = 'initializing';
    this._initSignal = __neoUser;
    this._initCancel = undefined;
    this._initAborted = undefined;
    if (__neoUser === undefined) {
      this._initObserved = undefined; const __neoRun = this._runInitialize();
      this._initWork = __neoRun;
      this._initObserved = __neoRun;
      return __neoRun;
    }
    let __neoResolve: () => void = () => {};
    let __neoReject: (reason: unknown) => void = () => {};
    const __neoObserved = new Promise<void>((resolve, reject) => {
      __neoResolve = resolve;
      __neoReject = reject;
    });
    this._initObserved = __neoObserved;
    const __neoRelay = (): void => {
      const __neoReason: unknown = __neoUser?.reason;
      this._initCancel = { reason: __neoReason };
      if (this._state === 'initializing') this._state = 'cancelling';
      __neoReject(__neoReason);
      this._neoAbort(__neoReason);
    };
    if (__neoUser.aborted) __neoRelay();
    else __neoUser.addEventListener('abort', __neoRelay, { once: true });
    const __neoWork = this._runInitialize();
    this._initWork = __neoWork;
    const __neoSettle = (): void => {
      __neoUser?.removeEventListener('abort', __neoRelay);
      if (this._initSignal === __neoUser) this._initSignal = undefined;
    };
    void __neoWork.then(
      () => { __neoSettle(); __neoResolve(); },
      (__neoError: unknown) => { __neoSettle(); __neoReject(__neoError); },
    );
    return __neoObserved;
  }

  private async _runInitialize(): Promise<void> {
    this._initRunning = true;
    try {
      this._neoCheck();
      if (this.legacy) { for (const c of this.legacy) { if (typeof c?.initialize === 'function') { await c.initialize(); } } }
      this._neoCheck();
      if (!this.overrides.has("K")) { const __neoValue = await this.create_IDb_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      if (!this.overrides.has("K")) { const __neoValue = await this.create_ICache_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      { const __neoValue = await this.create_IItem_H_0(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      { const __neoValue = await this.create_IItem_H_2(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      if (!this.overrides.has("K")) { const __neoValue = await this.create_IRep_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      if (!this.overrides.has("K")) { const __neoValue = await this.create_ISvc_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      if (this._state === 'initializing') this._state = 'ready';
    } catch (__neoInitError) {
      this._failure = __neoInitError;
      if (this._state === 'destroying') throw __neoInitError;
      const __neoCleanup: unknown[] = [];
      const __neoSeen = new Set();
      for (const __neoKey of [...this._initJournal].reverse()) {
        const __neoInst = this.instances.get(__neoKey) as { dispose?: () => unknown } | null | undefined;
        this.instances.delete(__neoKey);
        if (__neoInst == null || this._borrowed.has(__neoInst) || __neoSeen.has(__neoInst)) continue;
        __neoSeen.add(__neoInst);
        try {
          const __neoRun = this._neoDisposer(__neoInst);
          if (__neoRun) {
            const __neoResult = __neoRun();
            if (__neoResult && typeof (__neoResult as { then?: unknown }).then === 'function') await __neoResult;
          }
        } catch (__neoDisposeError) {
          __neoCleanup.push(__neoDisposeError);
        }
      }
      if (__neoCleanup.length === 0) {
        if ((this._state as string) !== 'destroying') this._state = 'failed';
        throw __neoInitError;
      }
      const __neoWrapped = new Error(__neoInitError instanceof Error ? __neoInitError.message : String(__neoInitError)) as Error & { cause?: unknown; cleanupErrors?: unknown[] };
      __neoWrapped.cause = __neoInitError;
      __neoWrapped.cleanupErrors = __neoCleanup;
      this._failure = __neoWrapped;
      if ((this._state as string) !== 'destroying') this._state = 'failed';
      throw __neoWrapped;
    } finally {
      this._initRunning = false;
      this._initController = undefined;
    }
  }

  `;

/** The same text for the minimal profile of the optimized emitter (the reference emitter has no minimal profile). */
export const FROZEN_INITIALIZE_MINIMAL = `public initialize(options?: { readonly signal?: NeoContainerSignal }): Promise<void> {
    if ((this._state === 'initializing' || this._state === 'cancelling') && this._syncInit > 0) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));
    const __neoUser = options?.signal;
    if (this._state === 'initializing' || this._state === 'cancelling') {
      if (__neoUser !== undefined && __neoUser !== this._initSignal) return Promise.reject(this._neoFail('NEO_INIT_OPTIONS_CONFLICT', 'initialize() is running with another signal'));
      return this._initObserved ?? Promise.resolve().then((): Promise<void> | undefined => this._initObserved);
    }
    if (this._state === 'ready') return Promise.resolve();
    if (this._state === 'failed') return Promise.reject(this._failure);
    if (this._state === 'destroying' || this._state === 'destroyed') {
      return Promise.reject(this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed'));
    }
    
    if (__neoUser !== undefined && (__neoUser === null || typeof __neoUser.addEventListener !== 'function' || typeof __neoUser.removeEventListener !== 'function')) return Promise.reject(new TypeError('initialize() needs an AbortSignal in options.signal'));
    return this._startInitialize(__neoUser);
  }

  private _startInitialize(__neoUser: NeoContainerSignal | undefined): Promise<void> {
    this._state = 'initializing';
    this._initSignal = __neoUser;
    this._initCancel = undefined;
    this._initAborted = undefined;
    if (__neoUser === undefined) {
      this._initObserved = undefined; const __neoRun = this._runInitialize();
      this._initWork = __neoRun;
      this._initObserved = __neoRun;
      return __neoRun;
    }
    let __neoResolve: () => void = () => {};
    let __neoReject: (reason: unknown) => void = () => {};
    const __neoObserved = new Promise<void>((resolve, reject) => {
      __neoResolve = resolve;
      __neoReject = reject;
    });
    this._initObserved = __neoObserved;
    const __neoRelay = (): void => {
      const __neoReason: unknown = __neoUser?.reason;
      this._initCancel = { reason: __neoReason };
      if (this._state === 'initializing') this._state = 'cancelling';
      __neoReject(__neoReason);
      this._neoAbort(__neoReason);
    };
    if (__neoUser.aborted) __neoRelay();
    else __neoUser.addEventListener('abort', __neoRelay, { once: true });
    const __neoWork = this._runInitialize();
    this._initWork = __neoWork;
    const __neoSettle = (): void => {
      __neoUser?.removeEventListener('abort', __neoRelay);
      if (this._initSignal === __neoUser) this._initSignal = undefined;
    };
    void __neoWork.then(
      () => { __neoSettle(); __neoResolve(); },
      (__neoError: unknown) => { __neoSettle(); __neoReject(__neoError); },
    );
    return __neoObserved;
  }

  private async _runInitialize(): Promise<void> {
    this._initRunning = true;
    try {
      this._neoCheck();
      if (this.legacy) { for (const c of this.legacy) { if (typeof c?.initialize === 'function') { await c.initialize(); } } }
      this._neoCheck();
      { const __neoValue = await this.create_IDb_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      { const __neoValue = await this.create_ICache_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      { const __neoValue = await this.create_IItem_H_0(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      { const __neoValue = await this.create_IItem_H_2(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      { const __neoValue = await this.create_IRep_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      { const __neoValue = await this.create_ISvc_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      this._neoCheck();
      if (this._state === 'initializing') this._state = 'ready';
    } catch (__neoInitError) {
      this._failure = __neoInitError;
      if (this._state === 'destroying') throw __neoInitError;
      const __neoCleanup: unknown[] = [];
      const __neoSeen = new Set();
      for (const __neoKey of [...this._initJournal].reverse()) {
        const __neoInst = this.instances.get(__neoKey) as { dispose?: () => unknown } | null | undefined;
        this.instances.delete(__neoKey);
        if (__neoInst == null || this._borrowed.has(__neoInst) || __neoSeen.has(__neoInst)) continue;
        __neoSeen.add(__neoInst);
        try {
          const __neoRun = this._neoDisposer(__neoInst);
          if (__neoRun) {
            const __neoResult = __neoRun();
            if (__neoResult && typeof (__neoResult as { then?: unknown }).then === 'function') await __neoResult;
          }
        } catch (__neoDisposeError) {
          __neoCleanup.push(__neoDisposeError);
        }
      }
      if (__neoCleanup.length === 0) {
        if ((this._state as string) !== 'destroying') this._state = 'failed';
        throw __neoInitError;
      }
      const __neoWrapped = new Error(__neoInitError instanceof Error ? __neoInitError.message : String(__neoInitError)) as Error & { cause?: unknown; cleanupErrors?: unknown[] };
      __neoWrapped.cause = __neoInitError;
      __neoWrapped.cleanupErrors = __neoCleanup;
      this._failure = __neoWrapped;
      if ((this._state as string) !== 'destroying') this._state = 'failed';
      throw __neoWrapped;
    } finally {
      this._initRunning = false;
      this._initController = undefined;
    }
  }

  `;
