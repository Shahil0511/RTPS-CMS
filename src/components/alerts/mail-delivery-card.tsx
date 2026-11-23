"use client";

import { CheckCircle2, FileText, Inbox, Send, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { flushOutboxAction, sendDailyReportNowAction, sendTestEmailAction } from "@/server/actions/alerts";
import { idle } from "@/server/action-utils";

export interface MailerInfo {
  configured: boolean;
  host: string | null;
  from: string | null;
  port: number;
  secure: boolean;
  authenticated: boolean;
}

export interface OutboxCounts {
  QUEUED: number;
  SENT: number;
  FAILED: number;
  SKIPPED_NO_SMTP: number;
}

export function MailDeliveryCard({ mailer, stats24h, defaultTestTo, yesterday, dailyRecipients }: { mailer: MailerInfo; stats24h: OutboxCounts; defaultTestTo: string; yesterday: string; dailyRecipients: number }) {
  const [testOpen, setTestOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [flushing, startFlush] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const flush = () =>
    startFlush(async () => {
      const s = await flushOutboxAction();
      if (s.ok) toast.success(s.message ?? "Done");
      else toast.error(s.error ?? "Failed");
      router.refresh();
    });

  const rows: Array<[string, React.ReactNode]> = [
    ["Server", mailer.host ? <span className="font-mono">{mailer.host}:{mailer.port}</span> : <span className="text-faint">not set</span>],
    ["Security", mailer.host ? (mailer.secure ? "TLS (implicit)" : "STARTTLS when offered") : <span className="text-faint">—</span>],
    ["Sign-in", mailer.host ? (mailer.authenticated ? "Username + password (hidden)" : "None") : <span className="text-faint">—</span>],
    ["From", mailer.from ? <span className="font-mono">{mailer.from}</span> : <span className="text-faint">not set</span>],
  ];

  return (
    <Card>
      <CardHeader
        title="Email delivery"
        description="SMTP settings come from the server's .env file."
        action={mailer.configured ? <Badge tone="success"><CheckCircle2 className="h-3 w-3" /> Configured</Badge> : <Badge tone="warning"><TriangleAlert className="h-3 w-3" /> Not configured</Badge>}
      />
      <CardBody>
        {!mailer.configured ? (
          <div className="mb-3 rounded-[6px] bg-warning-soft px-3 py-2 text-[13px] text-warning fade-in">
            Emails are written to the outbox below but not delivered. Set <code className="font-mono">SMTP_HOST</code> and <code className="font-mono">SMTP_FROM</code> (plus{" "}
            <code className="font-mono">SMTP_USER</code>/<code className="font-mono">SMTP_PASS</code> if the server needs sign-in) and restart.
          </div>
        ) : null}
        <dl className="space-y-1.5 text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3">
              <dt className="text-muted">{k}</dt>
              <dd className="truncate text-right text-text">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 grid grid-cols-4 gap-2 rounded-[6px] bg-surface-2 p-2 text-center">
          {(
            [
              ["Sent", stats24h.SENT, "text-success"],
              ["Queued", stats24h.QUEUED, "text-info"],
              ["Failed", stats24h.FAILED, "text-danger"],
              ["Not sent", stats24h.SKIPPED_NO_SMTP, "text-muted"],
            ] as const
          ).map(([label, n, cls]) => (
            <div key={label}>
              <p className={`text-lg font-semibold tabular-nums leading-tight ${n > 0 ? cls : "text-faint"}`}>{n}</p>
              <p className="text-[11px] text-faint">{label}</p>
            </div>
          ))}
        </div>
        <p className="mt-1 text-center text-[11px] text-faint">last 24 hours</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setTestOpen(true)}>
            <Send className="h-4 w-4" /> Send test email
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setReportOpen(true)}>
            <FileText className="h-4 w-4" /> Send daily report now
          </Button>
          <Button variant="ghost" size="sm" onClick={flush} loading={flushing} title="Deliver anything still queued">
            {!flushing ? <Inbox className="h-4 w-4" /> : null} Process outbox
          </Button>
        </div>
      </CardBody>

      <Dialog open={testOpen} onClose={() => setTestOpen(false)} title="Send test email" description="Checks that the SMTP server accepts mail from this app." size="sm">
        <TestEmailForm defaultTo={defaultTestTo} configured={mailer.configured} onDone={() => { setTestOpen(false); router.refresh(); }} onCancel={() => setTestOpen(false)} />
      </Dialog>
      <Dialog open={reportOpen} onClose={() => setReportOpen(false)} title="Send daily report now" description={`Goes to ${dailyRecipients} active recipient${dailyRecipients === 1 ? "" : "s"} with the daily report on, each limited to their location.`} size="sm">
        <DailyReportForm defaultDay={yesterday} onDone={() => { setReportOpen(false); router.refresh(); }} onCancel={() => setReportOpen(false)} />
      </Dialog>
    </Card>
  );
}

function TestEmailForm({ defaultTo, configured, onDone, onCancel }: { defaultTo: string; configured: boolean; onDone: () => void; onCancel: () => void }) {
  const [state, action, pending] = useActionState(sendTestEmailAction, idle);
  const toast = useToast();
  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Sent");
      onDone();
    }
  }, [state, toast, onDone]);
  return (
    <form action={action} noValidate>
      <Field label="Send to" htmlFor="test-to" error={state.fieldErrors?.to}>
        <Input id="test-to" name="to" type="email" defaultValue={defaultTo} required autoFocus />
      </Field>
      {!configured ? <p className="mt-3 text-[13px] text-warning">SMTP is not configured: the message will only appear in the outbox.</p> : null}
      {state.error && !state.fieldErrors ? <p className="mt-3 text-sm text-danger fade-in">{state.error}</p> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          Send
        </Button>
      </DialogFooter>
    </form>
  );
}

function DailyReportForm({ defaultDay, onDone, onCancel }: { defaultDay: string; onDone: () => void; onCancel: () => void }) {
  const [day, setDay] = useState(defaultDay);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const run = () =>
    start(async () => {
      const s = await sendDailyReportNowAction(day || undefined);
      if (s.ok) {
        toast.success(s.message ?? "Queued", typeof s.data?.note === "string" ? s.data.note : undefined);
        onDone();
      } else setError(s.error ?? "Failed");
    });
  return (
    <div>
      <Field label="Report day" htmlFor="report-day" hint="The calendar day the report covers.">
        <Input id="report-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </Field>
      {error ? <p className="mt-3 text-sm text-danger fade-in">{error}</p> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={run} loading={pending} disabled={!day}>
          Send report
        </Button>
      </DialogFooter>
    </div>
  );
}
