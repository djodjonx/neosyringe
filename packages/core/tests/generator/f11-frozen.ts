/**
 * The text of `initialize()` and `_runInitialize()` as the emitter wrote it at cd61e36, for the graph MIXED of
 * f11-concurrency-runtime.test.ts: a bounded concurrency of 1, or none, must write exactly this. The quoted token keys are
 * replaced by "K" and the hash of a creator name by `H` (both depend on the virtual file), nothing else is touched.
 */
export const FROZEN_INITIALIZE_FULL = `public async initialize(): Promise<void> {
    if (this._state === 'initializing' && this._syncInit > 0) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));
    if (this._state === 'initializing') return this._initWork;
    if (this._state === 'ready') return Promise.resolve();
    if (this._state === 'failed') return Promise.reject(this._failure);
    if (this._state === 'destroying' || this._state === 'destroyed') {
      throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');
    }
    if (this._state === 'reconfiguring') throw this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning');
    this._state = 'initializing';
    this._initWork = this._runInitialize();
    return this._initWork;
  }

  private async _runInitialize(): Promise<void> {
    this._initRunning = true;
    try {
      if (this.legacy) { for (const c of this.legacy) { if (typeof c?.initialize === 'function') { await c.initialize(); } } }
      if (!this.overrides.has("K")) { const __neoValue = await this.create_IDb_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      if (!this.overrides.has("K")) { const __neoValue = await this.create_ICache_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      { const __neoValue = await this.create_IItem_H_0(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      { const __neoValue = await this.create_IItem_H_2(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      if (!this.overrides.has("K")) { const __neoValue = await this.create_IRep_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      if (!this.overrides.has("K")) { const __neoValue = await this.create_ISvc_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
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
    }
  }

  `;

/** The same text for the minimal profile of the optimized emitter (the reference emitter has no minimal profile). */
export const FROZEN_INITIALIZE_MINIMAL = `public async initialize(): Promise<void> {
    if (this._state === 'initializing' && this._syncInit > 0) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));
    if (this._state === 'initializing') return this._initWork;
    if (this._state === 'ready') return Promise.resolve();
    if (this._state === 'failed') return Promise.reject(this._failure);
    if (this._state === 'destroying' || this._state === 'destroyed') {
      throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');
    }
    
    this._state = 'initializing';
    this._initWork = this._runInitialize();
    return this._initWork;
  }

  private async _runInitialize(): Promise<void> {
    this._initRunning = true;
    try {
      if (this.legacy) { for (const c of this.legacy) { if (typeof c?.initialize === 'function') { await c.initialize(); } } }
      { const __neoValue = await this.create_IDb_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      { const __neoValue = await this.create_ICache_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      { const __neoValue = await this.create_IItem_H_0(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      { const __neoValue = await this.create_IItem_H_2(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      { const __neoValue = await this.create_IRep_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
      { const __neoValue = await this.create_ISvc_H(); this.instances.set("K", __neoValue); if (this._initRunning) this._initJournal.push("K"); }
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
    }
  }

  `;
