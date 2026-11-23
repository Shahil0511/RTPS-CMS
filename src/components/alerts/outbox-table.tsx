"use client";

import { Eye, Inbox } from "lucide-react";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { EmailKind, EmailStatus } from "@/db/schema";
import { getOutboxMessageAction } from "@/server/actions/alerts";
import { formatZoned } from "@/components/reports/format";

export interface OutboxItem {
  id: number;
  kind: EmailKind;
  toAddress: string;
  subject: string;
  status: EmailStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

type Tone = "neutral" | "success" | "danger" | "warning" | "info" | "accent";

export const STATUS_META: Record<EmailStatus, { label: string; tone: Tone }> = {
  QUEUED: { label: "Queued", tone: "info" },
  SENDING: { label: "Sending", tone: "info" },
  SENT: { label: "Sent", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  SKIPPED_NO_SMTP: { label: "Not sent · no SMTP", tone: "neutral" },
};

export const KIND_META: Record<EmailKind, { label: string; tone: Tone }> = {
  OFFLINE: { label: "Offline", tone: "danger" },
  ONLINE: { label: "Back online", tone: "success" },
  DAILY_REPORT: { label: "Daily report", tone: "accent" },
  TEST: { label: "Test", tone: "neutral" },
};

export function OutboxTable({ items, timeZone }: { items: OutboxItem[]; timeZone: string }) {
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<{ subject: string; to: string; html: string } | null>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [, start] = useTransition();
  const toast = useToast();

  const shown = items.filter((i) => (!kind || i.kind === kind) && (!status || i.status === status));

  const open = (id: number) => {
    setLoadingId(id);
    start(async () => {
      const s = await getOutboxMessageAction(id);
      setLoadingId(null);
      if (s.ok && s.data) setPreview({ subject: String(s.data.subject ?? ""), to: String(s.data.to ?? ""), html: String(s.data.html ?? "") });
      else toast.error(s.error ?? "Could not load the message");
    });
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Outbox"
        description="The last 100 emails the system produced, delivered or not."
        action={
          <div className="flex gap-2">
            <Select aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value)} className="w-36">
              <option value="">All kinds</option>
              {Object.entries(KIND_META).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.label}
                </option>
              ))}
            </Select>
            <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
              <option value="">All statuses</option>
              {Object.entries(STATUS_META).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
        }
      />
      {shown.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-5 w-5" />}
          title={items.length === 0 ? "No emails yet" : "No emails match"}
          description={items.length === 0 ? "Alerts, daily reports and test emails appear here as soon as they are produced." : "Clear the filters to see everything."}
          className="mx-5 mb-5"
        />
      ) : (
        <Table className="border-t border-border">
          <THead>
            <tr>
              <TH>Time</TH>
              <TH>Kind</TH>
              <TH>To</TH>
              <TH>Subject</TH>
              <TH>Status</TH>
              <TH>Error</TH>
              <TH className="text-right">
                <span className="sr-only">View</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {shown.map((m) => (
              <TR key={m.id}>
                <TD className="whitespace-nowrap text-[13px] text-muted" title={m.sentAt ? `Sent ${formatZoned(m.sentAt, timeZone, { second: "2-digit" })}` : undefined}>
                  {formatZoned(m.createdAt, timeZone)}
                </TD>
                <TD>
                  <Badge tone={KIND_META[m.kind]?.tone ?? "neutral"}>{KIND_META[m.kind]?.label ?? m.kind}</Badge>
                </TD>
                <TD className="max-w-[220px] truncate text-[13px]" title={m.toAddress}>
                  {m.toAddress}
                </TD>
                <TD className="max-w-[360px] truncate text-[13px]" title={m.subject}>
                  {m.subject}
                </TD>
                <TD className="whitespace-nowrap">
                  <Badge tone={STATUS_META[m.status]?.tone ?? "neutral"}>{STATUS_META[m.status]?.label ?? m.status}</Badge>
                  {m.attempts > 1 ? <span className="ml-1.5 text-[11px] text-faint">×{m.attempts}</span> : null}
                </TD>
                <TD className="max-w-[260px] truncate text-[12px] text-danger" title={m.lastError ?? ""}>
                  {m.status === "SKIPPED_NO_SMTP" ? <span className="text-faint">SMTP not configured</span> : (m.lastError ?? "")}
                </TD>
                <TD className="text-right">
                  <Button variant="ghost" size="icon" aria-label="View message" onClick={() => open(m.id)} loading={loadingId === m.id}>
                    {loadingId === m.id ? null : <Eye className="h-4 w-4" />}
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <Dialog open={preview !== null} onClose={() => setPreview(null)} title={preview?.subject ?? "Message"} description={preview ? `To ${preview.to}` : undefined} size="lg">
        {preview ? (
          // Sandboxed with no permissions: the email HTML can neither run scripts nor navigate the app.
          <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[60vh] w-full rounded-[6px] border border-border bg-white" />
        ) : null}
      </Dialog>
    </Card>
  );
}
