const GAP = { quote: 1100, data: 260, chain: 3200 } as const;

type Kind = keyof typeof GAP;

const nextAt: Record<Kind, number> = { quote: 0, data: 0, chain: 0 };
const tails: Record<Kind, Promise<void>> = {
  quote: Promise.resolve(),
  data: Promise.resolve(),
  chain: Promise.resolve(),
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Space calls out to Dhan's published buckets: quotes 1/sec, charts 5/sec, option chain 1/3sec. */
export function pace(kind: Kind): Promise<void> {
  const prev = tails[kind];
  let release: () => void = () => {};
  tails[kind] = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev
    .then(async () => {
      const wait = nextAt[kind] - Date.now();
      if (wait > 0) await sleep(wait);
      nextAt[kind] = Date.now() + GAP[kind];
    })
    .finally(release);
}

export function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate limit|too many requests|DH-904/i.test(msg);
}

export async function paced<T>(kind: Kind, fn: () => Promise<T>): Promise<T> {
  await pace(kind);
  try {
    return await fn();
  } catch (err) {
    if (!isRateLimit(err)) throw err;
    await sleep(GAP[kind]);
    await pace(kind);
    return fn();
  }
}
