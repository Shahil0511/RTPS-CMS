import { CheckCircle2, ChevronRight, CircleDashed, CircleSlash } from "lucide-react";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/format";
import type { ReadinessItem, ReadinessStatus } from "@/server/queries/dashboard";

const STATUS_META: Record<ReadinessStatus, { label: string; text: string; ring: string; icon: React.ReactNode }> = {
  ready: { label: "Delivered", text: "text-success", ring: "bg-success-soft text-success", icon: <CheckCircle2 className="h-4 w-4" /> },
  partial: { label: "Partly live", text: "text-warning", ring: "bg-warning-soft text-warning", icon: <CircleDashed className="h-4 w-4" /> },
  blocked: { label: "Waiting on access", text: "text-faint", ring: "bg-surface-2 text-faint", icon: <CircleSlash className="h-4 w-4" /> },
};

/** The five IT-department requirements, each with a status computed from what is connected today. */
export function RequirementReadiness({ items }: { items: ReadinessItem[] }) {
  const ready = items.filter((i) => i.status === "ready").length;
  return (
    <Card className="h-full">
      <CardHeader
        title="Requirement readiness"
        description="The IT department's five acceptance points, measured against the live estate."
        action={
          <span className="text-[12px] tabular-nums text-muted">
            <span className="font-semibold text-text">{ready}</span> / {items.length} delivered
          </span>
        }
      />
      <CardBody className="px-3">
        <ol className="space-y-1">
          {items.map((item, idx) => {
            const meta = STATUS_META[item.status];
            return (
              <li key={item.key}>
                <Link href={item.href} className="group flex items-start gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-surface-2">
                  <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full", meta.ring)} aria-hidden>
                    {meta.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[11px] font-semibold tabular-nums text-faint">{idx + 1}</span>
                      <span className="text-[13px] font-semibold text-text group-hover:text-accent">{item.title}</span>
                      <span className={cn("text-[11px] font-semibold uppercase tracking-[0.02em]", meta.text)}>{meta.label}</span>
                    </span>
                    <span className="mt-0.5 block text-[12px] text-muted">{item.summary}</span>
                    {item.details.length ? (
                      <span className="mt-0.5 block text-[11px] leading-4 text-faint">{item.details.join(" · ")}</span>
                    ) : null}
                  </span>
                  <ChevronRight className="mt-1.5 h-4 w-4 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              </li>
            );
          })}
        </ol>
      </CardBody>
    </Card>
  );
}

export function PanelSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <Card className={cn("h-full", className)}>
      <div className="px-5 pt-4 pb-3">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton mt-2 h-3 w-64" />
      </div>
      <div className="space-y-3 px-5 pb-5">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="skeleton h-7 w-7 rounded-full" />
            <div className="flex-1">
              <div className="skeleton h-3 w-1/2" />
              <div className="skeleton mt-1.5 h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
