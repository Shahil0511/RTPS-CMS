"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { changePasswordAction } from "@/server/actions/profile";
import { idle } from "@/server/action-utils";

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, idle);
  const toast = useToast();
  const router = useRouter();

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Password updated");
      router.push("/");
      router.refresh();
    }
  }, [state, toast, router]);

  return (
    <form action={action} className="space-y-4" noValidate>
      <Field label="Current password" htmlFor="currentPassword" error={state.fieldErrors?.currentPassword}>
        <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
      </Field>
      <Field label="New password" htmlFor="newPassword" error={state.fieldErrors?.newPassword}>
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required />
      </Field>
      <Field label="Confirm new password" htmlFor="confirmPassword" error={state.fieldErrors?.confirmPassword}>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required />
      </Field>
      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      <Button type="submit" loading={pending}>
        Update password
      </Button>
    </form>
  );
}
