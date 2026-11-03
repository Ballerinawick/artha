import { createFileRoute } from "@tanstack/react-router";
import { AltDesk } from "@/components/alt-desk";

export const Route = createFileRoute("/bank")({
  component: function BankPage() {
    return <AltDesk symbol="BANKNIFTY" />;
  },
});
