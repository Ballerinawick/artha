import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

export function SheetContent({
  className,
  children,
  side = "right",
  title,
  ...props
}: ComponentProps<typeof Dialog.Content> & { side?: "right" | "left"; title: string }) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-bg/70" />
      <Dialog.Content
        className={cn(
          "fixed z-50 flex h-full w-full max-w-md flex-col bg-surface p-5 shadow-[var(--shadow-border)]",
          side === "right" ? "inset-y-0 right-0" : "inset-y-0 left-0",
          className,
        )}
        {...props}
      >
        <div className="mb-4 flex items-center justify-between">
          <Dialog.Title className="font-display text-xl text-fg">{title}</Dialog.Title>
          <Dialog.Close className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </Dialog.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}
