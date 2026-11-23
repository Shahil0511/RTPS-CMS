import { FileDown, ScrollText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { can, rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { formatDateTime, humanAction } from "@/lib/format";
import { distinctAuditActions, listAuditLogs } from "@/server/queries/audit";
import { AuditFilters } from "./audit-filters";

export const metadata: Metadata = { title: "Audit logs" };
export const dynamic = "force-dynamic";

type Search = { page?: string; action?: string; actor?: string; entityType?: string; q?: string; from?: string; to?: string };

function tone(action: string): "neutral" | "success" | "danger" | "warning" | "info" | "accent" {
  if (action.endsWith("login_failed") || action.endsWith("deleted")) return "danger";
  if (action.endsWith("created") || action.endsWith("imported") || action === "auth.login") return "success";
  if (action.includes("password")) return "warning";
  if (action.startsWith("playback") || action.startsWith("stream")) return "info";
  if (action.endsWith("updated") || action.endsWith("restarted")) return "accent";
  return "neutral";
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser(rolesFor("audit.view"));
  const sp = await searchParams;
  const filter = {
    page: Number(sp.page ?? "1") || 1,
    action: sp.action || null,
    actor: sp.actor || null,
    entityType: sp.entityType || null,
    search: sp.q || null,
    from: sp.from ? new Date(sp.from) : null,
    to: sp.to ? new Date(`${sp.to}T23:59:59.999`) : null,
  };
  const [page, actions] = await Promise.all([listAuditLogs(user, filter), distinctAuditActions()]);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (v && k !== "page") qs.set(k, v);
  const pageLink = (p: number) => `/audit?${new URLSearchParams({ ...Object.fromEntries(qs), page: String(p) }).toString()}`;

  return (
    <>
      <PageHeader
        title="Audit logs"
        description={
          user.isAdmin
            ? "Every sign-in, configuration change and playback request, with actor, source address and timestamp."
            : "Your own activity plus changes and playback for the locations, recorders and cameras you can access."
        }
        actions={
          can(user, "audit.export") ? (
            <a href={`/api/audit/export?${qs.toString()}`} className={buttonClasses("secondary")}>
              <FileDown className="h-4 w-4" /> Export CSV
            </a>
          ) : null
        }
      />
      <AuditFilters actions={actions} values={sp} />
      <Card className="mt-4 overflow-hidden">
        {page.items.length === 0 ? (
          <EmptyState icon={<ScrollText className="h-5 w-5" />} title="No matching entries" description="Adjust the filters or widen the date range." className="m-4" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Time</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH>Target</TH>
                <TH>Details</TH>
                <TH>Source</TH>
              </tr>
            </THead>
            <TBody>
              {page.items.map((row) => (
                <TR key={row.id}>
                  <TD className="whitespace-nowrap text-[13px] text-muted">{formatDateTime(row.createdAt, { timeStyle: "medium" })}</TD>
                  <TD className="text-[13px]">{row.actorEmail ?? <span className="text-faint">system</span>}</TD>
                  <TD>
                    <Badge tone={tone(row.action)}>{row.action}</Badge>
                  </TD>
                  <TD className="text-[13px]">
                    <span className="text-muted">{humanAction(row.action)}</span>
                    {row.entityLabel ? <span className="ml-1 font-medium text-text">{row.entityLabel}</span> : null}
                  </TD>
                  <TD className="max-w-[360px] truncate font-mono text-[12px] text-faint" title={row.details ?? ""}>{row.details ?? ""}</TD>
                  <TD className="whitespace-nowrap font-mono text-[12px] text-faint" title={row.userAgent ?? ""}>{row.ip ?? "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <div className="flex items-center justify-between border-t border-border px-4 py-3 text-[13px] text-muted">
          <span>
            {page.total.toLocaleString()} entries · page {page.page} of {page.pageCount}
          </span>
          <div className="flex gap-2">
            <Link aria-disabled={page.page <= 1} className={buttonClasses("secondary", "sm", page.page <= 1 ? "pointer-events-none opacity-50" : "")} href={pageLink(page.page - 1)}>
              Previous
            </Link>
            <Link aria-disabled={page.page >= page.pageCount} className={buttonClasses("secondary", "sm", page.page >= page.pageCount ? "pointer-events-none opacity-50" : "")} href={pageLink(page.page + 1)}>
              Next
            </Link>
          </div>
        </div>
      </Card>
    </>
  );
}
