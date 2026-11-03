import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getLiveTape } from "@/lib/dhan/server";
import { useDhanCreds } from "@/lib/dhan/session";
import { usePaper } from "@/lib/paper";

/** Last traded prices, refreshed every few seconds. Does not pull charts. */
export function useLiveTape(fnoKey = "") {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const creds = useDhanCreds();
  const mark = usePaper((s) => s.mark);
  const trades = usePaper((s) => s.trades);
  const fnoIds = fnoKey ? fnoKey.split(",") : [];

  const query = useQuery({
    queryKey: ["tape", creds?.clientId, fnoKey],
    enabled: ready && !!creds,
    queryFn: () => getLiveTape({ data: { ...creds!, fnoIds } }),
    refetchInterval: 3000,
    staleTime: 2000,
  });

  useEffect(() => {
    const tape = query.data?.tape;
    if (!tape?.length) return;
    for (const trade of trades) {
      const row = tape.find((p) => p.securityId === trade.securityId);
      if (row && row.ltp > 0) mark(trade.id, row.ltp);
    }
  }, [query.data, trades, mark]);

  return query;
}
