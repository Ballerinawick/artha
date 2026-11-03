import { createFileRoute } from "@tanstack/react-router";
import { ConnectView } from "@/components/connect-view";

export const Route = createFileRoute("/")({
  component: ConnectView,
});
