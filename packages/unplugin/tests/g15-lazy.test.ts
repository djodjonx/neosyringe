import { describe, expect, it } from 'vitest';
import { lazyOnce } from '../src/lazy';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The loader runs on a microtask after the call. One macrotask turn is enough for it to have started. */
function started(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

describe('G15 lazyOnce', () => {
  it('shares concurrent loads', async () => {
    const gate = deferred<string>();
    let calls = 0;
    const load = lazyOnce(() => {
      calls += 1;
      return gate.promise;
    });
    const first = load();
    const second = load();
    expect(second).toBe(first);
    gate.resolve('module');
    expect(await first).toBe('module');
    expect(await second).toBe('module');
    // After the load, the answer stays: the loader does not run again.
    expect(await load()).toBe('module');
    expect(calls).toBe(1);
  });

  it('does not start the load before the first call', async () => {
    let calls = 0;
    const load = lazyOnce(async () => {
      calls += 1;
      return 'module';
    });
    await started();
    expect(calls).toBe(0);
    expect(await load()).toBe('module');
    expect(calls).toBe(1);
  });

  it('retries after a rejection and surfaces the error', async () => {
    const attempts: Deferred<string>[] = [];
    const load = lazyOnce(() => {
      const attempt = deferred<string>();
      attempts.push(attempt);
      return attempt.promise;
    });
    const waiting = [load(), load()];
    await started();
    attempts[0]?.reject(new Error('chunk is missing'));
    for (const caller of waiting) await expect(caller).rejects.toThrow('chunk is missing');
    expect(attempts).toHaveLength(1);

    const retried = load();
    await started();
    expect(attempts).toHaveLength(2);
    attempts[1]?.resolve('module');
    expect(await retried).toBe('module');
  });

  it('a loader that throws before it returns a promise is a rejection too', async () => {
    let calls = 0;
    const load = lazyOnce<string>(() => {
      calls += 1;
      if (calls === 1) throw new Error('sync failure');
      return Promise.resolve('module');
    });
    await expect(load()).rejects.toThrow('sync failure');
    expect(await load()).toBe('module');
    expect(calls).toBe(2);
  });

  it('an old rejection does not clear a newer attempt', async () => {
    const attempts: Deferred<string>[] = [];
    const load = lazyOnce(() => {
      const attempt = deferred<string>();
      attempts.push(attempt);
      return attempt.promise;
    });
    const first = load();
    await started();
    // Observed apart from the lazyOnce chain, so the rejection below is handled whichever way it settles.
    const firstOutcome = first.then(() => 'resolved', (error: Error) => error.message);
    attempts[0]?.reject(new Error('first failed'));
    expect(await firstOutcome).toBe('first failed');

    const second = load();
    await started();
    expect(second).not.toBe(first);
    // The first attempt's rejection handlers have already run. A newer attempt in flight is still the shared one.
    expect(load()).toBe(second);
    attempts[1]?.resolve('module');
    expect(await second).toBe('module');
    expect(attempts).toHaveLength(2);
  });
});
