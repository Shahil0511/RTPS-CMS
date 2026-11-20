"use client";

import { useState, useTransition } from "react";
import { Button, type ButtonProps } from "./button";
import { Dialog, DialogFooter } from "./dialog";
import { useToast } from "./toast";
import type { ActionState } from "@/server/action-utils";

/**
 * Button that asks for confirmation in a dialog, then runs a server action
 * and reports the outcome as a toast.
 */
export function ConfirmButton({
  title,
  description,
  confirmLabel = "Confirm",
  action,
  onDone,
  children,
  ...rest
}: Omit<ButtonProps, "onClick"> & {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  action: () => Promise<ActionState>;
  onDone?: (state: ActionState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();

  const run = () =>
    start(async () => {
      const state = await action();
      if (state.ok) toast.success(state.message ?? "Done");
      else toast.error(state.error ?? "Something went wrong");
      setOpen(false);
      onDone?.(state);
    });

  return (
    <>
      <Button {...rest} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title} size="sm">
        {description ? <p className="text-sm text-muted">{description}</p> : null}
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant={rest.variant === "danger" ? "danger" : "primary"} onClick={run} loading={pending}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
