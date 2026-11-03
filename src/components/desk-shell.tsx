import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeftRight, ChartNoAxesCombined, Landmark, LineChart, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { useAltEngine } from "@/lib/dhan/use-alt-engine";
import { useDhanSession } from "@/lib/dhan/session";
import { cn } from "@/lib/utils";

const LINKS = [
  { to: "/signals", label: "Signals", icon: ChartNoAxesCombined },
  { to: "/bank", label: "Bank", icon: Landmark },
  { to: "/stocks", label: "Stocks", icon: LineChart },
  { to: "/desk", label: "Desk", icon: Wallet },
  { to: "/position", label: "Position", icon: ArrowLeftRight },
] as const;

export function DeskShell({ children }: { children: ReactNode }) {
  useAltEngine();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const clearToken = useDhanSession((s) => s.clearToken);
  const navigate = useNavigate();

  function lock() {
    clearToken();
    void navigate({ to: "/" });
  }

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-30 border-b border-border bg-bg pt-safe">
        <div className="mx-auto flex h-12 max-w-[1440px] items-center justify-between gap-3 px-4">
          <Link to="/signals" className="font-display text-2xl leading-none tracking-tight">
            Artha
          </Link>
          <div className="flex items-center gap-1">
            <nav className="hidden items-center gap-1 sm:flex">
              {LINKS.map((l) => (
                <Link
                  key={l.to}
                  to={l.to}
                  className={cn(
                    "inline-flex h-11 items-center rounded-full px-4 text-sm",
                    path === l.to ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  {l.label}
                </Link>
              ))}
            </nav>
            <button
              type="button"
              className="inline-flex h-11 items-center rounded-full px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg"
              onClick={lock}
            >
              Lock
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 pt-4 pb-tab">{children}</main>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg pb-safe sm:hidden"
        aria-label="Sections"
      >
        <div className="grid grid-cols-5">
          {LINKS.map((l) => {
            const Icon = l.icon;
            const on = path === l.to;
            return (
              <Link
                key={l.to}
                to={l.to}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-0.5 text-xs",
                  on ? "text-fg" : "text-muted",
                )}
              >
                <Icon className="size-5" strokeWidth={on ? 2.25 : 1.75} />
                {l.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
