export type UniverseStock = {
  symbol: string;
  yahoo: string;
  name: string;
  sector: string;
  dividendFocus?: boolean;
};

export const UNIVERSE: UniverseStock[] = [
  { symbol: "RELIANCE", yahoo: "RELIANCE.NS", name: "Reliance Industries", sector: "Energy" },
  { symbol: "TCS", yahoo: "TCS.NS", name: "Tata Consultancy", sector: "IT" },
  { symbol: "HDFCBANK", yahoo: "HDFCBANK.NS", name: "HDFC Bank", sector: "Banking" },
  { symbol: "BHARTIARTL", yahoo: "BHARTIARTL.NS", name: "Bharti Airtel", sector: "Telecom" },
  { symbol: "ICICIBANK", yahoo: "ICICIBANK.NS", name: "ICICI Bank", sector: "Banking" },
  { symbol: "SBIN", yahoo: "SBIN.NS", name: "State Bank of India", sector: "Banking" },
  { symbol: "INFY", yahoo: "INFY.NS", name: "Infosys", sector: "IT" },
  { symbol: "BAJFINANCE", yahoo: "BAJFINANCE.NS", name: "Bajaj Finance", sector: "Financials" },
  { symbol: "HINDUNILVR", yahoo: "HINDUNILVR.NS", name: "Hindustan Unilever", sector: "FMCG", dividendFocus: true },
  { symbol: "LICI", yahoo: "LICI.NS", name: "LIC of India", sector: "Insurance" },
  { symbol: "ITC", yahoo: "ITC.NS", name: "ITC", sector: "FMCG", dividendFocus: true },
  { symbol: "LT", yahoo: "LT.NS", name: "Larsen & Toubro", sector: "Infra" },
  { symbol: "KOTAKBANK", yahoo: "KOTAKBANK.NS", name: "Kotak Mahindra Bank", sector: "Banking" },
  { symbol: "AXISBANK", yahoo: "AXISBANK.NS", name: "Axis Bank", sector: "Banking" },
  { symbol: "HCLTECH", yahoo: "HCLTECH.NS", name: "HCL Technologies", sector: "IT" },
  { symbol: "MARUTI", yahoo: "MARUTI.NS", name: "Maruti Suzuki", sector: "Auto" },
  { symbol: "SUNPHARMA", yahoo: "SUNPHARMA.NS", name: "Sun Pharma", sector: "Pharma" },
  { symbol: "M&M", yahoo: "M&M.NS", name: "Mahindra & Mahindra", sector: "Auto" },
  { symbol: "ULTRACEMCO", yahoo: "ULTRACEMCO.NS", name: "UltraTech Cement", sector: "Cement" },
  { symbol: "NTPC", yahoo: "NTPC.NS", name: "NTPC", sector: "Power", dividendFocus: true },
  { symbol: "POWERGRID", yahoo: "POWERGRID.NS", name: "Power Grid", sector: "Power", dividendFocus: true },
  { symbol: "TITAN", yahoo: "TITAN.NS", name: "Titan Company", sector: "Consumer" },
  { symbol: "TATASTEEL", yahoo: "TATASTEEL.NS", name: "Tata Steel", sector: "Metals" },
  { symbol: "ADANIPORTS", yahoo: "ADANIPORTS.NS", name: "Adani Ports", sector: "Infra" },
  { symbol: "ADANIENT", yahoo: "ADANIENT.NS", name: "Adani Enterprises", sector: "Conglomerate" },
  { symbol: "COALINDIA", yahoo: "COALINDIA.NS", name: "Coal India", sector: "Energy", dividendFocus: true },
  { symbol: "BAJAJFINSV", yahoo: "BAJAJFINSV.NS", name: "Bajaj Finserv", sector: "Financials" },
  { symbol: "ONGC", yahoo: "ONGC.NS", name: "ONGC", sector: "Energy", dividendFocus: true },
  { symbol: "BEL", yahoo: "BEL.NS", name: "Bharat Electronics", sector: "Defence" },
  { symbol: "JSWSTEEL", yahoo: "JSWSTEEL.NS", name: "JSW Steel", sector: "Metals" },
  { symbol: "NESTLEIND", yahoo: "NESTLEIND.NS", name: "Nestlé India", sector: "FMCG" },
  { symbol: "WIPRO", yahoo: "WIPRO.NS", name: "Wipro", sector: "IT" },
  { symbol: "TRENT", yahoo: "TRENT.NS", name: "Trent", sector: "Consumer" },
  { symbol: "ASIANPAINT", yahoo: "ASIANPAINT.NS", name: "Asian Paints", sector: "Consumer" },
  { symbol: "TATAMOTORS", yahoo: "TATAMOTORS.NS", name: "Tata Motors", sector: "Auto" },
  { symbol: "GRASIM", yahoo: "GRASIM.NS", name: "Grasim Industries", sector: "Conglomerate" },
  { symbol: "HINDALCO", yahoo: "HINDALCO.NS", name: "Hindalco", sector: "Metals" },
  { symbol: "TECHM", yahoo: "TECHM.NS", name: "Tech Mahindra", sector: "IT" },
  { symbol: "CIPLA", yahoo: "CIPLA.NS", name: "Cipla", sector: "Pharma" },
  { symbol: "SBILIFE", yahoo: "SBILIFE.NS", name: "SBI Life", sector: "Insurance" },
  { symbol: "HDFCLIFE", yahoo: "HDFCLIFE.NS", name: "HDFC Life", sector: "Insurance" },
  { symbol: "DRREDDY", yahoo: "DRREDDY.NS", name: "Dr. Reddy's", sector: "Pharma" },
  { symbol: "EICHERMOT", yahoo: "EICHERMOT.NS", name: "Eicher Motors", sector: "Auto" },
  { symbol: "APOLLOHOSP", yahoo: "APOLLOHOSP.NS", name: "Apollo Hospitals", sector: "Healthcare" },
  { symbol: "TATACONSUM", yahoo: "TATACONSUM.NS", name: "Tata Consumer", sector: "FMCG" },
  { symbol: "SHRIRAMFIN", yahoo: "SHRIRAMFIN.NS", name: "Shriram Finance", sector: "Financials" },
  { symbol: "BPCL", yahoo: "BPCL.NS", name: "Bharat Petroleum", sector: "Energy", dividendFocus: true },
  { symbol: "INDUSINDBK", yahoo: "INDUSINDBK.NS", name: "IndusInd Bank", sector: "Banking" },
  { symbol: "HEROMOTOCO", yahoo: "HEROMOTOCO.NS", name: "Hero MotoCorp", sector: "Auto", dividendFocus: true },
  { symbol: "BRITANNIA", yahoo: "BRITANNIA.NS", name: "Britannia", sector: "FMCG" },
  { symbol: "BAJAJ-AUTO", yahoo: "BAJAJ-AUTO.NS", name: "Bajaj Auto", sector: "Auto" },
  { symbol: "JIOFIN", yahoo: "JIOFIN.NS", name: "Jio Financial", sector: "Financials" },
  { symbol: "VEDL", yahoo: "VEDL.NS", name: "Vedanta", sector: "Metals", dividendFocus: true },
  { symbol: "HINDZINC", yahoo: "HINDZINC.NS", name: "Hindustan Zinc", sector: "Metals", dividendFocus: true },
  { symbol: "IOC", yahoo: "IOC.NS", name: "Indian Oil", sector: "Energy", dividendFocus: true },
  { symbol: "GAIL", yahoo: "GAIL.NS", name: "GAIL India", sector: "Energy", dividendFocus: true },
  { symbol: "RECLTD", yahoo: "RECLTD.NS", name: "REC", sector: "Financials", dividendFocus: true },
  { symbol: "PFC", yahoo: "PFC.NS", name: "Power Finance", sector: "Financials", dividendFocus: true },
  { symbol: "OIL", yahoo: "OIL.NS", name: "Oil India", sector: "Energy", dividendFocus: true },
];

export const UNIVERSE_BY_SYMBOL = new Map(UNIVERSE.map((s) => [s.symbol, s]));
export const UNIVERSE_BY_YAHOO = new Map(UNIVERSE.map((s) => [s.yahoo, s]));

export const INDICES = [
  { yahoo: "^NSEI", name: "Nifty 50" },
  { yahoo: "^BSESN", name: "Sensex" },
  { yahoo: "^NSEBANK", name: "Bank Nifty" },
  { yahoo: "^INDIAVIX", name: "India VIX" },
] as const;

export const HORIZONS: { id: Horizon; label: string; blurb: string }[] = [
  { id: "intraday", label: "Intraday", blurb: "Same-session momentum, volume and range" },
  { id: "short", label: "Short term", blurb: "Days to a few weeks — RSI, 20/50 DMA" },
  { id: "long", label: "Long term", blurb: "Months to years — 200 DMA and compounding" },
  { id: "dividend", label: "Bonus & dividend", blurb: "Yield, payout cadence, bonus/splits" },
];

export type Horizon = import("./types").Horizon;
