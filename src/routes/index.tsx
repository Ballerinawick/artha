import { createFileRoute } from "@tanstack/react-router";
import { PositionBook } from "@/components/position-book";

export const Route = createFileRoute("/")({
  component: PositionBook,
});
