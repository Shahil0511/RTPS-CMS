"use client";

import { useActionState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { importCamerasAction } from "@/server/actions/cameras";
import { idle } from "@/server/action-utils";

const EXAMPLE = `Table Number: -1
rtsp://admin:password@172.16.1.4:554/Streaming/Unicast/channels/101
Table Number: -2
rtsp://admin:password@172.16.1.4:554/Streaming/Unicast/channels/201
Entrance
rtsp://admin:password@172.16.1.4:554/Streaming/Unicast/channels/301`;

export function ImportDialog({
  stores,
  defaultStoreId,
  defaults,
  onDone,
  onCancel,
}: {
  stores: Array<{ id: string; name: string; code: string }>;
  defaultStoreId?: string;
  defaults: { recordEnabled: boolean; retentionDays: number };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState(importCamerasAction, idle);
  const toast = useToast();

  useEffect(() => {
    if (state.ok) {
      toast.success("Import finished", state.message);
      onDone();
    }
  }, [state, toast, onDone]);

  return (
    <form action={action} className="space-y-4" noValidate>
      <Field label="Store" htmlFor="import-store" error={state.fieldErrors?.storeId}>
        <Select id="import-store" name="storeId" defaultValue={defaultStoreId ?? stores[0]?.id ?? ""} required>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.code})
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Camera list"
        htmlFor="import-text"
        error={state.fieldErrors?.text}
        hint="One rtsp:// URL per line. A label line before a URL (e.g. “Table Number: -3” or “Entrance”) names the camera; otherwise the channel number is used. Each host:port becomes a recorder (created as “NVR <host>” with the URL's credentials if it does not exist yet) and the cameras are linked to it as channels. Duplicates are skipped."
      >
        <Textarea id="import-text" name="text" rows={10} className="font-mono text-[12.5px]" placeholder={EXAMPLE} required />
      </Field>
      <p className="rounded-[4px] bg-surface-2 px-3 py-2 text-[12px] text-muted">Footage stays on the recorder&apos;s own disks; playback is streamed from there. Nothing is stored on this server.</p>
      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          Import cameras
        </Button>
      </DialogFooter>
    </form>
  );
}
