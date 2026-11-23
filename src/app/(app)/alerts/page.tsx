import { BellRing, CloudOff, FileClock, Network } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { AlertSettingsForm } from "@/components/alerts/alert-settings-form";
import { MailDeliveryCard } from "@/components/alerts/mail-delivery-card";
import { OutboxTable } from "@/components/alerts/outbox-table";
import { RecipientsCard } from "@/components/alerts/recipients-card";
import { addDays, dayKeyInTz } from "@/components/reports/format";
import { buttonClasses } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/db";
import { stores } from "@/db/schema";
import { env } from "@/env";
import { getMailerStatus } from "@/lib/alerts/mailer";
import { getAlertSettings } from "@/lib/alerts/settings";
import { rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { downtimeScopeFor, monitoringCoverage } from "@/server/queries/downtime";
import { listOutbox, listRecipients, outboxStatsSince, recipientSummary, storeEmailSuggestions } from "@/server/queries/alerts";

export const metadata: Metadata = { title: "Alerts" };
export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const user = await requireUser(rolesFor("alerts.manage"));
  const tz = env.ALERT_TIMEZONE;
  const [recipients, suggestions, settings, outbox, stats24h, summary, storeRows, coverage] = await Promise.all([
    listRecipients(),
    storeEmailSuggestions(),
    getAlertSettings(),
    listOutbox(100),
    outboxStatsSince(new Date(Date.now() - 24 * 3600 * 1000)),
    recipientSummary(),
    db.select({ id: stores.id, name: stores.name, code: stores.code }).from(stores).orderBy(asc(stores.name)),
    monitoringCoverage(downtimeScopeFor(user)),
  ]);
  const mailer = getMailerStatus();
  const yesterday = addDays(dayKeyInTz(new Date(), tz), -1);

  const live = coverage.filter((c) => c.mode === "DIRECT" || c.mode === "RELAY").reduce((n, c) => n + c.recorders, 0);
  const pending = coverage.find((c) => c.mode === "PENDING_NETWORK")?.recorders ?? 0;
  const cloud = coverage.find((c) => c.mode === "CLOUD_ONLY")?.recorders ?? 0;

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Email alerts when a camera or recorder goes offline or comes back, plus a daily health report. Every alert names the location, the camera or recorder, and the downtime."
        actions={
          <Link href="/reports" className={buttonClasses("secondary")}>
            <FileClock className="h-4 w-4" /> Downtime reports
          </Link>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-card border border-border bg-surface px-4 py-3 text-[13px] text-muted shadow-card">
        <span className="inline-flex items-center gap-1.5">
          <BellRing className="h-4 w-4 text-success" />
          <strong className="font-semibold text-text tabular-nums">{live}</strong> Live recorder{live === 1 ? "" : "s"} monitored
        </span>
        <span className="inline-flex items-center gap-1.5" title="Known recorders the server cannot reach yet. Not alerted on.">
          <Network className="h-4 w-4 text-warning" />
          <strong className="font-semibold text-text tabular-nums">{pending}</strong> pending network
        </span>
        <span className="inline-flex items-center gap-1.5" title="Reachable only through the vendor's cloud app. Not alerted on.">
          <CloudOff className="h-4 w-4 text-faint" />
          <strong className="font-semibold text-text tabular-nums">{cloud}</strong> cloud-only
        </span>
        <span className="text-faint sm:ml-auto">Only Live recorders and their cameras raise alerts, so unreachable sites never flood the inbox.</span>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <RecipientsCard
            recipients={recipients.map((r) => ({
              id: r.id,
              name: r.name,
              email: r.email,
              storeId: r.storeId,
              storeName: r.storeName,
              storeCode: r.storeCode,
              onOffline: r.onOffline,
              onOnline: r.onOnline,
              dailyReport: r.dailyReport,
              isActive: r.isActive,
            }))}
            stores={storeRows}
            suggestions={suggestions}
          />
        </div>
        <div className="space-y-5">
          <MailDeliveryCard
            mailer={{
              configured: mailer.configured,
              host: mailer.host,
              from: mailer.from,
              port: env.SMTP_PORT,
              secure: env.SMTP_SECURE,
              authenticated: Boolean(env.SMTP_USER),
            }}
            stats24h={stats24h}
            defaultTestTo={user.email}
            yesterday={yesterday}
            dailyRecipients={summary.daily}
          />
          <AlertSettingsForm initial={settings} timeZone={tz} />
        </div>
      </div>

      <div className="mt-5">
        <OutboxTable
          timeZone={tz}
          items={outbox.map((o) => ({ ...o, createdAt: o.createdAt.toISOString(), sentAt: o.sentAt?.toISOString() ?? null }))}
        />
      </div>
    </>
  );
}
