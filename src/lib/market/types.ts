export type Horizon = "intraday" | "short" | "long" | "dividend";

export type SessionState = "pre" | "open" | "post" | "closed";

export type HorizonPick = {
  symbol: string;
  score: number;
  action: "Accumulate" | "Watch" | "Avoid";
  reasons: string[];
  risk: string;
};

export type MarketSet = {
  id: string;
  title: string;
  blurb: string;
  symbols: string[];
};

export type CorporateAction = {
  symbol: string;
  kind: "dividend" | "bonus";
  date: number;
  label: string;
  detail: string;
};

export type StockQuote = {
  symbol: string;
  yahoo: string;
  name: string;
  sector: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  dayHigh: number;
  dayLow: number;
  week52High: number;
  week52Low: number;
  rsi: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  mom5: number | null;
  mom21: number | null;
  relVolume: number | null;
  dividendYield: number | null;
  lastDividend: { date: number; amount: number } | null;
  spark: number[];
};

export type IndexQuote = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  dayHigh: number;
  dayLow: number;
};

export type Bar = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type MarketBoard = {
  asOf: number;
  asOfLabel: string;
  session: SessionState;
  sessionLabel: string;
  source: string;
  indices: IndexQuote[];
  breadth: { up: number; down: number; flat: number };
  quotes: StockQuote[];
  picks: Record<Horizon, HorizonPick[]>;
  sets: MarketSet[];
  actions: CorporateAction[];
};

export type StockDetail = {
  quote: StockQuote;
  session: SessionState;
  asOfLabel: string;
  series: { daily: Bar[]; intraday: Bar[] };
  scores: Record<Horizon, HorizonPick>;
  actions: CorporateAction[];
};
