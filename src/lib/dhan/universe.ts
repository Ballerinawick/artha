export type DhanName = {
  symbol: string;
  name: string;
  securityId: string;
  segment: "NSE_EQ" | "IDX_I";
  instrument: "EQUITY" | "INDEX";
};

/** Security IDs from the Dhan scrip master (NSE EQ / index). */
export const NAMES: DhanName[] = [
  { symbol: "NIFTY", name: "Nifty 50", securityId: "13", segment: "IDX_I", instrument: "INDEX" },
  { symbol: "BANKNIFTY", name: "Nifty Bank", securityId: "25", segment: "IDX_I", instrument: "INDEX" },
  { symbol: "RELIANCE", name: "Reliance", securityId: "2885", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "TCS", name: "TCS", securityId: "11536", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "HDFCBANK", name: "HDFC Bank", securityId: "1333", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "INFY", name: "Infosys", securityId: "1594", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "ICICIBANK", name: "ICICI Bank", securityId: "4963", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "SBIN", name: "SBI", securityId: "3045", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", securityId: "10604", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "ITC", name: "ITC", securityId: "1660", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "LT", name: "L&T", securityId: "11483", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "AXISBANK", name: "Axis Bank", securityId: "5900", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "KOTAKBANK", name: "Kotak Bank", securityId: "1922", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", securityId: "317", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", securityId: "1394", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "MARUTI", name: "Maruti", securityId: "10999", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "SUNPHARMA", name: "Sun Pharma", securityId: "3351", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "HCLTECH", name: "HCL Tech", securityId: "7229", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "WIPRO", name: "Wipro", securityId: "3787", segment: "NSE_EQ", instrument: "EQUITY" },
  { symbol: "TMPV", name: "Tata Motors PV", securityId: "3456", segment: "NSE_EQ", instrument: "EQUITY" },
];

export const STOCKS = NAMES.filter((n) => n.instrument === "EQUITY");
export const INDEXES = NAMES.filter((n) => n.instrument === "INDEX");

/** Small slices so each server call stays inside Dhan's data rate limit and the function timeout. */
export const SCAN_GROUPS: string[][] = [
  ...chunk(
    STOCKS.map((s) => s.symbol),
    4,
  ),
  INDEXES.map((s) => s.symbol),
];

function chunk(items: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Contract lot from the Oct 2026 scrip master. Equity paper size stays 1 share. */
export const LOTS: Record<string, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
};
