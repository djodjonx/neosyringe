/**
 * Loads a module once, on first use.
 *
 * Calls made while the load is running share its promise. A load that rejects is forgotten, so the next call tries
 * again; the rejection reaches every caller that was waiting on it, with its original error.
 *
 * Limit: a retry cannot undo the engine's own module cache. In Node, `import()` of an ESM file whose evaluation threw
 * keeps that failure (the file is evaluated once and every later `import()` rejects with the same error), while a
 * CommonJS file is evaluated again by the next `require()`. So under ESM the retry does not help against a module that
 * throws as it evaluates; the error stays visible to the caller instead of being swallowed.
 */
export function lazyOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending) return pending;
    const attempt = Promise.resolve().then(load);
    const guarded = attempt.catch((error: unknown) => {
      // A newer attempt may already have replaced this one: only the attempt that failed clears itself.
      if (pending === guarded) pending = undefined;
      throw error;
    });
    pending = guarded;
    return guarded;
  };
}
