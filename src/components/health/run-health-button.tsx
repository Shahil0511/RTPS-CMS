"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export function RunHealthButton({ onDone }: { onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/health", { method: "POST" });
      const data = (await res.json()) as { online?: number; offline?: number; devicesOnline?: number; devicesOffline?: number; error?: string; mediamtxReachable?: boolean };
      if (!res.ok) throw new Error(data.error ?? "Health check failed");
      if (data.mediamtxReachable === false) toast.error("Streaming server unreachable", data.error);
      else toast.success("Health check complete", `Cameras: ${data.online ?? 0} online · ${data.offline ?? 0} offline. Recorders: ${data.devicesOnline ?? 0} online · ${data.devicesOffline ?? 0} offline`);
      router.refresh();
      onDone?.();
    } catch (e) {
      toast.error("Health check failed", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="secondary" onClick={run} loading={busy}>
      {!busy ? <RefreshCw className="h-4 w-4" /> : null} Run check now
    </Button>
  );
}
