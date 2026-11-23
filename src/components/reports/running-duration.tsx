"use client";

import { useEffect, useState } from "react";
import { formatDurationShort } from "./format";

/** Offline-for counter that keeps ticking ("12m 05s", "3h 07m", "2d 4h"). */
export function RunningDuration({ since, className }: { since: string; className?: string }) {
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
      {formatDurationShort(elapsed)}
    </span>
  );
}
