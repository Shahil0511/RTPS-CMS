"use client";

import { Building2, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { deleteStoreAction } from "@/server/actions/stores";
import { StoreForm, type StoreFormValues } from "./store-form";

interface StoreRow extends StoreFormValues {
  id: string;
  code: string;
  name: string;
  kind: "STORE" | "CORPORATE" | "WAREHOUSE";
  timezone: string;
  isActive: boolean;
  cameraCount: number;
  onlineCount: number;
  createdAt: string;
  updatedAt: string;
}

export function StoresTable({ stores, canManage }: { stores: StoreRow[]; canManage: boolean }) {
  const [editing, setEditing] = useState<StoreRow | null | "new">(null);
  const router = useRouter();
  const close = () => setEditing(null);
  const done = () => {
    close();
    router.refresh();
  };

  return (
    <>
      <div className="mb-3 flex justify-end">
        {canManage ? (
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> Add store
          </Button>
        ) : null}
      </div>
      <Card className="overflow-hidden">
        {stores.length === 0 ? (
          <EmptyState icon={<Building2 className="h-5 w-5" />} title="No stores" description="Create the first store to start adding cameras." className="m-4" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Site</TH>
                <TH>Type</TH>
                <TH>Location</TH>
                <TH>Cameras</TH>
                <TH>Timezone</TH>
                <TH>Status</TH>
                {canManage ? <TH className="text-right">Actions</TH> : null}
              </tr>
            </THead>
            <TBody>
              {stores.map((s) => (
                <TR key={s.id}>
                  <TD>
                    <Link href={`/cameras?store=${s.id}`} className="font-medium text-text hover:text-accent">
                      {s.name}
                    </Link>
                    <p className="font-mono text-[12px] text-faint">{s.code}</p>
                  </TD>
                  <TD>
                    <Badge tone={s.kind === "STORE" ? "accent" : s.kind === "CORPORATE" ? "info" : "warning"}>
                      {s.kind === "STORE" ? "Store" : s.kind === "CORPORATE" ? "Corporate" : "Warehouse"}
                    </Badge>
                  </TD>
                  <TD className="text-[13px] text-muted">{[s.address, s.city, s.region].filter(Boolean).join(", ") || "—"}</TD>
                  <TD className="tabular-nums">
                    <span className="font-medium text-success">{s.onlineCount}</span>
                    <span className="text-faint"> / {s.cameraCount} online</span>
                  </TD>
                  <TD className="text-[13px] text-muted">{s.timezone}</TD>
                  <TD>{s.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</TD>
                  {canManage ? (
                    <TD className="text-right">
                      <div className="inline-flex gap-1">
                        <Button variant="ghost" size="icon" aria-label="Edit store" onClick={() => setEditing(s)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <ConfirmButton
                          variant="ghost"
                          size="icon"
                          aria-label="Delete store"
                          title={`Delete ${s.name}?`}
                          description={s.cameraCount > 0 ? `This store still has ${s.cameraCount} camera(s). Move or delete them first.` : "This cannot be undone."}
                          confirmLabel="Delete"
                          action={() => deleteStoreAction(s.id)}
                          onDone={(st) => st.ok && router.refresh()}
                          disabled={s.cameraCount > 0}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </ConfirmButton>
                      </div>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog open={editing !== null} onClose={close} title={editing === "new" ? "Add store" : "Edit store"} size="lg">
        <StoreForm initial={editing && editing !== "new" ? editing : undefined} onDone={done} onCancel={close} />
      </Dialog>
    </>
  );
}
