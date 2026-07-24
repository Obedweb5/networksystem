import { Router, type IRouter } from "express";
import * as zod from "zod";
import { db } from "@workspace/db";
import { tenantsTable, tenantMpesaSettingsTable, ROLES } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { encryptCredential } from "../lib/provisioning-credentials";

const router: IRouter = Router();

router.get("/tenant", requireAuth, async (req, res) => {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.user!.tenantId)).limit(1);
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
  res.json({ tenant });
});

const UpdateTenantBody = zod.object({
  name: zod.string().min(2).optional(),
  logoUrl: zod.string().url().optional().or(zod.literal("")),
  loyaltyPointsPerKes: zod.coerce.number().min(0).max(1000).optional(),
  loyaltyRedemptionValueKes: zod.coerce.number().min(0).max(1000).optional(),
});

router.patch("/tenant", requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.BUSINESS_OWNER), async (req, res) => {
  const parse = UpdateTenantBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request", details: parse.error.issues }); return; }

  // drizzle's numeric() columns are string-typed on write (Postgres numeric
  // is represented as a string in the driver to avoid float precision loss)
  // — convert the zod-coerced JS numbers explicitly rather than spreading
  // them straight into .set(), which would be a type mismatch.
  const { loyaltyPointsPerKes, loyaltyRedemptionValueKes, ...rest } = parse.data;
  const [tenant] = await db.update(tenantsTable).set({
    ...rest,
    ...(loyaltyPointsPerKes !== undefined ? { loyaltyPointsPerKes: String(loyaltyPointsPerKes) } : {}),
    ...(loyaltyRedemptionValueKes !== undefined ? { loyaltyRedemptionValueKes: String(loyaltyRedemptionValueKes) } : {}),
    updatedAt: new Date(),
  }).where(eq(tenantsTable.id, req.user!.tenantId)).returning();
  res.json({ tenant });
});

router.post("/tenant/onboarding/complete", requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.BUSINESS_OWNER), async (req, res) => {
  const [tenant] = await db.update(tenantsTable).set({ onboardingCompletedAt: new Date(), updatedAt: new Date() })
    .where(eq(tenantsTable.id, req.user!.tenantId)).returning();
  res.json({ tenant });
});

// --- M-PESA provider settings (Settings > Payment Methods > M-Pesa Paybill/Till) ---
// No test-send endpoint here unlike /settings/sms/test — an STK push always
// prompts a real phone and (on completion) moves real money, so there is no
// safe no-op "test" the way an SMS test message is.

router.get("/settings/mpesa", requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.BUSINESS_OWNER), async (req, res) => {
  const { tenantId } = req.user!;
  const [settings] = await db.select().from(tenantMpesaSettingsTable).where(eq(tenantMpesaSettingsTable.tenantId, tenantId)).limit(1);
  if (!settings) {
    res.json({ accountType: "PAYBILL", shortcode: null, environment: "sandbox", callbackUrl: null, hasConsumerKey: false, hasConsumerSecret: false, hasPasskey: false, isEnabled: false, configured: false });
    return;
  }
  // Never return decrypted secrets to the client — only whether they're set.
  res.json({
    accountType: settings.accountType, shortcode: settings.shortcode, environment: settings.environment, callbackUrl: settings.callbackUrl,
    hasConsumerKey: !!settings.consumerKeyEncrypted, hasConsumerSecret: !!settings.consumerSecretEncrypted, hasPasskey: !!settings.passkeyEncrypted,
    isEnabled: settings.isEnabled, configured: true, updatedAt: settings.updatedAt,
  });
});

const UpdateMpesaSettingsBody = zod.object({
  accountType: zod.enum(["PAYBILL", "TILL"]).optional(),
  shortcode: zod.string().min(1).optional(),
  environment: zod.enum(["sandbox", "production"]).optional(),
  callbackUrl: zod.union([zod.string().url(), zod.literal("")]).optional(),
  consumerKey: zod.string().optional(),
  consumerSecret: zod.string().optional(),
  passkey: zod.string().optional(),
  isEnabled: zod.boolean().optional(),
});

router.put("/settings/mpesa", requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.BUSINESS_OWNER), async (req, res) => {
  const parse = UpdateMpesaSettingsBody.safeParse(req.body ?? {});
  if (!parse.success) { res.status(400).json({ error: "Invalid request", details: parse.error.issues }); return; }
  const { tenantId } = req.user!;
  const body = parse.data;

  const [existing] = await db.select().from(tenantMpesaSettingsTable).where(eq(tenantMpesaSettingsTable.tenantId, tenantId)).limit(1);
  const values = {
    tenantId,
    accountType: body.accountType ?? existing?.accountType ?? "PAYBILL",
    shortcode: body.shortcode !== undefined ? body.shortcode : existing?.shortcode ?? null,
    environment: body.environment ?? existing?.environment ?? "sandbox",
    callbackUrl: body.callbackUrl !== undefined ? (body.callbackUrl || null) : existing?.callbackUrl ?? null,
    // Only re-encrypt when a new value is actually supplied — a PUT that
    // omits a secret (e.g. just flipping isEnabled or the account type)
    // must not wipe out a previously-saved credential.
    consumerKeyEncrypted: body.consumerKey ? encryptCredential(body.consumerKey) : existing?.consumerKeyEncrypted ?? null,
    consumerSecretEncrypted: body.consumerSecret ? encryptCredential(body.consumerSecret) : existing?.consumerSecretEncrypted ?? null,
    passkeyEncrypted: body.passkey ? encryptCredential(body.passkey) : existing?.passkeyEncrypted ?? null,
    isEnabled: body.isEnabled !== undefined ? body.isEnabled : existing?.isEnabled ?? false,
    updatedAt: new Date(),
  };

  const [saved] = existing
    ? await db.update(tenantMpesaSettingsTable).set(values).where(eq(tenantMpesaSettingsTable.tenantId, tenantId)).returning()
    : await db.insert(tenantMpesaSettingsTable).values(values).returning();

  res.json({
    accountType: saved!.accountType, shortcode: saved!.shortcode, environment: saved!.environment, callbackUrl: saved!.callbackUrl,
    hasConsumerKey: !!saved!.consumerKeyEncrypted, hasConsumerSecret: !!saved!.consumerSecretEncrypted, hasPasskey: !!saved!.passkeyEncrypted,
    isEnabled: saved!.isEnabled, configured: true, updatedAt: saved!.updatedAt,
  });
});

export default router;
