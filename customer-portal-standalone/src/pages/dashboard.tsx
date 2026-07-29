import { useGetPortalDashboard } from "@/lib/api-client";
import { PortalLayout } from "@/components/portal-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import {
  Wifi,
  WifiOff,
  Star,
  Wallet,
  History,
  ArrowRight,
  Activity,
} from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(startedAt: string): string {
  const seconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export default function DashboardPage() {
  const { data, isLoading } = useGetPortalDashboard({
    query: {
      // Without this, the active-session duration/data-usage numbers freeze
      // at whatever they were when the dashboard first loaded.
      refetchInterval: (query) => (query.state.data?.activeSession ? 20_000 : false),
    },
  });
  const [, navigate] = useLocation();

  return (
    <PortalLayout title="Dashboard">
      <div className="space-y-4">
        {/* Active Session Card */}
        <Card className={`overflow-hidden ${data?.activeSession ? "border-green-400 ring-1 ring-green-300" : ""}`}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                {data?.activeSession ? (
                  <><Wifi className="w-4 h-4 text-green-500" /> Active Session</>
                ) : (
                  <><WifiOff className="w-4 h-4 text-muted-foreground" /> No Active Session</>
                )}
              </CardTitle>
              {data?.activeSession && (
                <Badge className="bg-green-100 text-green-700 border-green-200">
                  Connected
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-32" />
              </div>
            ) : data?.activeSession ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Duration</span>
                  <span className="font-medium font-mono">
                    {formatDuration(data.activeSession.startedAt ?? "")}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Downloaded</span>
                  <span className="font-medium">{formatBytes(data.activeSession.bytesIn ?? 0)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Uploaded</span>
                  <span className="font-medium">{formatBytes(data.activeSession.bytesOut ?? 0)}</span>
                </div>
                {data.activeSession.ipAddress && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">IP Address</span>
                    <span className="font-mono text-xs">{data.activeSession.ipAddress}</span>
                  </div>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mt-2"
                  onClick={() => navigate("/sessions")}
                >
                  <Activity className="mr-2 h-3 w-3" />
                  View Session Details
                </Button>
              </div>
            ) : (
              <div className="text-center py-3">
                <p className="text-sm text-muted-foreground">You are not currently connected to the hotspot.</p>
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() => navigate("/packages")}
                >
                  Browse Packages
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Stats row */}
        <div className="grid grid-cols-2 gap-4">
          {/* Wallet */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Wallet className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">Wallet</span>
              </div>
              {isLoading ? (
                <Skeleton className="h-7 w-20" />
              ) : (
                <>
                  <div className="text-2xl font-bold text-primary">
                    {data?.wallet
                      ? `${data.wallet.currency} ${parseFloat(String(data.wallet.balance)).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                      : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">Current balance</p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Loyalty */}
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Star className="w-4 h-4 text-yellow-500" />
                <span className="text-sm font-medium">Loyalty Points</span>
              </div>
              {isLoading ? (
                <Skeleton className="h-7 w-16" />
              ) : (
                <>
                  <div className="text-2xl font-bold text-yellow-600">
                    {data?.loyalty ? (data.loyalty.balance ?? 0).toLocaleString() : "0"}
                  </div>
                  <button
                    className="text-xs text-primary hover:underline mt-0.5"
                    onClick={() => navigate("/loyalty")}
                  >
                    Redeem points →
                  </button>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Quick actions */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            <button
              onClick={() => navigate("/packages")}
              className="w-full flex items-center justify-between p-3 rounded-lg bg-secondary hover:bg-secondary/80 transition-colors text-sm"
            >
              <span className="font-medium">Browse Packages</span>
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
            </button>
            <button
              onClick={() => navigate("/sessions")}
              className="w-full flex items-center justify-between p-3 rounded-lg bg-secondary hover:bg-secondary/80 transition-colors text-sm"
            >
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium">Session History</span>
              </div>
              <div className="flex items-center gap-2">
                {data?.recentSessionCount !== undefined && (
                  <Badge variant="secondary">{data.recentSessionCount}</Badge>
                )}
                <ArrowRight className="w-4 h-4 text-muted-foreground" />
              </div>
            </button>
            <button
              onClick={() => navigate("/loyalty")}
              className="w-full flex items-center justify-between p-3 rounded-lg bg-secondary hover:bg-secondary/80 transition-colors text-sm"
            >
              <div className="flex items-center gap-2">
                <Star className="w-4 h-4 text-yellow-500" />
                <span className="font-medium">Loyalty Rewards</span>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
            </button>
          </CardContent>
        </Card>
      </div>
    </PortalLayout>
  );
}
