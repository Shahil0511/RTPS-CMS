"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/format";
import { saveAlertSettingsAction } from "@/server/actions/alerts";
import { idle } from "@/server/action-utils";

export interface AlertSettingsValues {
  offlineGraceMinutes: number;
  dailyReportHour: number;
  dailyReportEnabled: boolean;
  alertsEnabled: boolean;
}

/** Accessible switch that posts "on" through a hidden input, like a checkbox. */
function Switch({ name, checked, onChange, label, description }: { name: string; checked: boolean; onChange: (v: boolean) => void; label: string; description: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-text">{label}</p>
        <p className="text-[12px] text-faint">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full", checked ? "bg-success" : "bg-border-strong")}
      >
        <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </button>
      {checked ? <input type="hidden" name={name} value="on" /> : null}
    </div>
  );
}

const hourLabel = (h: number) => `${h.toString().padStart(2, "0")}:00`;

export function AlertSettingsForm({ initial, timeZone }: { initial: AlertSettingsValues; timeZone: string }) {
  const [state, action, pending] = useActionState(saveAlertSettingsAction, idle);
  const [alertsEnabled, setAlertsEnabled] = useState(initial.alertsEnabled);
  const [dailyEnabled, setDailyEnabled] = useState(initial.dailyReportEnabled);
  const [grace, setGrace] = useState(String(initial.offlineGraceMinutes));
  const toast = useToast();
  const router = useRouter();

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Saved");
      router.refresh();
    } else if (state.error) toast.error(state.error);
  }, [state, toast, router]);

  const graceN = Number(grace);

  return (
    <Card>
      <CardHeader title="Alert rules" description="Applies to recorders and cameras the server can reach (Live). Pending-network and cloud-only recorders are never alerted on." />
      <CardBody>
        <form action={action} className="space-y-4" noValidate>
          <Switch name="alertsEnabled" checked={alertsEnabled} onChange={setAlertsEnabled} label="Offline / online emails" description="Master switch. Downtime is still logged when off." />
          <Field
            label="Grace period before alerting"
            htmlFor="grace"
            error={state.fieldErrors?.offlineGraceMinutes}
            hint={
              Number.isFinite(graceN) && graceN === 0
                ? "Alert on the first failed check. Expect noise from brief network blips."
                : `Only alert when something stays offline for ${Number.isFinite(graceN) ? graceN : "…"} min. Shorter blips are logged but not emailed.`
            }
          >
            <div className={cn("flex items-center gap-2", !alertsEnabled && "opacity-60")}>
              <Input id="grace" name="offlineGraceMinutes" type="number" min={0} max={1440} step={1} value={grace} onChange={(e) => setGrace(e.target.value)} className="w-24" />
              <span className="text-[13px] text-muted">minutes</span>
            </div>
          </Field>
          <div className="border-t border-border pt-4">
            <Switch name="dailyReportEnabled" checked={dailyEnabled} onChange={setDailyEnabled} label="Daily health report" description="Which cameras went offline, when, for how long, and their status now." />
          </div>
          <Field label="Send at" htmlFor="hour" hint={`Once a day at this hour, ${timeZone} time.`}>
            <Select id="hour" name="dailyReportHour" defaultValue={String(initial.dailyReportHour)} className={cn("w-32", !dailyEnabled && "opacity-60")}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end border-t border-border pt-4">
            <Button type="submit" loading={pending}>
              Save rules
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
