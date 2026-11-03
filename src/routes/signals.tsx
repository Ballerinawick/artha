import { createFileRoute } from "@tanstack/react-router";
import { PremiumDesk } from "@/components/premium-desk";

export const Route = createFileRoute("/signals")({
  component: PremiumDesk,
});
