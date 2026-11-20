import { cn } from "@/lib/format";

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-card border border-border bg-surface shadow-card", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-5 pt-4 pb-3", className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold text-text leading-6">{title}</h3>
        {description ? <p className="text-[13px] text-muted mt-0.5">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-5 pb-5", className)}>{children}</div>;
}

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "success" | "danger" | "warning" | "info" | "accent";
  icon?: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    default: "text-text",
    success: "text-success",
    danger: "text-danger",
    warning: "text-warning",
    info: "text-info",
    accent: "text-accent",
  };
  return (
    <Card className="lift px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-muted">{label}</p>
          <p className={cn("mt-1 text-3xl font-semibold tabular-nums leading-none", tones[tone])}>{value}</p>
          {hint ? <p className="mt-2 text-[12px] text-muted">{hint}</p> : null}
        </div>
        {icon ? <div className={cn("rounded-[6px] bg-surface-2 p-2 text-muted", tones[tone])}>{icon}</div> : null}
      </div>
    </Card>
  );
}
