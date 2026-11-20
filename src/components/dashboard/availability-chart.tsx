"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface TrendSeries {
  key: string;
  label: string;
  /** CSS colour (use a chart token). */
  color: string;
  points: Array<{ at: string; pct: number | null }>;
}

const W = 720;
const H = 220;
const PAD = { top: 12, right: 16, bottom: 26, left: 40 };

/**
 * 24h availability line chart (percent, fixed 0-100 axis). Inline SVG with a
 * crosshair tooltip that snaps to the nearest hour, keyboard-accessible, plus
 * a table twin for screen readers and exact values.
 */
export function AvailabilityChart({ series }: { series: TrendSeries[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Time labels depend on the viewer's locale and time zone, so they are only rendered in the browser.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const ref = useRef<SVGSVGElement>(null);
  const n = series[0]?.points.length ?? 0;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (pct: number) => PAD.top + plotH - (pct / 100) * plotH;

  const paths = useMemo(
    () =>
      series.map((s) => {
        let d = "";
        let area = "";
        let run: Array<[number, number]> = [];
        const flush = () => {
          if (run.length === 0) return;
          d += run.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
          const first = run[0];
          const last = run[run.length - 1];
          if (first && last) area += `M${first[0].toFixed(1)},${y(0)}` + run.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join("") + `L${last[0].toFixed(1)},${y(0)}Z`;
          run = [];
        };
        s.points.forEach((p, i) => {
          if (p.pct == null) flush();
          else run.push([x(i), y(p.pct)]);
        });
        flush();
        return { key: s.key, color: s.color, d, area };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, n],
  );

  const hasData = series.some((s) => s.points.some((p) => p.pct != null));
  const hourLabel = (iso: string) => (mounted ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
  const pick = (clientX: number) => {
    const el = ref.current;
    if (!el || n === 0) return;
    const r = el.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * W;
    const i = Math.round(((sx - PAD.left) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const ticks = [0, 25, 50, 75, 100];
  const hovered = hover != null ? hover : null;
  const tipLeft = hovered != null ? (x(hovered) / W) * 100 : 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-[12px] text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="relative">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full touch-none select-none outline-none"
          role="img"
          aria-label="Availability over the last 24 hours"
          tabIndex={0}
          onPointerMove={(e) => pick(e.clientX)}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
            if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
            if (e.key === "Escape") setHover(null);
          }}
          onBlur={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="fill-[var(--text-muted)] text-[11px] tabular-nums">
                {t}%
              </text>
            </g>
          ))}
          {series[0]?.points.map((p, i) =>
            i % 4 === 0 || i === n - 1 ? (
              <text key={p.at} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-[var(--text-muted)] text-[11px] tabular-nums">
                {i === n - 1 ? "now" : hourLabel(p.at)}
              </text>
            ) : null,
          )}
          {paths.map((p) => (
            <g key={p.key}>
              <path d={p.area} fill={p.color} opacity={0.1} />
              <path d={p.d} fill="none" stroke={p.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {hovered != null ? (
            <g>
              <line x1={x(hovered)} x2={x(hovered)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--text-faint)" strokeWidth={1} />
              {series.map((s) => {
                const v = s.points[hovered]?.pct;
                return v == null ? null : <circle key={s.key} cx={x(hovered)} cy={y(v)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />;
              })}
            </g>
          ) : null}
        </svg>
        {!hasData ? <p className="absolute inset-0 grid place-items-center text-sm text-muted">Collecting data: the trend fills in as health checks run.</p> : null}
        {hovered != null && series[0]?.points[hovered] ? (
          <div
            className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-border bg-surface px-3 py-2 text-[12px] shadow-lg"
            style={{ left: `${tipLeft}%`, transform: `translateX(${tipLeft > 70 ? "-105%" : "8px"})` }}
          >
            <p className="mb-1 text-faint">
              {hourLabel(series[0].points[hovered].at)} – {hovered === n - 1 ? "now" : hourLabel(new Date(new Date(series[0].points[hovered].at).getTime() + 3600_000).toISOString())}
            </p>
            {series.map((s) => {
              const v = s.points[hovered]?.pct;
              return (
                <p key={s.key} className="flex items-center justify-between gap-4">
                  <span className="inline-flex items-center gap-1.5 text-muted">
                    <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span className="font-semibold text-text">{v == null ? "—" : `${v}%`}</span>
                </p>
              );
            })}
          </div>
        ) : null}
      </div>
      <details className="mt-2 text-[12px] text-muted">
        <summary className="cursor-pointer select-none hover:text-text">Show as table</summary>
        <table className="mt-2 w-full tabular-nums">
          <thead>
            <tr className="text-left text-faint">
              <th className="py-1 font-medium">Hour</th>
              {series.map((s) => (
                <th key={s.key} className="py-1 text-right font-medium">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series[0]?.points.map((p, i) => (
              <tr key={p.at} className="border-t border-border">
                <td className="py-1">{hourLabel(p.at)}</td>
                {series.map((s) => (
                  <td key={s.key} className="py-1 text-right">
                    {s.points[i]?.pct == null ? "—" : `${s.points[i]?.pct}%`}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
