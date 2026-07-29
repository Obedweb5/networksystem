import { useState } from "react";
import { useLocation } from "wouter";
import { getBaseUrl } from "@/lib/api-client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Wifi, Loader2 } from "lucide-react";

// tenantId is resolved the same way packages.tsx does it — from the URL,
// since this is a multi-tenant portal with no other way yet to know which
// ISP's customer is signing in.
const TENANT_ID = new URLSearchParams(window.location.search).get("tenantId") ?? "";
const PHONE_RE = /^0[17]\d{8}$/;

interface VerifyResponse {
  accessToken: string;
  refreshToken: string;
  customer: {
    id: string;
    tenantId: string;
    firstName: string;
    lastName: string;
    phone: string;
    accountNumber: string | null;
  };
}

// There's no generated hook for these — /portal/auth/otp/request and
// /portal/auth/otp/verify are real backend routes (routes/portal.ts) but
// weren't in openapi.yaml, so `pnpm codegen` never produced hooks for them.
// The spec has since been corrected to document them; once codegen is
// re-run this can move to useRequestOtp/useVerifyOtp like the rest of the
// app. Until then, this calls them directly the same way use-noc-stream.ts
// does for the one other endpoint in this codebase without a generated hook.
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const base = getBaseUrl() ?? "";
  const res = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? "Something went wrong. Please try again.");
  return json as T;
}

export default function LoginPage() {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [isRequesting, setIsRequesting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const { login, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();

  if (isAuthenticated) {
    navigate("/dashboard");
    return null;
  }

  async function requestOtp(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    const trimmed = phone.trim();
    if (!PHONE_RE.test(trimmed)) {
      setError("Enter a valid phone number, e.g. 0712345678.");
      return;
    }
    setIsRequesting(true);
    try {
      await postJson("/portal/auth/otp/request", { tenantId: TENANT_ID, phone: trimmed });
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send a code right now.");
    } finally {
      setIsRequesting(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code sent to your phone.");
      return;
    }
    setIsVerifying(true);
    try {
      const data = await postJson<VerifyResponse>("/portal/auth/otp/verify", {
        tenantId: TENANT_ID,
        phone: phone.trim(),
        code,
      });
      login(data.accessToken, data.refreshToken, data.customer);
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired code.");
    } finally {
      setIsVerifying(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-primary/10 to-background p-4">
      {/* Logo / Brand */}
      <div className="flex flex-col items-center mb-8">
        <div className="w-16 h-16 bg-primary rounded-2xl flex items-center justify-center mb-3 shadow-lg">
          <Wifi className="w-8 h-8 text-white" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">PulseNet</h1>
        <p className="text-sm text-muted-foreground mt-1">Customer Self-Service Portal</p>
      </div>

      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader className="text-center pb-2">
          <CardTitle className="text-xl">Sign In</CardTitle>
          <CardDescription>
            {step === "phone"
              ? "Enter your phone number and we'll send you a code"
              : `Enter the 6-digit code sent to ${phone.trim()}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {step === "phone" ? (
            <form onSubmit={requestOtp} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number</Label>
                <Input
                  id="phone"
                  type="text"
                  placeholder="e.g. 0712345678"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoFocus
                  inputMode="tel"
                />
                <p className="text-xs text-muted-foreground">
                  Use the phone number registered with PulseNet
                </p>
              </div>
              <Button type="submit" className="w-full" disabled={isRequesting}>
                {isRequesting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending code…
                  </>
                ) : (
                  "Send Code"
                )}
              </Button>
            </form>
          ) : (
            <form onSubmit={verifyOtp} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="code">Verification Code</Label>
                <Input
                  id="code"
                  type="text"
                  placeholder="6-digit code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  autoFocus
                  inputMode="numeric"
                  maxLength={6}
                />
              </div>
              <Button type="submit" className="w-full" disabled={isVerifying}>
                {isVerifying ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  "Verify & Sign In"
                )}
              </Button>
              <div className="flex justify-between text-sm">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => { setStep("phone"); setCode(""); setError(""); }}
                >
                  ← Change number
                </button>
                <button
                  type="button"
                  className="text-primary hover:underline disabled:opacity-50"
                  disabled={isRequesting}
                  onClick={() => requestOtp()}
                >
                  Resend code
                </button>
              </div>
            </form>
          )}

          <div className="mt-4 text-center">
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              onClick={() => navigate("/packages")}
            >
              Browse packages without signing in →
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
