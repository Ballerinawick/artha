type Entry<T> = { exp: number; val: T };

const mem = new Map<string, Entry<unknown>>();

export async function cachedStale<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = mem.get(key) as Entry<T> | undefined;
  if (hit && hit.exp > Date.now()) return hit.val;
  try {
    const val = await fn();
    mem.set(key, { exp: Date.now() + ttlMs, val });
    return val;
  } catch (err) {
    if (hit) return hit.val;
    throw err;
  }
}

export function cachePeek<T>(key: string): T | undefined {
  return (mem.get(key) as Entry<T> | undefined)?.val;
}

export function cacheSet<T>(key: string, ttlMs: number, val: T): void {
  mem.set(key, { exp: Date.now() + ttlMs, val });
}
