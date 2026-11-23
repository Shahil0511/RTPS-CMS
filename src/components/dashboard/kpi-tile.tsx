import Link from "next/link";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/format";

type Tone = "default" | "success" | "danger" | "warning" | "info" | "accent";

const valueTone: Record<Tone, string> = {
  default: "text-text",
  success: "text-success",
  danger: "text-danger",
  warning: "text-warning",
  info: "text-info",
  accent: "text-accent",
};

export interface KpiSegment {
  label: string;
  value: number;
  /** A CSS colour (token var). */
  color: string;
}

/** KPI tile: label, big number, optional proportion bar and a one-line hint. Clickable when `href` is set. */
export function KpiTile({
  label,
  value,
  of,
  hint,
  tone = "default",
  icon,
  href,
  segments,
}: {
  label: string;
  value: React.ReactNode;
  of?: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  icon?: React.ReactNode;
  href?: string;
  segments?: KpiSegment[];
}) {
  const total = segments?.reduce((a, s) => a + s.value, 0) ?? 0;
  const body = (
    <Card className={cn("h-full px-4 py-3.5", href && "lift")}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] font-semibold text-muted">{label}</p>
        {icon ? <span className={cn("rounded-[6px] bg-surface-2 p-1.5 text-muted", tone !== "default" && valueTone[tone])}>{icon}</span> : null}
      </div>
      <p className={cn("-mt-1 text-[28px] font-semibold leading-none tabular-nums", valueTone[tone])}>
        {value}
        {of != null ? <span className="text-base font-normal text-faint"> / {of}</span> : null}
      </p>
      {segments ? (
        <div className="mt-3 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-surface-2" role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join(", ")}>
          {total > 0
            ? segments
                .filter((s) => s.value > 0)
                .map((s) => <span key={s.label} className="h-full transition-[width] duration-700" style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />)
            : null}
        </div>
      ) : null}
      {hint ? <p className="mt-2 truncate text-[12px] text-muted">{hint}</p> : null}
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-card">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Placeholder with the same footprint as a KpiTile. */
export function KpiTileSkeleton() {
  return (
    <Card className="px-4 py-3.5">
      <div className="skeleton h-3 w-24" />
      <div className="skeleton mt-3 h-7 w-16" />
      <div className="skeleton mt-3 h-1.5 w-full" />
      <div className="skeleton mt-2 h-3 w-32" />
    </Card>
  );
}
