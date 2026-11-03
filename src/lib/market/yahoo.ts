import { cachedStale } from "./cache";
import { formatIstStamp, marketSession } from "./hours";
import { momentumPct, rsi, sma, mean } from "./indicators";
import { buildSets, rankPicks, scoreAll } from "./scoring";
import type {
  Bar,
  CorporateAction,
  IndexQuote,
  MarketBoard,
  StockDetail,
  StockQuote,
} from "./types";
import { INDICES, UNIVERSE, UNIVERSE_BY_SYMBOL, UNIVERSE_BY_YAHOO } from "./universe";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type SparkMeta = {
  currency?: string;
  symbol?: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  fulldayChange?: number;
  fulldayChangePercent?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  previousClose?: number;
  chartPreviousClose?: number;
};

type QuoteBlock = {
  close?: Array<number | null>;
  high?: Array<number | null>;
  low?: Array<number | null>;
  open?: Array<number | null>;
  volume?: Array<number | null>;
};

type EventPack = {
  actions: CorporateAction[];
  trailing: number;
  lastDiv: StockQuote["lastDividend"];
};

async function yahooJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(14000),
  });
  if (!res.ok) throw new Error(`Market feed ${res.status}`);
  return (await res.json()) as T;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const ret: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return ret;
}

function clean(nums: Array<number | null> | undefined): number[] {
  return (nums ?? []).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
}

type SparkPayload = {
  spark?: {
    result?: Array<{
      symbol: string;
      response?: Array<{
        meta: SparkMeta;
        timestamp?: number[];
        indicators?: { quote?: QuoteBlock[] };
      }>;
    }>;
  };
};

async function fetchSpark(symbols: string[], range: string, interval: string) {
  const url =
    `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.map(encodeURIComponent).join(",")}` +
    `&range=${range}&interval=${interval}`;
  const data = await yahooJson<SparkPayload>(url);
  return data.spark?.result ?? [];
}

type ChartPayload = {
  chart?: {
    result?: Array<{
      meta: SparkMeta;
      timestamp?: number[];
      events?: {
        dividends?: Record<string, { amount: number; date: number }>;
        splits?: Record<string, { date: number; numerator: number; denominator: number }>;
      };
      indicators?: { quote?: QuoteBlock[] };
    }>;
    error?: unknown;
  };
};

async function fetchChart(symbol: string, range: string, interval: string, events = false) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}${events ? "&events=div%7Csplit" : ""}`;
  const data = await yahooJson<ChartPayload>(url);
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(`No chart for ${symbol}`);
  return result;
}

function barsFrom(timestamp: number[] | undefined, quote: QuoteBlock | undefined): Bar[] {
  if (!timestamp || !quote?.close) return [];
  const bars: Bar[] = [];
  for (let i = 0; i < timestamp.length; i++) {
    const c = quote.close[i];
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    bars.push({
      t: timestamp[i]! * 1000,
      o: quote.open?.[i] ?? c,
      h: quote.high?.[i] ?? c,
      l: quote.low?.[i] ?? c,
      c,
      v: quote.volume?.[i] ?? 0,
    });
  }
  return bars;
}

function quoteFromMeta(
  yahoo: string,
  meta: SparkMeta,
  closes: number[],
  volumes: number[],
  extras: { yield: number | null; lastDiv: StockQuote["lastDividend"] },
): StockQuote | null {
  const info = UNIVERSE_BY_YAHOO.get(yahoo);
  const price = meta.regularMarketPrice;
  if (!info || price == null || !Number.isFinite(price)) return null;
  const changePct = meta.regularMarketChangePercent ?? meta.fulldayChangePercent ?? 0;
  const change =
    meta.fulldayChange ?? (Number.isFinite(changePct) ? (price * changePct) / 100 : 0);
  const avgVol = mean(volumes.slice(-20));
  const lastVol = meta.regularMarketVolume ?? volumes.at(-1) ?? 0;
  return {
    symbol: info.symbol,
    yahoo,
    name: info.name,
    sector: info.sector,
    price,
    change,
    changePct,
    volume: lastVol,
    dayHigh: meta.regularMarketDayHigh ?? price,
    dayLow: meta.regularMarketDayLow ?? price,
    week52High: meta.fiftyTwoWeekHigh ?? price,
    week52Low: meta.fiftyTwoWeekLow ?? price,
    rsi: rsi(closes, 14),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    mom5: momentumPct(closes, 5),
    mom21: momentumPct(closes, 21),
    relVolume: avgVol && avgVol > 0 ? lastVol / avgVol : null,
    dividendYield: extras.yield,
    lastDividend: extras.lastDiv,
    spark: closes.slice(-32),
  };
}

function parseEvents(
  symbol: string,
  events:
    | {
        dividends?: Record<string, { amount: number; date: number }>;
        splits?: Record<string, { date: number; numerator: number; denominator: number }>;
      }
    | undefined,
): EventPack {
  const actions: CorporateAction[] = [];
  const divs = Object.values(events?.dividends ?? {}).sort((a, b) => b.date - a.date);
  const splits = Object.values(events?.splits ?? {}).sort((a, b) => b.date - a.date);
  for (const d of divs.slice(0, 4)) {
    actions.push({
      symbol,
      kind: "dividend",
      date: d.date * 1000,
      label: `₹${d.amount.toFixed(2)} dividend`,
      detail: "Cash dividend recorded on the NSE tape (Yahoo events)",
    });
  }
  for (const s of splits.slice(0, 2)) {
    actions.push({
      symbol,
      kind: "bonus",
      date: s.date * 1000,
      label: `Bonus / split ${s.numerator}-for-${s.denominator}`,
      detail: "Corporate action as a split on the public feed — often a bonus issue in India",
    });
  }
  const yearAgo = Date.now() / 1000 - 365 * 86400;
  const trailing = divs.filter((d) => d.date >= yearAgo).reduce((a, d) => a + d.amount, 0);
  return {
    actions,
    trailing,
    lastDiv: divs[0] ? { date: divs[0].date, amount: divs[0].amount } : null,
  };
}

async function fetchEventPack(yahoo: string, symbol: string): Promise<EventPack> {
  const chart = await fetchChart(yahoo, "2y", "1d", true);
  return parseEvents(symbol, chart.events);
}

export async function buildMarketBoard(): Promise<MarketBoard> {
  const { session, label } = marketSession();
  const ttl = session === "open" ? 55_000 : session === "pre" ? 90_000 : 12 * 60_000;

  return cachedStale("board:v4", ttl, async () => {
    const yahooSymbols = UNIVERSE.map((s) => s.yahoo);
    const batches = chunk(yahooSymbols, 12);
    const eventTargets = UNIVERSE.filter((s) => s.dividendFocus);
    const eventTtl = 6 * 60 * 60 * 1000;

    const [sparkResultsNested, eventPacks, indexRows] = await Promise.all([
      pool(batches, 5, (batch) => fetchSpark(batch, "1y", "1d")),
      cachedStale("events:v2", eventTtl, async () => {
        const entries = await pool(eventTargets, 6, async (s) => {
          try {
            const pack = await fetchEventPack(s.yahoo, s.symbol);
            return [s.symbol, pack] as const;
          } catch {
            return [s.symbol, { actions: [], trailing: 0, lastDiv: null }] as const;
          }
        });
        return Object.fromEntries(entries) as Record<string, EventPack>;
      }),
      cachedStale("idx:v2", ttl, () =>
        fetchSpark(
          INDICES.map((i) => i.yahoo),
          "5d",
          "1d",
        ),
      ),
    ]);
    const sparkResults = sparkResultsNested.flat();

    const quotes: StockQuote[] = [];
    for (const row of sparkResults) {
      const response = row.response?.[0];
      if (!response) continue;
      const closes = clean(response.indicators?.quote?.[0]?.close);
      const volumes = clean(response.indicators?.quote?.[0]?.volume);
      const info = UNIVERSE_BY_YAHOO.get(row.symbol);
      const pack = info ? eventPacks[info.symbol] : undefined;
      const trailing = pack?.trailing ?? 0;
      const price = response.meta.regularMarketPrice;
      const q = quoteFromMeta(row.symbol, response.meta, closes, volumes, {
        yield: price && trailing > 0 ? trailing / price : null,
        lastDiv: pack?.lastDiv ?? null,
      });
      if (q) quotes.push(q);
    }

    const indices: IndexQuote[] = [];
    for (const def of INDICES) {
      const row = indexRows.find((r) => r.symbol === def.yahoo);
      const meta = row?.response?.[0]?.meta;
      if (!meta?.regularMarketPrice) continue;
      const changePct = meta.regularMarketChangePercent ?? meta.fulldayChangePercent ?? 0;
      indices.push({
        symbol: def.yahoo,
        name: def.name,
        price: meta.regularMarketPrice,
        change: meta.fulldayChange ?? (meta.regularMarketPrice * changePct) / 100,
        changePct,
        dayHigh: meta.regularMarketDayHigh ?? meta.regularMarketPrice,
        dayLow: meta.regularMarketDayLow ?? meta.regularMarketPrice,
      });
    }

    const breadth = quotes.reduce(
      (acc, q) => {
        if (q.changePct > 0.05) acc.up += 1;
        else if (q.changePct < -0.05) acc.down += 1;
        else acc.flat += 1;
        return acc;
      },
      { up: 0, down: 0, flat: 0 },
    );

    const actions = Object.values(eventPacks)
      .flatMap((p) => p.actions)
      .sort((a, b) => b.date - a.date)
      .slice(0, 18);

    return {
      asOf: Date.now(),
      asOfLabel: formatIstStamp(),
      session,
      sessionLabel: label,
      source: "Yahoo Finance (NSE / BSE public feed)",
      indices,
      breadth,
      quotes: quotes.sort((a, b) => a.symbol.localeCompare(b.symbol)),
      picks: {
        intraday: rankPicks(quotes, "intraday"),
        short: rankPicks(quotes, "short"),
        long: rankPicks(quotes, "long"),
        dividend: rankPicks(quotes, "dividend"),
      },
      sets: buildSets(quotes),
      actions,
    };
  });
}

export async function buildStockDetail(symbol: string): Promise<StockDetail> {
  const info = UNIVERSE_BY_SYMBOL.get(symbol.toUpperCase());
  if (!info) throw new Error("This name is not on the Artha board");
  const { session } = marketSession();
  const ttl = session === "open" ? 45_000 : 10 * 60_000;

  return cachedStale(`stock:${info.symbol}`, ttl, async () => {
    const [daily, intra] = await Promise.all([
      fetchChart(info.yahoo, "1y", "1d", true),
      fetchChart(info.yahoo, "1d", "5m", false).catch(() => null),
    ]);
    const dailyBars = barsFrom(daily.timestamp, daily.indicators?.quote?.[0]);
    const intraBars = intra ? barsFrom(intra.timestamp, intra.indicators?.quote?.[0]) : [];
    const closes = dailyBars.map((b) => b.c);
    const volumes = dailyBars.map((b) => b.v);
    const parsed = parseEvents(info.symbol, daily.events);
    const meta = daily.meta;
    const quote = quoteFromMeta(info.yahoo, meta, closes, volumes, {
      yield: meta.regularMarketPrice && parsed.trailing > 0 ? parsed.trailing / meta.regularMarketPrice : null,
      lastDiv: parsed.lastDiv,
    });
    if (!quote) throw new Error("No quote for this symbol");

    return {
      quote,
      session,
      asOfLabel: formatIstStamp(),
      series: { daily: dailyBars, intraday: intraBars },
      scores: scoreAll(quote),
      actions: parsed.actions,
    };
  });
}
