import { useState, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  useListRouters, getListRoutersQueryKey, useCreateRouter, useUpdateRouter, useDeleteRouter,
  useGetRouterAlerts, getGetRouterAlertsQueryKey, useResolveRouterAlert,
  useGetHotspotSessions, getGetHotspotSessionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, ArrowLeft, CheckCircle, Activity, Pencil, Trash2, Wifi, RefreshCw, Send } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

const schema = z.object({
  name: z.string().min(1),
  ipAddress: z.string().min(1),
  apiUsername: z.string().min(1),
  apiSecret: z.string().min(1),
  apiPort: z.coerce.number().optional(),
  model: z.string().optional(),
});

type RouterForm = z.infer<typeof schema>;

const SEV_COLORS: Record<string, string> = {
  INFO: "bg-blue-500/10 text-blue-700",
  WARN: "bg-yellow-500/10 text-yellow-700",
  CRITICAL: "bg-red-500/10 text-red-700",
};

interface TestResult {
  reachable: boolean;
  error?: string;
  identity?: string;
  version?: string;
  uptime?: string;
  cpuLoad?: string;
  freeMemory?: number;
  totalMemory?: number;
  boardName?: string;
}

interface PppoeSession {
  id: string;
  name: string;
  service?: string;
  callerIp?: string;
  address?: string;
  uptime?: string;
}

function fmtMem(bytes?: number) {
  if (!bytes) return "—";
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export default function RoutersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editRouter, setEditRouter] = useState<any | null>(null);
  const [selectedRouter, setSelectedRouter] = useState<string | null>(null);
  const [tab, setTab] = useState<"alerts" | "sessions" | "pppoe">("alerts");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [pppoeSessions, setPppoeSessions] = useState<PppoeSession[]>([]);
  const [pppoeLoading, setPppoeLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const { data: routers, isLoading } = useListRouters({}, { query: { queryKey: getListRoutersQueryKey({}) } });
  const createMut = useCreateRouter();
  const updateMut = useUpdateRouter();
  const deleteMut = useDeleteRouter();

  const { data: alerts } = useGetRouterAlerts(selectedRouter!, {}, { query: { enabled: !!selectedRouter, queryKey: getGetRouterAlertsQueryKey(selectedRouter!, {}) } });
  const { data: sessions } = useGetHotspotSessions(selectedRouter!, {}, { query: { enabled: !!selectedRouter, queryKey: getGetHotspotSessionsQueryKey(selectedRouter!, {}) } });
  const resolveMut = useResolveRouterAlert();

  const form = useForm<RouterForm>({ resolver: zodResolver(schema), defaultValues: { name: "", ipAddress: "", apiUsername: "admin", apiSecret: "", apiPort: 8728, model: "" } });

  function openCreate() {
    setEditRouter(null);
    form.reset({ name: "", ipAddress: "", apiUsername: "admin", apiSecret: "", apiPort: 8728, model: "" });
    setOpen(true);
  }

  function openEdit(r: any, e: React.MouseEvent) {
    e.stopPropagation();
    setEditRouter(r);
    form.reset({ name: r.name, ipAddress: r.ipAddress, apiUsername: r.apiUsername, apiSecret: "", apiPort: r.apiPort ?? 8728, model: r.model ?? "" });
    setOpen(true);
  }

  function handleDelete(r: any, e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm(`Delete router "${r.name}"? If it has no subscriptions or provisioning history, it will be permanently removed — otherwise it'll be marked inactive.`)) return;
    deleteMut.mutate({ id: r.id }, {
      onSuccess: (data: any) => {
        if (data?.hardDeleted) {
          toast({ title: "Router deleted" });
        } else {
          toast({ title: "Router deactivated", description: data?.reason ?? "This router has history, so it was marked inactive instead of deleted." });
        }
        qc.invalidateQueries({ queryKey: getListRoutersQueryKey() });
      },
      onError: () => toast({ title: "Failed to delete router", variant: "destructive" }),
    });
  }

  function onSubmit(values: RouterForm) {
    if (editRouter) {
      updateMut.mutate({ id: editRouter.id, data: values }, {
        onSuccess: () => { toast({ title: "Router updated" }); qc.invalidateQueries({ queryKey: getListRoutersQueryKey() }); setOpen(false); },
        onError: () => toast({ title: "Failed to update router", variant: "destructive" }),
      });
    } else {
      createMut.mutate({ data: values }, {
        onSuccess: () => { toast({ title: "Router added" }); qc.invalidateQueries({ queryKey: getListRoutersQueryKey() }); setOpen(false); form.reset(); },
        onError: () => toast({ title: "Failed to add router", variant: "destructive" }),
      });
    }
  }

  function handleResolve(alertId: string) {
    resolveMut.mutate({ id: selectedRouter!, alertId }, {
      onSuccess: () => { toast({ title: "Alert resolved" }); qc.invalidateQueries({ queryKey: getGetRouterAlertsQueryKey(selectedRouter!, {}) }); },
    });
  }

  async function handleTest() {
    if (!selectedRouter) return;
    setTesting(true);
    setTestResult(null);
    try {
      const token = sessionStorage.getItem("pn_token");
      const res = await fetch(`/api/routers/${selectedRouter}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setTestResult(data);
    } catch {
      setTestResult({ reachable: false, error: "Network error" });
    } finally {
      setTesting(false);
    }
  }

  const loadPppoe = useCallback(async (routerId: string) => {
    setPppoeLoading(true);
    try {
      const token = sessionStorage.getItem("pn_token");
      const res = await fetch(`/api/routers/${routerId}/pppoe-sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setPppoeSessions(data.sessions ?? []);
    } catch {
      setPppoeSessions([]);
    } finally {
      setPppoeLoading(false);
    }
  }, []);

  function handleTabChange(t: "alerts" | "sessions" | "pppoe") {
    setTab(t);
    if (t === "pppoe" && selectedRouter) loadPppoe(selectedRouter);
  }

  async function handleDisconnect(sessionName: string) {
    if (!selectedRouter) return;
    setDisconnecting(sessionName);
    try {
      const token = sessionStorage.getItem("pn_token");
      const res = await fetch(`/api/routers/${selectedRouter}/pppoe-sessions/${encodeURIComponent(sessionName)}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        toast({ title: `Disconnected ${sessionName}` });
        loadPppoe(selectedRouter);
      } else {
        toast({ title: "Disconnect failed", variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setDisconnecting(null);
    }
  }

  const router = routers?.find(r => r.id === selectedRouter);

  if (selectedRouter && router) {
    return (
      <AppLayout>
        <div className="p-6 space-y-4 max-w-5xl">
          <div className="flex items-center gap-3">
            <button onClick={() => { setSelectedRouter(null); setTestResult(null); }} className="text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /></button>
            <div className="flex-1">
              <h1 className="text-lg font-bold">{router.name}</h1>
              <p className="text-xs text-muted-foreground">{router.ipAddress}:{router.apiPort} {router.model && `— ${router.model}`}</p>
            </div>
            <Button size="sm" variant="outline" onClick={handleTest} disabled={testing} data-testid="btn-test-router">
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${testing ? "animate-spin" : ""}`} />
              {testing ? "Testing..." : "Test"}
            </Button>
            <span className={`inline-flex px-2 py-0.5 rounded-sm text-xs font-medium ${router.isActive ? "bg-green-500/10 text-green-700" : "bg-gray-100 text-gray-500"}`}>{router.isActive ? "Active" : "Inactive"}</span>
          </div>

          {/* Test result stats strip */}
          {testResult && (
            <div className={`rounded-md border px-3 py-2 text-xs flex flex-wrap gap-x-4 gap-y-1 ${testResult.reachable ? "border-green-200 bg-green-500/5" : "border-red-200 bg-red-500/5"}`}>
              {testResult.reachable ? (
                <>
                  <span className="font-medium text-green-700">✓ Reachable</span>
                  {testResult.identity && <span className="text-muted-foreground">Identity: <span className="text-foreground">{testResult.identity}</span></span>}
                  {testResult.boardName && <span className="text-muted-foreground">Board: <span className="text-foreground">{testResult.boardName}</span></span>}
                  {testResult.version && <span className="text-muted-foreground">RouterOS: <span className="text-foreground">{testResult.version}</span></span>}
                  {testResult.uptime && <span className="text-muted-foreground">Uptime: <span className="text-foreground">{testResult.uptime}</span></span>}
                  {testResult.cpuLoad != null && <span className="text-muted-foreground">CPU: <span className="text-foreground">{testResult.cpuLoad}%</span></span>}
                  {testResult.freeMemory != null && <span className="text-muted-foreground">Free RAM: <span className="text-foreground">{fmtMem(testResult.freeMemory)}</span></span>}
                </>
              ) : (
                <span className="text-red-700">✗ Unreachable{testResult.error ? ` — ${testResult.error}` : ""}</span>
              )}
            </div>
          )}

          <div className="flex gap-2 border-b border-border">
            {(["alerts", "sessions", "pppoe"] as const).map(t => (
              <button key={t} onClick={() => handleTabChange(t)} className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors border-b-2 -mb-px ${tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                {t === "pppoe" ? "PPPoE Sessions" : t}
              </button>
            ))}
          </div>

          {tab === "alerts" && (
            <div className="space-y-2">
              {!alerts?.length && <p className="text-xs text-muted-foreground py-4 text-center">No alerts</p>}
              {alerts?.map(a => (
                <div key={a.id} data-testid={`row-alert-${a.id}`} className="bg-card border border-border rounded-md p-3 flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0">
                    <span className={`inline-flex shrink-0 px-1.5 py-0.5 rounded-sm text-xs font-medium mt-0.5 ${SEV_COLORS[a.severity] ?? ""}`}>{a.severity}</span>
                    <div className="min-w-0">
                      <p className="text-xs font-medium">{a.alertType}</p>
                      <p className="text-xs text-muted-foreground">{a.message}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{new Date(a.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                  {!a.isResolved && (
                    <button onClick={() => handleResolve(a.id)} className="shrink-0 text-xs text-green-600 hover:underline flex items-center gap-1" data-testid={`btn-resolve-${a.id}`}>
                      <CheckCircle className="w-3 h-3" /> Resolve
                    </button>
                  )}
                  {a.isResolved && <span className="text-xs text-muted-foreground shrink-0">Resolved</span>}
                </div>
              ))}
            </div>
          )}

          {tab === "sessions" && (
            <div className="bg-card border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border bg-muted/40">{["MAC", "IP", "Client", "In", "Out", "Started"].map(h => <th key={h} className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-border">
                  {sessions?.map(s => (
                    <tr key={s.id} data-testid={`row-session-${s.id}`}>
                      <td className="px-3 py-2 font-mono text-xs">{s.macAddress}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{s.ipAddress ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">{s.customerName ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{(s.bytesIn / 1024 / 1024).toFixed(1)} MB</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{(s.bytesOut / 1024 / 1024).toFixed(1)} MB</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(s.startedAt).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                  {!sessions?.length && <tr><td colSpan={6} className="text-center py-8 text-xs text-muted-foreground">No active sessions</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === "pppoe" && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-muted-foreground">Live PPPoE sessions from MikroTik</p>
                <button onClick={() => loadPppoe(selectedRouter)} className="text-xs text-primary hover:underline flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> Refresh
                </button>
              </div>
              <div className="bg-card border border-border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border bg-muted/40">{["Username", "Service", "IP", "Uptime", "Actions"].map(h => <th key={h} className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-border">
                    {pppoeLoading && <tr><td colSpan={5} className="text-center py-8 text-xs text-muted-foreground">Loading sessions...</td></tr>}
                    {!pppoeLoading && pppoeSessions.map(s => (
                      <tr key={s.id} data-testid={`row-pppoe-${s.id}`}>
                        <td className="px-3 py-2 text-xs font-medium">{s.name}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{s.service ?? "pppoe"}</td>
                        <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{s.address ?? "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{s.uptime ?? "—"}</td>
                        <td className="px-3 py-2 text-xs">
                          <button
                            onClick={() => handleDisconnect(s.name)}
                            disabled={disconnecting === s.name}
                            className="text-red-600 hover:underline text-xs disabled:opacity-50"
                            data-testid={`btn-disconnect-${s.id}`}
                          >
                            {disconnecting === s.name ? "Disconnecting..." : "Disconnect"}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!pppoeLoading && !pppoeSessions.length && <tr><td colSpan={5} className="text-center py-8 text-xs text-muted-foreground">No active PPPoE sessions. Click Refresh or Test first.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="p-6 space-y-4 max-w-5xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">Routers</h1>
            <p className="text-xs text-muted-foreground mt-0.5">{routers?.length ?? 0} routers</p>
          </div>
          <Button size="sm" onClick={openCreate} data-testid="btn-add-router"><Plus className="w-3.5 h-3.5 mr-1" /> Add Router</Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {isLoading && <p className="text-xs text-muted-foreground py-8 text-center col-span-2">Loading...</p>}
          {!isLoading && !routers?.length && <p className="text-xs text-muted-foreground py-8 text-center col-span-2">No routers configured</p>}
          {routers?.map(r => (
            <div key={r.id} data-testid={`card-router-${r.id}`} className="bg-card border border-border rounded-md p-4 cursor-pointer hover:border-primary/50 transition-colors" onClick={() => { setSelectedRouter(r.id); setTab("alerts"); setTestResult(null); }}>
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{r.name}</p>
                  <p className="text-xs text-muted-foreground font-mono">{r.ipAddress}:{r.apiPort}</p>
                  {r.model && <p className="text-xs text-muted-foreground mt-0.5">{r.model}</p>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={e => openEdit(r, e)} className="p-1.5 text-muted-foreground hover:text-foreground rounded-sm" data-testid={`btn-edit-router-${r.id}`}><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={e => handleDelete(r, e)} className="p-1.5 text-muted-foreground hover:text-destructive rounded-sm" data-testid={`btn-del-router-${r.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                  <span className={`inline-flex px-1.5 py-0.5 rounded-sm text-xs font-medium ${r.isActive ? "bg-green-500/10 text-green-700" : "bg-gray-100 text-gray-500"}`}>{r.isActive ? "Active" : "Inactive"}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">{r.apiUsername}@{r.ipAddress}</p>
            </div>
          ))}
        </div>

        <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) setEditRouter(null); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>{editRouter ? "Edit Router" : "Add Router"}</DialogTitle></DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
                <FormField control={form.control} name="name" render={({ field }) => (<FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} placeholder="Main Router" /></FormControl><FormMessage /></FormItem>)} />
                <div className="grid grid-cols-2 gap-2">
                  <FormField control={form.control} name="ipAddress" render={({ field }) => (<FormItem><FormLabel>IP Address</FormLabel><FormControl><Input {...field} placeholder="192.168.88.1" /></FormControl><FormMessage /></FormItem>)} />
                  <FormField control={form.control} name="apiPort" render={({ field }) => (<FormItem><FormLabel>API Port</FormLabel><FormControl><Input {...field} type="number" /></FormControl><FormMessage /></FormItem>)} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <FormField control={form.control} name="apiUsername" render={({ field }) => (<FormItem><FormLabel>Username</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>)} />
                  <FormField control={form.control} name="apiSecret" render={({ field }) => (<FormItem><FormLabel>Password</FormLabel><FormControl><Input {...field} type="password" placeholder={editRouter ? "(leave blank to keep)" : ""} /></FormControl><FormMessage /></FormItem>)} />
                </div>
                <FormField control={form.control} name="model" render={({ field }) => (<FormItem><FormLabel>Model (optional)</FormLabel><FormControl><Input {...field} placeholder="CCR1009" /></FormControl><FormMessage /></FormItem>)} />
                <div className="flex justify-end gap-2 pt-1">
                  <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button type="submit" size="sm" disabled={createMut.isPending || updateMut.isPending}>{editRouter ? "Save" : "Add Router"}</Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
