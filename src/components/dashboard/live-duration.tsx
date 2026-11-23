"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

/** Running duration since `since`, ticking every second for the first hour and every 30s after. */
export function LiveDuration({ since, className }: { since: string; className?: string }) {
  const start = new Date(since).getTime();
  const [now, setNow] = useState(() => Date.now());
  const elapsed = Math.max(0, (now - start) / 1000);
  const fast = elapsed < 3600;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
    return () => clearInterval(t);
  }, [fast]);

  return (
    <span className={className} suppressHydrationWarning>
      {formatDuration(elapsed)}
    </span>
  );
}
