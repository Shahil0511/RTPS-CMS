import { cn } from "@/lib/format";

const base =
  "w-full rounded-[4px] border border-border-strong/70 bg-surface px-3 text-sm text-text placeholder:text-faint transition-colors " +
  "hover:bg-surface-2 focus:bg-surface focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--ring)] " +
  "disabled:opacity-60 disabled:cursor-not-allowed";

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(base, "h-8", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(base, "h-8 pr-8 appearance-none bg-no-repeat bg-[right_0.6rem_center] bg-[length:14px]", className)} style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%238a98ad' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")" }} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(base, "py-2 min-h-24 leading-relaxed", className)} {...rest} />;
}

export function Label({ className, children, ...rest }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn("block text-[13px] font-medium text-muted mb-1.5", className)} {...rest}>
      {children}
    </label>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | string[];
  children: React.ReactNode;
  className?: string;
}) {
  const err = Array.isArray(error) ? error[0] : error;
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {err ? <p className="mt-1 text-xs text-danger">{err}</p> : hint ? <p className="mt-1 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ label, description, className, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }) {
  return (
    <label className={cn("flex items-start gap-3 cursor-pointer select-none", className)}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-border-strong accent-[var(--accent)]" {...rest} />
      <span>
        <span className="block text-sm font-medium text-text">{label}</span>
        {description ? <span className="block text-xs text-faint">{description}</span> : null}
      </span>
    </label>
  );
}
