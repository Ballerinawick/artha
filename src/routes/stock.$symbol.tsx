import { createFileRoute } from "@tanstack/react-router";
import { StockView } from "@/components/stock-view";
import { getStockDetail } from "@/lib/market/server";
import { UNIVERSE_BY_SYMBOL } from "@/lib/market/universe";

export const Route = createFileRoute("/stock/$symbol")({
  loader: async ({ params }) => {
    const symbol = params.symbol.toUpperCase();
    if (!UNIVERSE_BY_SYMBOL.has(symbol)) return null;
    try {
      return await getStockDetail({ data: { symbol } });
    } catch {
      return null;
    }
  },
  component: StockPage,
});

function StockPage() {
  const { symbol } = Route.useParams();
  const initial = Route.useLoaderData();
  return <StockView symbol={symbol.toUpperCase()} initial={initial ?? undefined} />;
}
