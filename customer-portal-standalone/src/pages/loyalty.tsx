import { useState } from "react";
import {
  useGetPortalLoyalty,
  usePortalRedeemLoyalty,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { PortalLayout } from "@/components/portal-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Star, Gift, TrendingUp, Loader2 } from "lucide-react";
import { getGetPortalLoyaltyQueryKey } from "@/lib/api-client";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-KE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function LoyaltyPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useGetPortalLoyalty();
  const [redeemPoints, setRedeemPoints] = useState("");
  const [redeemError, setRedeemError] = useState("");
  const [redeemSuccess, setRedeemSuccess] = useState("");

  const redeemMutation = usePortalRedeemLoyalty({
    mutation: {
      onSuccess(result) {
        setRedeemSuccess(
          `Successfully redeemed! Your new balance is ${result.newBalance} points.`
        );
        setRedeemPoints("");
        setRedeemError("");
        qc.invalidateQueries({ queryKey: getGetPortalLoyaltyQueryKey() });
      },
      onError() {
        setRedeemError("Redemption failed. Please check your points balance.");
        setRedeemSuccess("");
      },
    },
  });

  function handleRedeem(e: React.FormEvent) {
    e.preventDefault();
    setRedeemError("");
    setRedeemSuccess("");
    const pts = parseInt(redeemPoints, 10);
    if (!pts || pts <= 0) {
      setRedeemError("Enter a valid number of points to redeem.");
      return;
    }
    if (data && pts > (data.balance ?? 0)) {
      setRedeemError("You don't have enough points.");
      return;
    }
    redeemMutation.mutate({ data: { points: pts, description: "Self-service redemption" } });
  }

  return (
    <PortalLayout title="Loyalty Points">
      <div className="space-y-5">
        {/* Balance summary */}
        <div className="grid grid-cols-2 gap-4">
          <Card className="text-center">
            <CardContent className="pt-5 pb-4">
              <Star className="w-6 h-6 text-yellow-500 mx-auto mb-2" />
              {isLoading ? (
                <Skeleton className="h-8 w-16 mx-auto" />
              ) : (
                <div className="text-3xl font-bold text-yellow-600">
                  {(data?.balance ?? 0).toLocaleString()}
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1">Available Points</p>
            </CardContent>
          </Card>
          <Card className="text-center">
            <CardContent className="pt-5 pb-4">
              <TrendingUp className="w-6 h-6 text-primary mx-auto mb-2" />
              {isLoading ? (
                <Skeleton className="h-8 w-16 mx-auto" />
              ) : (
                <div className="text-3xl font-bold text-primary">
                  {(data?.lifetimeEarned ?? 0).toLocaleString()}
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-1">Lifetime Earned</p>
            </CardContent>
          </Card>
        </div>

        {/* Redeem */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Gift className="w-4 h-4 text-primary" />
              Redeem Points
            </CardTitle>
          </CardHeader>
          <CardContent>
            {redeemError && (
              <Alert variant="destructive" className="mb-3">
                <AlertDescription>{redeemError}</AlertDescription>
              </Alert>
            )}
            {redeemSuccess && (
              <Alert className="mb-3 border-green-300 bg-green-50 text-green-800">
                <AlertDescription>{redeemSuccess}</AlertDescription>
              </Alert>
            )}
            <form onSubmit={handleRedeem} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="pts">Points to Redeem</Label>
                <Input
                  id="pts"
                  type="number"
                  min={1}
                  max={data?.balance}
                  placeholder="e.g. 100"
                  value={redeemPoints}
                  onChange={(e) => setRedeemPoints(e.target.value)}
                />
                {data && (
                  <p className="text-xs text-muted-foreground">
                    You have {(data.balance ?? 0).toLocaleString()} points available
                  </p>
                )}
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={redeemMutation.isPending || !data?.balance}
              >
                {redeemMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Redeeming…
                  </>
                ) : (
                  "Redeem Points"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Transaction history */}
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Points History
          </h2>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Card key={i}>
                  <CardContent className="p-3">
                    <Skeleton className="h-4 w-40 mb-1" />
                    <Skeleton className="h-3 w-24" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : data?.transactions && data.transactions.length > 0 ? (
            <div className="space-y-2">
              {data.transactions.map((tx) => (
                <Card key={tx.id}>
                  <CardContent className="p-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{tx.description}</p>
                      <p className="text-xs text-muted-foreground">{tx.createdAt ? formatDate(tx.createdAt) : "—"}</p>
                    </div>
                    <div className="text-right">
                      <span
                        className={`text-sm font-bold ${
                          (tx.points ?? 0) > 0 ? "text-green-600" : "text-red-500"
                        }`}
                      >
                        {(tx.points ?? 0) > 0 ? "+" : ""}
                        {tx.points ?? 0}
                      </span>
                      <Badge variant="outline" className="ml-2 text-xs">
                        {tx.type}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="text-center py-6">
                <p className="text-sm text-muted-foreground">No loyalty transactions yet.</p>
              </CardContent>
            </Card>
          )}
        </section>
      </div>
    </PortalLayout>
  );
}
