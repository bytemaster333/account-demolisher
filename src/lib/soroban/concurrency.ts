// run `fn` over `items` with at most `limit` in flight, preserving input order
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapConcurrent: limit must be a positive integer; got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface Semaphore {
  // runs fn once a slot is free. a signal that aborts while the task still waits
  // drops it without running fn
  run<R>(fn: () => Promise<R>, signal?: AbortSignal): Promise<R>;
}

// a shared slot pool for callers that start independently (one per rendered
// row, say) but must not run more than `limit` tasks at once between them
export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`createSemaphore: limit must be a positive integer; got ${limit}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    const next = waiting.shift();
    if (next !== undefined) next();
    else active -= 1;
  };

  const acquire = (signal: AbortSignal | undefined): Promise<void> => {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      // the slot is handed over directly, so `active` stays as it is
      const take = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const i = waiting.indexOf(take);
        if (i >= 0) waiting.splice(i, 1);
        reject(abortReason(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.push(take);
    });
  };

  return {
    async run<R>(fn: () => Promise<R>, signal?: AbortSignal): Promise<R> {
      await acquire(signal);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
