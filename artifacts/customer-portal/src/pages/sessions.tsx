import { useGetPortalCurrentSession, useGetPortalSessionHistory } from "@/lib/api-client";
import { PortalLayout } from "@/components/portal-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Wifi, WifiOff, Clock, Download, Upload, Monitor } from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-KE", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SessionsPage() {
  const { data: current, isLoading: currentLoading } = useGetPortalCurrentSession({
    query: {
      // Keep the live card actually live — without this, duration and
      // data-usage freeze at whatever they were when the page loaded.
      refetchInterval: (query) => (query.state.data?.session ? 20_000 : false),
    },
  });
  const { data: history, isLoading: historyLoading } = useGetPortalSessionHistory();

  return (
    <PortalLayout title="Sessions">
      <div className="space-y-5">
        {/* Current session */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Current Session
          </h2>
          {currentLoading ? (
            <Card>
              <CardContent className="p-4 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-48" />
              </CardContent>
            </Card>
          ) : current?.session ? (
            <Card className="border-green-400 ring-1 ring-green-200">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Wifi className="w-4 h-4 text-green-500" />
                    Active
                  </CardTitle>
                  <Badge className="bg-green-100 text-green-700 border-green-200">Live</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Clock className="w-3 h-3" /> Duration
                  </span>
                  <span className="font-mono font-medium">
                    {formatDuration(current.session.durationSeconds)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Download className="w-3 h-3" /> Downloaded
                  </span>
                  <span>{formatBytes(current.session.bytesIn ?? 0)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Upload className="w-3 h-3" /> Uploaded
                  </span>
                  <span>{formatBytes(current.session.bytesOut ?? 0)}</span>
                </div>
                {current.session.macAddress && (
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <Monitor className="w-3 h-3" /> Device
                    </span>
                    <span className="font-mono text-xs">{current.session.macAddress}</span>
                  </div>
                )}
                {current.session.ipAddress && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">IP</span>
                    <span className="font-mono text-xs">{current.session.ipAddress}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Started</span>
                  <span className="text-xs">{current.session.startedAt ? formatDate(current.session.startedAt) : "—"}</span>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="text-center py-6">
                <WifiOff className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No active session</p>
              </CardContent>
            </Card>
          )}
        </section>

        {/* History */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Session History
          </h2>
          {historyLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Card key={i}>
                  <CardContent className="p-3 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : history && history.length > 0 ? (
            <div className="space-y-3">
              {history.map((session) => (
                <Card key={session.id}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <p className="text-sm font-medium">
                          {session.startedAt ? formatDate(session.startedAt) : "—"}
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {session.macAddress}
                        </p>
                      </div>
                      <Badge variant="secondary" className="text-xs">
                        {formatDuration(session.durationSeconds)}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Download className="w-3 h-3" />
                        {formatBytes(session.bytesIn ?? 0)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Upload className="w-3 h-3" />
                        {formatBytes(session.bytesOut ?? 0)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="text-center py-6">
                <p className="text-sm text-muted-foreground">No session history yet</p>
              </CardContent>
            </Card>
          )}
        </section>
      </div>
    </PortalLayout>
  );
}
