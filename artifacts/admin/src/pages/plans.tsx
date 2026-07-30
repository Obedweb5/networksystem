import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListPlans, getListPlansQueryKey, useCreatePlan, useUpdatePlan, useDeletePlan } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Wifi, Radio } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

const schema = z.object({
  name: z.string().min(1),
  type: z.enum(["HOTSPOT", "PPPOE"]),
  price: z.string().min(1),
  durationDays: z.coerce.number().min(1),
  description: z.string().optional(),
  speedDownKbps: z.coerce.number().optional(),
  speedUpKbps: z.coerce.number().optional(),
  dataLimitMb: z.coerce.number().optional(),
  isActive: z.boolean().optional(),
});

type PlanForm = z.infer<typeof schema>;

export default function PlansPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<"" | "HOTSPOT" | "PPPOE">("");

  const params = typeFilter ? { type: typeFilter as "HOTSPOT" | "PPPOE" } : {};
  const { data: plans, isLoading } = useListPlans(params, { query: { queryKey: getListPlansQueryKey(params) } });
  const createMut = useCreatePlan();
  const updateMut = useUpdatePlan();
  const deleteMut = useDeletePlan();

  const form = useForm<PlanForm>({ resolver: zodResolver(schema), defaultValues: { name: "", type: "HOTSPOT", price: "", durationDays: 30, isActive: true } });

  function openCreate() { setEditId(null); form.reset({ name: "", type: "HOTSPOT", price: "", durationDays: 30, isActive: true }); setOpen(true); }
  function openEdit(p: any) { setEditId(p.id); form.reset({ name: p.name, type: p.type, price: p.price, durationDays: p.durationDays, description: p.description, speedDownKbps: p.speedDownKbps, speedUpKbps: p.speedUpKbps, dataLimitMb: p.dataLimitMb, isActive: p.isActive }); setOpen(true); }

  function onSubmit(values: PlanForm) {
    if (editId) {
      updateMut.mutate({ id: editId, data: values }, {
        onSuccess: () => { toast({ title: "Plan updated" }); qc.invalidateQueries({ queryKey: getListPlansQueryKey() }); setOpen(false); },
        onError: () => toast({ title: "Failed to update plan", variant: "destructive" }),
      });
    } else {
      createMut.mutate({ data: values }, {
        onSuccess: () => { toast({ title: "Plan created" }); qc.invalidateQueries({ queryKey: getListPlansQueryKey() }); setOpen(false); },
        onError: () => toast({ title: "Failed to create plan", variant: "destructive" }),
      });
    }
  }

  function handleDelete(id: string) {
    if (!confirm("Deactivate this plan?")) return;
    deleteMut.mutate({ id }, { onSuccess: () => { toast({ title: "Plan deactivated" }); qc.invalidateQueries({ queryKey: getListPlansQueryKey() }); } });
  }

  function handleReactivate(id: string) {
    updateMut.mutate({ id, data: { isActive: true } }, {
      onSuccess: () => { toast({ title: "Plan reactivated" }); qc.invalidateQueries({ queryKey: getListPlansQueryKey() }); },
      onError: () => toast({ title: "Failed to reactivate plan", variant: "destructive" }),
    });
  }

  return (
    <AppLayout>
      <div className="p-6 space-y-4 max-w-5xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">Service Plans</h1>
            <p className="text-xs text-muted-foreground mt-0.5">{plans?.length ?? 0} plans</p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as any)}>
              <SelectTrigger className="h-8 text-xs w-32"><SelectValue placeholder="All types" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">All types</SelectItem>
                <SelectItem value="HOTSPOT">Hotspot</SelectItem>
                <SelectItem value="PPPOE">PPPoE</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={openCreate} data-testid="btn-add-plan"><Plus className="w-3.5 h-3.5 mr-1" /> New Plan</Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {isLoading && <p className="col-span-3 text-xs text-muted-foreground py-8 text-center">Loading...</p>}
          {!isLoading && !plans?.length && <p className="col-span-3 text-xs text-muted-foreground py-8 text-center">No plans found</p>}
          {plans?.map(p => (
            <div key={p.id} data-testid={`card-plan-${p.id}`} className={`bg-card border rounded-md p-4 space-y-2 ${!p.isActive ? "opacity-50" : "border-border"}`}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  {p.type === "HOTSPOT" ? <Wifi className="w-4 h-4 text-primary" /> : <Radio className="w-4 h-4 text-blue-500" />}
                  <div>
                    <p className="text-sm font-semibold">{p.name}</p>
                    <span className="text-xs text-muted-foreground">{p.type}</span>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => openEdit(p)} className="p-1 rounded hover:bg-muted transition-colors" data-testid={`btn-edit-plan-${p.id}`}><Pencil className="w-3 h-3 text-muted-foreground" /></button>
                  <button onClick={() => handleDelete(p.id)} className="p-1 rounded hover:bg-muted transition-colors" data-testid={`btn-delete-plan-${p.id}`}><Trash2 className="w-3 h-3 text-muted-foreground" /></button>
                </div>
              </div>
              <p className="text-xl font-bold">KES {Number(p.price).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">{p.durationDays} days</p>
              {(p.speedDownKbps || p.speedUpKbps) && (
                <p className="text-xs text-muted-foreground">
                  {p.speedDownKbps ? `${p.speedDownKbps / 1024 >= 1 ? `${(p.speedDownKbps / 1024).toFixed(0)} Mbps` : `${p.speedDownKbps} Kbps`} ↓` : ""}{" "}
                  {p.speedUpKbps ? `${p.speedUpKbps / 1024 >= 1 ? `${(p.speedUpKbps / 1024).toFixed(0)} Mbps` : `${p.speedUpKbps} Kbps`} ↑` : ""}
                </p>
              )}
              {!p.isActive && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground italic">Deactivated</span>
                  <button
                    onClick={() => handleReactivate(p.id)}
                    className="text-xs font-semibold text-primary hover:underline"
                    data-testid={`btn-reactivate-plan-${p.id}`}
                  >
                    Reactivate
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editId ? "Edit Plan" : "New Plan"}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Plan Name</FormLabel><FormControl><Input {...field} data-testid="input-plan-name" /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="type" render={({ field }) => (
                  <FormItem><FormLabel>Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger data-testid="select-plan-type"><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="HOTSPOT">Hotspot</SelectItem>
                        <SelectItem value="PPPOE">PPPoE</SelectItem>
                      </SelectContent>
                    </Select><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="durationDays" render={({ field }) => (
                  <FormItem><FormLabel>Duration (days)</FormLabel><FormControl><Input {...field} type="number" min={1} data-testid="input-duration" /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="price" render={({ field }) => (
                <FormItem><FormLabel>Price (KES)</FormLabel><FormControl><Input {...field} data-testid="input-price" /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-3">
                <FormField control={form.control} name="speedDownKbps" render={({ field }) => (
                  <FormItem><FormLabel>Download (Kbps)</FormLabel><FormControl><Input {...field} type="number" min={0} data-testid="input-speed-down" /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="speedUpKbps" render={({ field }) => (
                  <FormItem><FormLabel>Upload (Kbps)</FormLabel><FormControl><Input {...field} type="number" min={0} data-testid="input-speed-up" /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              {editId && (
                <FormField control={form.control} name="isActive" render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div className="space-y-0.5">
                      <FormLabel className="text-sm">Active</FormLabel>
                      <p className="text-xs text-muted-foreground">Deactivated plans are hidden from the customer portal.</p>
                    </div>
                    <FormControl>
                      <Switch checked={field.value ?? true} onCheckedChange={field.onChange} data-testid="switch-plan-active" />
                    </FormControl>
                  </FormItem>
                )} />
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMut.isPending || updateMut.isPending} data-testid="btn-submit-plan">
                  {editId ? "Save Changes" : "Create Plan"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
