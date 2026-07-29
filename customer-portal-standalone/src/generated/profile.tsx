import { useEffect, useState } from "react";
import { useGetPortalMe, useUpdatePortalMe, getGetPortalMeQueryKey } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { PortalLayout } from "@/components/portal-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAuth } from "@/lib/auth";
import { User, Phone, Mail, MapPin, Hash, LogOut, Pencil, Loader2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

function Field({ icon: Icon, label, value }: { icon: React.ComponentType<{className?: string}>; label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium">{value}</p>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const { data, isLoading } = useGetPortalMe();
  const { logout, customer, updateCustomer } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");

  useEffect(() => {
    if (data && !editing) {
      setFirstName(data.firstName ?? "");
      setLastName(data.lastName ?? "");
      setEmail(data.email ?? "");
      setAddress(data.address ?? "");
    }
  }, [data, editing]);

  const updateMutation = useUpdatePortalMe({
    mutation: {
      onSuccess(data) {
        queryClient.invalidateQueries({ queryKey: getGetPortalMeQueryKey() });
        // The header greeting, avatar initials, and account-menu name all
        // read from the auth context (not this page's query data), so
        // without this they'd keep showing the pre-edit name until the
        // customer logs out and back in.
        updateCustomer({ firstName: data.firstName, lastName: data.lastName });
        setEditing(false);
        toast({ title: "Profile updated" });
      },
      onError() {
        toast({ title: "Failed to update profile", variant: "destructive" });
      },
    },
  });

  function handleSave() {
    updateMutation.mutate({
      data: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim() || null,
        address: address.trim() || null,
      },
    });
  }

  function handleCancel() {
    if (data) {
      setFirstName(data.firstName ?? "");
      setLastName(data.lastName ?? "");
      setEmail(data.email ?? "");
      setAddress(data.address ?? "");
    }
    setEditing(false);
  }

  const initials = customer
    ? `${customer.firstName[0] ?? ""}${customer.lastName[0] ?? ""}`
    : "?";

  return (
    <PortalLayout title="My Profile">
      <div className="space-y-4">
        {/* Avatar + name */}
        <Card>
          <CardContent className="pt-6 pb-4 flex flex-col items-center gap-3">
            <Avatar className="w-16 h-16 bg-primary/10">
              <AvatarFallback className="text-xl font-bold text-primary">
                {initials.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {isLoading ? (
              <Skeleton className="h-6 w-32" />
            ) : (
              <h2 className="text-xl font-bold">
                {data?.firstName} {data?.lastName}
              </h2>
            )}
          </CardContent>
        </Card>

        {/* Details */}
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-base">Account Details</CardTitle>
            {!isLoading && !editing && (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading ? (
              <>
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-44" />
              </>
            ) : editing ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="firstName">First Name</Label>
                    <Input id="firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="lastName">Last Name</Label>
                    <Input id="lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="address">Address</Label>
                  <Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Nairobi, Kenya" />
                </div>
                <Field icon={Phone} label="Phone Number" value={data?.phone} />
                <p className="text-xs text-muted-foreground">
                  Phone number and account number cannot be changed here — contact support if
                  you need to update them.
                </p>
                <div className="flex gap-2 pt-1">
                  <Button className="flex-1" onClick={handleSave} disabled={updateMutation.isPending}>
                    {updateMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-1" />
                    ) : (
                      <Check className="w-4 h-4 mr-1" />
                    )}
                    Save
                  </Button>
                  <Button variant="outline" className="flex-1" onClick={handleCancel} disabled={updateMutation.isPending}>
                    <X className="w-4 h-4 mr-1" /> Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Field icon={User} label="Full Name" value={`${data?.firstName} ${data?.lastName}`} />
                <Field icon={Phone} label="Phone Number" value={data?.phone} />
                <Field icon={Hash} label="Account Number" value={data?.accountNumber ?? "Not assigned"} />
                <Field icon={Mail} label="Email" value={data?.email ?? undefined} />
                <Field icon={MapPin} label="Address" value={data?.address ?? undefined} />
              </>
            )}
          </CardContent>
        </Card>

        {/* Wallet + Loyalty */}
        {data && (
          <div className="grid grid-cols-2 gap-3">
            {data.wallet && (
              <Card>
                <CardContent className="p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Wallet Balance</p>
                  <p className="text-lg font-bold text-primary">
                    {data.wallet.currency} {parseFloat(String(data.wallet.balance)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </p>
                </CardContent>
              </Card>
            )}
            {data.loyalty && (
              <Card>
                <CardContent className="p-3 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Loyalty Points</p>
                  <p className="text-lg font-bold text-yellow-600">
                    {(data.loyalty.balance ?? 0).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        <Button
          variant="outline"
          className="w-full text-destructive border-destructive/30 hover:bg-destructive/5"
          onClick={logout}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign Out
        </Button>
      </div>
    </PortalLayout>
  );
}
