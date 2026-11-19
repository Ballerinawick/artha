import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { connectDhan } from "@/lib/dhan/server";
import { useDhanCreds, useDhanSession } from "@/lib/dhan/session";
import { marketSession } from "@/lib/market/hours";

const GATES = [
  { step: "01", name: "Ticks", detail: "Nifty, the ATM call, and the ATM put on Dhan’s socket" },
  { step: "02", name: "One-minute bars", detail: "Built from arrival time, not a noisy exchange clock" },
  { step: "03", name: "Cost", detail: "No paper unless the swing can pay ₹40 plus the spread" },
  { step: "04", name: "Hold", detail: "Stay in until the target, or the break fails after five minutes" },
];

export function ConnectView() {
  const setCreds = useDhanSession((s) => s.setCreds);
  const creds = useDhanCreds();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState("");
  const [phase, setPhase] = useState("");
  const [standalone, setStandalone] = useState(true);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const done = () => setReady(true);
    if (useDhanSession.persist.hasHydrated()) done();
    return useDhanSession.persist.onFinishHydration(done);
  }, []);

  useEffect(() => {
    if (ready && creds) void navigate({ to: "/signals" });
  }, [ready, creds, navigate]);

  useEffect(() => {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    setStandalone(window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true);
  }, []);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(
        new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(now) + " IST",
      );
      setPhase(marketSession(now).label);
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);

  async function start() {
    setBusy(true);
    setError("");
    try {
      const res = await connectDhan({ data: {} });
      setCreds(res.clientId, res.accessToken);
      await navigate({ to: "/signals" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach Dhan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto grid min-h-dvh max-w-5xl content-center gap-10 px-4 py-10 pt-safe pb-safe lg:grid-cols-2 lg:items-center">
      <section>
        <p className="text-xs font-medium text-muted">{clock ? `${clock} · ${phase}` : "NSE cash session"}</p>
        <h1 className="mt-3 font-display text-5xl tracking-tight sm:text-6xl">Artha</h1>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
          The live Nifty call and put. Ticks build one-minute bars. A paper opens only when that swing is large enough to pay the ₹40 round trip and the spread, then it is held for the target. This phone does not send orders.
        </p>
        <ol className="mt-8 grid grid-cols-2 gap-3">
          {GATES.map((gate) => (
            <li key={gate.step} className="rounded-xl bg-surface px-3 py-3 shadow-[var(--shadow-border)]">
              <p className="text-xs text-subtle">{gate.step}</p>
              <p className="mt-1 font-display text-xl tracking-tight">{gate.name}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{gate.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <h2 className="font-display text-3xl tracking-tight">Arm the desk</h2>
        <p className="mt-2 text-sm text-muted">
          Artha connects with the Dhan API credentials configured for this app. Your API secret, PIN, and TOTP secret
          stay on the server; a fresh access token is created automatically.
        </p>
        <form
          className="mt-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          {error ? <p className="text-sm text-down">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Connecting to Dhan…" : "Connect Dhan"}
          </Button>
        </form>
        <p className="mt-5 text-xs leading-relaxed text-subtle">
          Paper results are after costs, not an accuracy score. One red minute does not close the trade. There is no live order.
        </p>
        {standalone ? null : (
          <a href="/?install=1&platform=ios" className="mt-4 inline-flex h-11 items-center text-sm text-fg underline">
            Add Artha to your iPhone Home Screen
          </a>
        )}
      </section>
    </main>
  );
}
