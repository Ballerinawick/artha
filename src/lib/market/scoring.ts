import { clamp } from "./indicators";
import type { Horizon, HorizonPick, MarketSet, StockQuote } from "./types";
import { UNIVERSE_BY_SYMBOL } from "./universe";

function actionFor(score: number): HorizonPick["action"] {
  if (score >= 70) return "Accumulate";
  if (score >= 45) return "Watch";
  return "Avoid";
}

function rangePos(price: number, low: number, high: number): number | null {
  if (!(high > low)) return null;
  return (price - low) / (high - low);
}

export function scoreIntraday(q: StockQuote): HorizonPick {
  const reasons: string[] = [];
  let score = 42;
  const rel = q.relVolume;
  const chg = q.changePct;
  const pos = rangePos(q.price, q.dayLow, q.dayHigh);
  const stretch = rangePos(q.price, q.week52Low, q.week52High);

  if (rel != null) {
    if (rel >= 1.8) {
      score += 18;
      reasons.push(`Volume ${rel.toFixed(1)}× the recent average — tape is active`);
    } else if (rel >= 1.2) {
      score += 10;
      reasons.push("Volume running ahead of average");
    } else if (rel < 0.7) {
      score -= 8;
      reasons.push("Quiet volume — weaker conviction");
    }
  }

  if (chg >= 1.2 && chg <= 3.5) {
    score += 16;
    reasons.push(`Orderly bid, up ${chg.toFixed(2)}% on the session`);
  } else if (chg > 3.5) {
    score += 6;
    reasons.push(`Extended on the day (+${chg.toFixed(2)}%) — chase less, trail more`);
  } else if (chg <= -2) {
    score -= 10;
    reasons.push(`Session pressure ${chg.toFixed(2)}% — wait for a base`);
  } else if (chg > 0) {
    score += 8;
    reasons.push("Holding a modest green tape");
  }

  if (pos != null) {
    if (pos >= 0.7 && chg > 0) {
      score += 12;
      reasons.push("Trading in the top of today's range");
    } else if (pos <= 0.25) {
      score -= 6;
      reasons.push("Stuck near the session low");
    }
  }

  if (q.rsi != null && q.rsi > 72) {
    score -= 8;
    reasons.push("Daily RSI is stretched — fade the late push");
  } else if (q.rsi != null && q.rsi < 32 && chg > -1) {
    score += 6;
    reasons.push("Oversold daily RSI with a stabilising tape");
  }

  if (stretch != null && stretch > 0.95) {
    score -= 4;
    reasons.push("Hugging the 52-week high — gap risk");
  }

  if (!reasons.length) reasons.push("No strong intraday tell — keep size small");
  score = clamp(Math.round(score));
  const risk =
    Math.abs(chg) >= 3
      ? "Wide session range — use a hard stop under day's low / VWAP."
      : "Intraday names can reverse after 14:00 IST; don't overnight unless the thesis is short-term.";
  return { symbol: q.symbol, score, action: actionFor(score), reasons: reasons.slice(0, 3), risk };
}

export function scoreShort(q: StockQuote): HorizonPick {
  const reasons: string[] = [];
  let score = 40;
  const above20 = q.sma20 != null && q.price > q.sma20;
  const above50 = q.sma50 != null && q.price > q.sma50;
  const stack = q.sma20 != null && q.sma50 != null && q.sma20 > q.sma50;

  if (q.rsi != null) {
    if (q.rsi >= 38 && q.rsi <= 62) {
      score += 16;
      reasons.push(`RSI ${q.rsi.toFixed(0)} sits in a workable mid-zone`);
    } else if (q.rsi < 32) {
      score += 10;
      reasons.push(`RSI ${q.rsi.toFixed(0)} oversold — bounce watch, not a blind buy`);
    } else if (q.rsi > 72) {
      score -= 8;
      reasons.push(`RSI ${q.rsi.toFixed(0)} is extended for a fresh long`);
    }
  }

  if (above20) {
    score += 12;
    reasons.push("Price holds above the 20-day average");
  } else if (q.sma20) {
    score -= 6;
    reasons.push("Below the 20-day — short-term trend is tired");
  }

  if (stack) {
    score += 10;
    reasons.push("20-day is above the 50-day (uptrend stack)");
  } else if (above50) {
    score += 5;
  }

  if (q.mom5 != null) {
    if (q.mom5 >= 1 && q.mom5 <= 8) {
      score += 10;
      reasons.push(`5-day thrust ${q.mom5.toFixed(1)}% without a blow-off`);
    } else if (q.mom5 > 10) {
      score -= 4;
      reasons.push("Very sharp 5-day run — wait for a pause");
    } else if (q.mom5 < -6) {
      score -= 6;
      reasons.push("5-day slide — let it stop going down first");
    }
  }

  if (q.mom21 != null && q.mom21 > 0 && above20) {
    score += 6;
    reasons.push("Positive 1-month drift with the moving average");
  }

  if (!reasons.length) reasons.push("Mixed short-term tape — needs a trigger");
  score = clamp(Math.round(score));
  return {
    symbol: q.symbol,
    score,
    action: actionFor(score),
    reasons: reasons.slice(0, 3),
    risk: "A close back under the 20-day with rising volume invalidates the swing.",
  };
}

export function scoreLong(q: StockQuote): HorizonPick {
  const reasons: string[] = [];
  let score = 38;
  const above200 = q.sma200 != null && q.price > q.sma200;
  const golden = q.sma50 != null && q.sma200 != null && q.sma50 > q.sma200;
  const stretch = rangePos(q.price, q.week52Low, q.week52High);

  if (above200) {
    score += 18;
    reasons.push("Price is above the 200-day — primary trend still up");
  } else if (q.sma200) {
    const gap = ((q.price - q.sma200) / q.sma200) * 100;
    if (gap > -8) {
      score += 4;
      reasons.push("Testing the 200-day — long-term buyers watch this zone");
    } else {
      score -= 10;
      reasons.push("Well below the 200-day — repair first, invest later");
    }
  }

  if (golden) {
    score += 12;
    reasons.push("50-day above the 200-day (longer uptrend intact)");
  }

  if (q.mom21 != null && q.mom21 > 0 && above200) {
    score += 8;
    reasons.push("Constructive 1-month close versus the long average");
  }

  if (stretch != null) {
    if (stretch >= 0.55 && stretch <= 0.88) {
      score += 10;
      reasons.push("In the upper half of the 52-week range, not yet vertical");
    } else if (stretch > 0.93) {
      score -= 4;
      reasons.push("Pressed into the 52-week high — add on dips, not FOMO");
    } else if (stretch < 0.25 && above200) {
      score += 6;
      reasons.push("Quality name sitting in the lower quartile — value watch");
    }
  }

  if (q.dividendYield != null && q.dividendYield >= 0.015) {
    score += 6;
    reasons.push(`Pays ${ (q.dividendYield * 100).toFixed(1) }% — compounding kicker`);
  }

  if (!reasons.length) reasons.push("Long-term picture is unfinished — wait for the 200-day");
  score = clamp(Math.round(score));
  return {
    symbol: q.symbol,
    score,
    action: actionFor(score),
    reasons: reasons.slice(0, 3),
    risk: "A weekly close under the 200-day is the line in the sand for a long-term add.",
  };
}

export function scoreDividend(q: StockQuote): HorizonPick {
  const reasons: string[] = [];
  let score = 30;
  const y = q.dividendYield;
  const meta = UNIVERSE_BY_SYMBOL.get(q.symbol);

  if (y != null && y >= 0.04) {
    score += 28;
    reasons.push(`Trailing yield ${(y * 100).toFixed(1)}% from the last twelve months`);
  } else if (y != null && y >= 0.02) {
    score += 18;
    reasons.push(`Respectable ${(y * 100).toFixed(1)}% yield`);
  } else if (y != null && y > 0) {
    score += 6;
    reasons.push("Pays a dividend, but yield is thin versus cash rates");
  } else if (meta?.dividendFocus) {
    score += 4;
    reasons.push("On the dividend watchlist — last payout not in the feed yet");
  } else {
    score -= 6;
    reasons.push("No recent cash dividend in the public feed");
  }

  if (q.lastDividend) {
    const days = (Date.now() / 1000 - q.lastDividend.date) / 86400;
    if (days <= 50) {
      score += 10;
      reasons.push("Ex-date was recent — payout just hit the tape");
    } else if (days >= 80 && days <= 130) {
      score += 12;
      reasons.push("Typical quarterly window is approaching");
    } else if (days > 400) {
      score -= 8;
      reasons.push("Last recorded payout is stale");
    }
  }

  if (q.sma200 != null && q.price > q.sma200) {
    score += 10;
    reasons.push("Yield name still above its 200-day — income without a broken chart");
  } else if (q.sma200) {
    score -= 4;
    reasons.push("Chart is under the 200-day — yield may be a value trap");
  }

  if (y != null && y > 0.09) {
    score -= 8;
    reasons.push("Yield looks too high — check if the cut already happened");
  }

  if (!reasons.length) reasons.push("No bonus/dividend edge on this name today");
  score = clamp(Math.round(score));
  return {
    symbol: q.symbol,
    score,
    action: actionFor(score),
    reasons: reasons.slice(0, 3),
    risk: "Dividends are not guaranteed. Bonus/splits change float — size after the ex-date, not before.",
  };
}

const SCORERS: Record<Horizon, (q: StockQuote) => HorizonPick> = {
  intraday: scoreIntraday,
  short: scoreShort,
  long: scoreLong,
  dividend: scoreDividend,
};

export function scoreAll(q: StockQuote): Record<Horizon, HorizonPick> {
  return {
    intraday: scoreIntraday(q),
    short: scoreShort(q),
    long: scoreLong(q),
    dividend: scoreDividend(q),
  };
}

export function rankPicks(quotes: StockQuote[], horizon: Horizon, n = 8): HorizonPick[] {
  const ranked = quotes
    .map((q) => SCORERS[horizon](q))
    .sort((a, b) => b.score - a.score);
  const preferred = ranked.filter((p) => p.score >= 45);
  return (preferred.length >= 5 ? preferred : ranked).slice(0, n);
}

export function buildSets(quotes: StockQuote[]): MarketSet[] {
  const ranked = (fn: (q: StockQuote) => number, pred: (q: StockQuote) => boolean) =>
    quotes
      .filter(pred)
      .sort((a, b) => fn(b) - fn(a))
      .slice(0, 6)
      .map((q) => q.symbol);

  const defensive = new Set(["FMCG", "Pharma", "Healthcare", "Insurance", "Consumer"]);

  return [
    {
      id: "momentum",
      title: "Momentum",
      blurb: "One-month leaders with a bid and volume.",
      symbols: ranked((q) => q.mom21 ?? -99, (q) => (q.mom21 ?? 0) > 0 && (q.relVolume ?? 1) >= 0.8),
    },
    {
      id: "compounders",
      title: "Compounders",
      blurb: "Above the 200-day, RSI not blown out.",
      symbols: ranked(
        (q) => (q.price / (q.sma200 ?? q.price)) * 10 + (q.mom21 ?? 0),
        (q) => q.sma200 != null && q.price > q.sma200 && q.rsi != null && q.rsi < 70,
      ),
    },
    {
      id: "yield",
      title: "Yield",
      blurb: "Cash-return names from the last twelve months.",
      symbols: ranked((q) => q.dividendYield ?? 0, (q) => (q.dividendYield ?? 0) >= 0.015),
    },
    {
      id: "quality-dip",
      title: "Quality dip",
      blurb: "RSI washed out, still near the long average.",
      symbols: ranked(
        (q) => 40 - (q.rsi ?? 40),
        (q) => q.rsi != null && q.rsi <= 38 && q.sma200 != null && q.price > q.sma200 * 0.92,
      ),
    },
    {
      id: "defensive",
      title: "Defensive",
      blurb: "FMCG, pharma, healthcare, insurance.",
      symbols: ranked(
        (q) => (q.sma200 && q.price > q.sma200 ? 10 : 0) + (q.mom21 ?? 0),
        (q) => defensive.has(q.sector),
      ),
    },
  ].map((set) => ({
    ...set,
    symbols: set.symbols.filter(Boolean).slice(0, 6),
  }));
}
