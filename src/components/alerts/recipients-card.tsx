"use client";

import { Building2, Globe, Mail, Pencil, Plus, Sparkles, Trash2, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/format";
import { addStoreRecipientsAction, deleteRecipientAction } from "@/server/actions/alerts";
import { RecipientForm, type RecipientFormValues, type StoreOption } from "./recipient-form";

export interface RecipientItem {
  id: string;
  name: string | null;
  email: string;
  storeId: string | null;
  storeName: string | null;
  storeCode: string | null;
  onOffline: boolean;
  onOnline: boolean;
  dailyReport: boolean;
  isActive: boolean;
}

export interface SuggestionItem {
  storeId: string;
  storeName: string;
  storeCode: string;
  email: string;
  alreadyAdded: boolean;
}

function Toggle({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      title={`${label}: ${on ? "on" : "off"}`}
      className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-[3px] px-1 text-[11px] font-bold", on ? "bg-success-soft text-success" : "bg-surface-2 text-faint line-through")}
    >
      {label}
    </span>
  );
}

export function RecipientsCard({ recipients, stores, suggestions }: { recipients: RecipientItem[]; stores: StoreOption[]; suggestions: SuggestionItem[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<RecipientFormValues | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const close = useCallback(() => setEditing(null), []);
  const done = useCallback(() => {
    setEditing(null);
    router.refresh();
  }, [router]);

  const pendingSuggestions = suggestions.filter((s) => !s.alreadyAdded);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Recipients"
        description="Who is emailed when a camera or recorder goes offline, comes back, and for the daily report."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setSuggestOpen(true)} disabled={suggestions.length === 0} title={suggestions.length === 0 ? "No store has a mailbox saved yet (Stores page)" : undefined}>
              <Sparkles className="h-4 w-4" /> Suggest from store emails
              {pendingSuggestions.length > 0 ? <span className="rounded-full bg-accent px-1.5 text-[11px] font-bold text-white">{pendingSuggestions.length}</span> : null}
            </Button>
            <Button size="sm" onClick={() => setEditing({})}>
              <Plus className="h-4 w-4" /> Add recipient
            </Button>
          </div>
        }
      />
      {recipients.length === 0 ? (
        <EmptyState
          icon={<Mail className="h-5 w-5" />}
          title="No recipients yet"
          description="Add the IT team for all locations, and store managers for their own store. Until then, alerts are recorded in the downtime log but nobody is emailed."
          className="mx-5 mb-5"
          action={
            <Button onClick={() => setEditing({})}>
              <UserPlus className="h-4 w-4" /> Add the first recipient
            </Button>
          }
        />
      ) : (
        <Table className="border-t border-border">
          <THead>
            <tr>
              <TH>Recipient</TH>
              <TH>Location</TH>
              <TH>Emails</TH>
              <TH>Status</TH>
              <TH className="text-right">Actions</TH>
            </tr>
          </THead>
          <TBody>
            {recipients.map((r) => (
              <TR key={r.id} className={cn(!r.isActive && "opacity-60")}>
                <TD>
                  <p className="font-medium text-text">{r.name || r.email}</p>
                  {r.name ? <p className="text-[12px] text-muted">{r.email}</p> : null}
                </TD>
                <TD className="text-[13px]">
                  {r.storeId ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Building2 className="h-3.5 w-3.5 text-faint" />
                      {r.storeName ?? "Unknown"}
                      {r.storeCode ? <span className="font-mono text-[11px] text-faint">{r.storeCode}</span> : null}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-accent">
                      <Globe className="h-3.5 w-3.5" /> All locations
                    </span>
                  )}
                </TD>
                <TD>
                  <div className="flex gap-1">
                    <Toggle on={r.onOffline} label="Offline" />
                    <Toggle on={r.onOnline} label="Online" />
                    <Toggle on={r.dailyReport} label="Daily" />
                  </div>
                </TD>
                <TD>{r.isActive ? <Badge tone="success">Active</Badge> : <Badge>Paused</Badge>}</TD>
                <TD className="text-right">
                  <div className="inline-flex gap-1">
                    <Button variant="ghost" size="icon" aria-label={`Edit ${r.email}`} onClick={() => setEditing(r)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <ConfirmButton
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${r.email}`}
                      title={`Remove ${r.email}?`}
                      description="They will stop receiving alerts and reports. Emails already sent stay in the outbox."
                      confirmLabel="Remove"
                      action={() => deleteRecipientAction(r.id)}
                      onDone={(s) => s.ok && router.refresh()}
                    >
                      <Trash2 className="h-4 w-4 text-danger" />
                    </ConfirmButton>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Dialog open={editing !== null} onClose={close} title={editing?.id ? `Edit ${editing.email ?? "recipient"}` : "Add recipient"} size="md">
        <RecipientForm initial={editing ?? undefined} stores={stores} onDone={done} onCancel={close} />
      </Dialog>

      <SuggestionsDialog
        open={suggestOpen}
        onClose={() => setSuggestOpen(false)}
        suggestions={suggestions}
        onCustomise={(s) => {
          setSuggestOpen(false);
          setEditing({ name: s.storeName, email: s.email, storeId: s.storeId });
        }}
        onAdded={() => {
          setSuggestOpen(false);
          router.refresh();
        }}
      />
    </Card>
  );
}

function SuggestionsDialog({
  open,
  onClose,
  suggestions,
  onCustomise,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  suggestions: SuggestionItem[];
  onCustomise: (s: SuggestionItem) => void;
  onAdded: () => void;
}) {
  const available = useMemo(() => suggestions.filter((s) => !s.alreadyAdded), [suggestions]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [pending, start] = useTransition();
  const toast = useToast();

  const allSelected = available.length > 0 && available.every((s) => selected.has(s.storeId));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const add = () =>
    start(async () => {
      const state = await addStoreRecipientsAction([...selected]);
      if (state.ok) {
        toast.success(state.message ?? "Added");
        setSelected(new Set());
        onAdded();
      } else toast.error(state.error ?? "Could not add recipients");
    });

  return (
    <Dialog open={open} onClose={onClose} title="Suggest from store emails" description="Each store's own mailbox (set on the Stores page) receives alerts for that store only." size="lg">
      {suggestions.length === 0 ? (
        <p className="text-sm text-muted">No store has a mailbox saved yet. Add one on the Stores page first.</p>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between text-[13px] text-muted">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent)]"
                checked={allSelected}
                disabled={available.length === 0}
                onChange={() => setSelected(allSelected ? new Set() : new Set(available.map((s) => s.storeId)))}
              />
              Select all new ({available.length})
            </label>
            <span>{suggestions.length - available.length} already added</span>
          </div>
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-[6px] border border-border">
            {suggestions.map((s) => (
              <li key={s.storeId} className={cn("flex items-center gap-3 px-3 py-2 text-sm", s.alreadyAdded ? "opacity-60" : "hover:bg-surface-2")}>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--accent)]"
                  aria-label={`Add ${s.storeName}`}
                  disabled={s.alreadyAdded}
                  checked={s.alreadyAdded || selected.has(s.storeId)}
                  onChange={() => toggle(s.storeId)}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-text">
                    {s.storeName} <span className="font-mono text-[11px] text-faint">{s.storeCode}</span>
                  </p>
                  <p className="truncate text-[12px] text-muted">{s.email}</p>
                </div>
                {s.alreadyAdded ? (
                  <Badge tone="success">Added</Badge>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => onCustomise(s)}>
                    Customise…
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={pending}>
          Close
        </Button>
        <Button onClick={add} loading={pending} disabled={selected.size === 0}>
          Add {selected.size || ""} selected
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
