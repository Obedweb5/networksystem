import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle, AlertTriangle, Info, CheckCircle2, Circle, Sparkles, RefreshCw,
  ShieldCheck, ShieldAlert, TrendingUp, ChevronDown, ChevronRight, Loader2, Zap, FileText,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { useNocStream } from "@/hooks/use-noc-stream";
import {
  getNocOverview, listIncidents, getIncident, acknowledgeIncident, resolveIncident, getIncidentReport,
  listRecommendations, approveRecommendation, rejectRecommendation, listForecasts,
  getNocSettings, updateNocSettings,
  type NocIncidentDto, type NocRecommendationDto, type IncidentSeverity,
} from "@/lib/noc-api";
import { SystemAssistantChat } from "./SystemAssistantChat";

const OPERATOR_ROLES = ["super_admin", "business_owner", "staff", "technician"];

function hasOperatorRole(roles: string[] | undefined): boolean {
  return (roles ?? []).some((r) => OPERATOR_ROLES.includes(r.toLowerCase()));
}

const SEVERITY_STYLE: Record<IncidentSeverity, { className: string; icon: typeof AlertCircle }> = {
  CRITICAL: { className: "text-red-600 bg-red-500/10 border-red-200", icon: AlertCircle },
  WARN: { className: "text-yellow-600 bg-yellow-500/10 border-yellow-200", icon: AlertTriangle },
  INFO: { className: "text-blue-600 bg-blue-500/10 border-blue-200", icon: Info },
};

function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold ${tone ?? ""}`}>{value}</p>
    </div>
  );
}

export function AiNocView() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOperator = hasOperatorRole(user?.roles);
  const isSettingsAdmin = (user?.roles ?? []).some((r) => ["super_admin", "business_owner"].includes(r.toLowerCase()));
  const [expandedIncident, setExpandedIncident] = useState<string | null>(null);
  const [reportFor, setReportFor] = useState<{ id: string; markdown: string } | null>(null);

  const overview = useQuery({ queryKey: ["noc", "overview"], queryFn: getNocOverview, refetchInterval: 60_000 });
  const incidents = useQuery({ queryKey: ["noc", "incidents"], queryFn: () => listIncidents(), refetchInterval: 60_000 });
  const recommendations = useQuery({ queryKey: ["noc", "recommendations"], queryFn: () => listRecommendations("PENDING"), refetchInterval: 30_000 });
  const forecasts = useQuery({ queryKey: ["noc", "forecasts"], queryFn: listForecasts, refetchInterval: 300_000 });
  const settings = useQuery({ queryKey: ["noc", "settings"], queryFn: getNocSettings });

  async function handleToggleAutoRemediation(enabled: boolean) {
    const result = await updateNocSettings({ autoRemediationEnabled: enabled }).catch((err) => { toast({ title: "Couldn't update setting", description: err instanceof Error ? err.message : String(err), variant: "destructive" }); return null; });
    if (result) {
      qc.invalidateQueries({ queryKey: ["noc", "settings"] });
      toast({ title: enabled ? "Auto-remediation enabled" : "Auto-remediation disabled", description: enabled ? "SAFE-tier recommendations will now run automatically." : "All recommendations, including SAFE ones, will wait for a staff click." });
    }
  }

  useNocStream((event) => {
    if (event.type.startsWith("incident.")) qc.invalidateQueries({ queryKey: ["noc", "incidents"] });
    if (event.type.startsWith("recommendation.")) qc.invalidateQueries({ queryKey: ["noc", "recommendations"] });
    if (event.type === "router.snapshot") qc.invalidateQueries({ queryKey: ["noc", "overview"] });
  });

  const openIncidents = (incidents.data?.incidents ?? []).filter((i) => i.status === "OPEN" || i.status === "ACKNOWLEDGED");
  const pendingRecs = recommendations.data?.recommendations ?? [];

  async function handleApprove(rec: NocRecommendationDto) {
    const result = await approveRecommendation(rec.id).catch((err) => ({ success: false, error: err instanceof Error ? err.message : String(err) }));
    if (result.success) {
      toast({ title: "Action executed", description: rec.title });
    } else {
      toast({ title: "Action failed", description: result.error ?? "Unknown error", variant: "destructive" });
    }
    qc.invalidateQueries({ queryKey: ["noc", "recommendations"] });
    qc.invalidateQueries({ queryKey: ["noc", "incidents"] });
  }

  async function handleReject(rec: NocRecommendationDto) {
    await rejectRecommendation(rec.id).catch(() => {});
    qc.invalidateQueries({ queryKey: ["noc", "recommendations"] });
    toast({ title: "Recommendation dismissed" });
  }

  async function handleAcknowledge(id: string) {
    await acknowledgeIncident(id).catch(() => {});
    qc.invalidateQueries({ queryKey: ["noc", "incidents"] });
  }

  async function handleResolve(id: string) {
    await resolveIncident(id).catch(() => {});
    qc.invalidateQueries({ queryKey: ["noc", "incidents"] });
  }

  async function handleReport(id: string) {
    const report = await getIncidentReport(id).catch(() => null);
    if (report) setReportFor({ id, markdown: report.markdown });
  }

  const o = overview.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">AI Network Operations Center</h2>
        </div>
        {o && !o.llmNarrativeAvailable && (
          <Badge variant="outline" className="text-xs text-muted-foreground">Rule-based mode — no LLM narrative configured</Badge>
        )}
        <div className="ml-auto flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
          <span className="text-xs text-muted-foreground">Auto-run safe actions</span>
          {isSettingsAdmin ? (
            <Switch checked={settings.data?.settings.autoRemediationEnabled ?? false} onCheckedChange={handleToggleAutoRemediation} />
          ) : (
            <Badge variant="outline" className="text-xs">{settings.data?.settings.autoRemediationEnabled ? "On" : "Off"}</Badge>
          )}
        </div>
      </div>
      <p className="-mt-4 text-xs text-muted-foreground">
        Off by default: the network analyst here can always recommend and (with a staff click) run safe fixes, but nothing runs unattended until this is switched on.
        {isOperator && " Recommendations needing account changes (suspend, reactivate, move router) always require a staff approval regardless of this setting."}
      </p>

      <SystemAssistantChat />

      {/* Overview tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Routers online" value={o ? `${o.routers.online}/${o.routers.total}` : "—"} tone={o && o.routers.offline > 0 ? "text-red-600" : "text-green-600"} />
        <StatTile label="Degraded" value={o?.routers.degraded ?? "—"} tone={o && o.routers.degraded > 0 ? "text-yellow-600" : undefined} />
        <StatTile label="PPPoE active" value={o?.sessions.pppoeActive ?? "—"} />
        <StatTile label="Hotspot active" value={o?.sessions.hotspotActive ?? "—"} />
        <StatTile label="Open incidents" value={o?.incidents.open ?? "—"} tone={o && o.incidents.critical > 0 ? "text-red-600" : undefined} />
        <StatTile label="Pending actions" value={o?.recommendations.pending ?? "—"} tone={o && o.recommendations.pending > 0 ? "text-yellow-600" : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Incidents feed */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Incidents</CardTitle>
            {incidents.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </CardHeader>
          <CardContent className="space-y-2">
            {openIncidents.length === 0 && <p className="text-sm text-muted-foreground">No open incidents. The network looks healthy.</p>}
            {openIncidents.map((incident) => (
              <IncidentRow
                key={incident.id}
                incident={incident}
                expanded={expandedIncident === incident.id}
                onToggle={() => setExpandedIncident(expandedIncident === incident.id ? null : incident.id)}
                onAcknowledge={() => handleAcknowledge(incident.id)}
                onResolve={() => handleResolve(incident.id)}
                onReport={() => handleReport(incident.id)}
                canOperate={isOperator}
              />
            ))}
          </CardContent>
        </Card>

        {/* Recommendations queue */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recommended actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingRecs.length === 0 && <p className="text-sm text-muted-foreground">No pending recommendations.</p>}
            {pendingRecs.map((rec) => (
              <div key={rec.id} className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium">{rec.title}</p>
                  {rec.riskLevel === "SAFE" ? (
                    <Badge variant="outline" className="shrink-0 gap-1 text-green-700 border-green-200 bg-green-500/10"><ShieldCheck className="h-3 w-3" />Safe</Badge>
                  ) : rec.riskLevel === "REQUIRES_APPROVAL" ? (
                    <Badge variant="outline" className="shrink-0 gap-1 text-yellow-700 border-yellow-200 bg-yellow-500/10"><ShieldAlert className="h-3 w-3" />Needs approval</Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0 text-muted-foreground">Info</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{rec.rationale}</p>
                {isOperator && rec.riskLevel !== "INFO_ONLY" && (
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" variant="default" className="h-7 gap-1 text-xs" onClick={() => handleApprove(rec)}>
                      <Zap className="h-3 w-3" />{rec.riskLevel === "SAFE" ? "Run now" : "Approve"}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleReject(rec)}>Dismiss</Button>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Capacity forecasts */}
      {(forecasts.data?.forecasts.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><TrendingUp className="h-4 w-4" />Capacity forecasts</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {forecasts.data?.forecasts.map((f) => (
              <div key={f.id} className="rounded-md border border-border p-3">
                <p className="text-sm font-medium">{Number(f.current_utilization_percent).toFixed(0)}% of sold capacity</p>
                <p className="text-xs text-muted-foreground">
                  {f.projected_breach_at
                    ? `Projected to reach ${f.breach_threshold_percent}% around ${new Date(f.projected_breach_at).toLocaleDateString()}`
                    : f.sample_days < 5
                      ? `Collecting data (${f.sample_days}/5 days so far)`
                      : "Stable — no capacity breach projected"}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {reportFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setReportFor(null)}>
          <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-md border border-border bg-background p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 font-semibold"><FileText className="h-4 w-4" />Incident report</h3>
              <Button size="sm" variant="ghost" onClick={() => setReportFor(null)}>Close</Button>
            </div>
            <pre className="whitespace-pre-wrap text-sm">{reportFor.markdown}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function IncidentRow({ incident, expanded, onToggle, onAcknowledge, onResolve, onReport, canOperate }: {
  incident: NocIncidentDto; expanded: boolean; onToggle: () => void;
  onAcknowledge: () => void; onResolve: () => void; onReport: () => void; canOperate: boolean;
}) {
  const style = SEVERITY_STYLE[incident.severity];
  const Icon = style.icon;
  const detail = useQuery({ queryKey: ["noc", "incident", incident.id], queryFn: () => getIncident(incident.id), enabled: expanded });

  return (
    <div className={`rounded-md border p-3 ${style.className}`}>
      <button className="flex w-full items-start justify-between gap-2 text-left" onClick={onToggle}>
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="text-sm font-medium leading-tight">{incident.title}</p>
            <p className="mt-0.5 text-xs opacity-80">{incident.detectionSummary}</p>
          </div>
        </div>
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-current/20 pt-3">
          {incident.rootCauseNarrative && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-70">Root cause</p>
              <p className="text-sm">{incident.rootCauseNarrative}</p>
            </div>
          )}
          <p className="text-xs opacity-80">{incident.customersImpactedCount} customer(s) impacted · opened {new Date(incident.openedAt).toLocaleString()}</p>

          {detail.data && detail.data.events.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide opacity-70">Timeline</p>
              <ul className="mt-1 space-y-1">
                {detail.data.events.map((e) => (
                  <li key={e.id} className="text-xs opacity-90">
                    <span className="opacity-60">{new Date(e.createdAt).toLocaleTimeString()}</span> — {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canOperate && (
            <div className="flex gap-2 pt-1">
              {incident.status === "OPEN" && (
                <Button size="sm" variant="outline" className="h-7 gap-1 bg-background text-xs" onClick={onAcknowledge}>
                  <Circle className="h-3 w-3" />Acknowledge
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-7 gap-1 bg-background text-xs" onClick={onResolve}>
                <CheckCircle2 className="h-3 w-3" />Resolve
              </Button>
              <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={onReport}>
                <FileText className="h-3 w-3" />Report
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
