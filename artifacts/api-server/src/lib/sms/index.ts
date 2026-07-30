import { db } from "@workspace/db";
import { tenantSmsSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { decryptCredential } from "../provisioning-credentials";
import { TexinSmsProvider } from "./texin-provider";
import { NoopSmsProvider } from "./noop-provider";
import type { SmsProvider } from "./types";

export type { SmsProvider, SmsSendParams, SmsSendResult } from "./types";

const noop = new NoopSmsProvider();

/**
 * Notification Service → SmsProvider interface → concrete provider. Nothing
 * outside this file knows Texin exists — lib/notify.ts just calls
 * getSmsProvider(tenantId).send(...). A second provider later (or a
 * per-tenant choice of provider) only ever changes the branches here.
 *
 * Resolution order: an enabled tenant_sms_settings row (dashboard-configured)
 * takes priority over the deployment-wide TEXIN_* env vars, so a tenant can
 * override the platform default with their own Texin account. Falls back to
 * NoopSmsProvider — never throws — so the app runs fine with nothing
 * configured; sends just stay QUEUED with a clear reason (see noop-provider.ts).
 */
export async function getSmsProvider(tenantId: string): Promise<SmsProvider> {
  const [tenantSettings] = await db.select().from(tenantSmsSettingsTable).where(eq(tenantSmsSettingsTable.tenantId, tenantId)).limit(1);

  // Texin's real gateway only needs an api_key (no secret) — apiUrl is
  // optional here since the provider already defaults to the real endpoint;
  // only override it if the tenant has explicitly configured a different one.
  if (tenantSettings?.isEnabled && tenantSettings.provider === "texin" && tenantSettings.apiKeyEncrypted) {
    try {
      return new TexinSmsProvider({
        apiKey: decryptCredential(tenantSettings.apiKeyEncrypted),
        gatewayUrl: tenantSettings.apiUrl ?? undefined,
      });
    } catch {
      // Decryption failure (e.g. PROVISIONING_CREDENTIAL_KEY rotated) must
      // never crash a send — fall through to the env-based default below.
    }
  }

  const { TEXIN_API_KEY, TEXIN_GATEWAY_URL, SMS_PROVIDER } = process.env;
  if ((SMS_PROVIDER ?? "texin") === "texin" && TEXIN_API_KEY) {
    return new TexinSmsProvider({ apiKey: TEXIN_API_KEY, gatewayUrl: TEXIN_GATEWAY_URL });
  }

  return noop;
}
