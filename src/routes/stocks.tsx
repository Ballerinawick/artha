import { createFileRoute } from "@tanstack/react-router";
import { AltDesk } from "@/components/alt-desk";

const STOCKS = ["RELIANCE", "HDFCBANK", "ICICIBANK", "SBIN", "TCS"];

export const Route = createFileRoute("/stocks")({
  component: function StocksPage() {
    return <AltDesk symbols={STOCKS} />;
  },
});
