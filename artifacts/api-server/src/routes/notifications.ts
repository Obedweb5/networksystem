import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { notificationTemplatesTable, notificationLogsTable, customersTable, tenantSmsSettingsTable, ROLES } from "@workspace/db/schema";
import { eq, and, sql, desc, count } from "drizzle-orm";
import {
  CreateNotificationTemplateBody, UpdateNotificationTemplateParams, UpdateNotificationTemplateBody,
  DeleteNotificationTemplateParams, ListNotificationLogsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, requireRole } from "../middlewares/auth";
import { getSmsProvider } from "../lib/sms";
import { encryptCredential } from "../lib/provisioning-credentials";

const router: IRouter = Router();

router.get("/notification-templates", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const data = await db.select().from(notificationTemplatesTable).where(eq(notificationTemplatesTable.tenantId, tenantId)).orderBy(desc(notificationTemplatesTable.createdAt));
  res.json(data);
});

router.post("/notification-templates", requireAuth, async (req, res) => {
  const parse = CreateNotificationTemplateBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Validation failed", details: parse.error.issues }); return; }
  const { tenantId } = req.user!;
  const [tmpl] = await db.insert(notificationTemplatesTable).values({ tenantId, ...parse.data, variables: parse.data.variables ?? [] }).returning();
  res.status(201).json(tmpl);
});

router.patch("/notification-templates/:id", requireAuth, async (req, res) => {
  return notificationTemplateUpdate(req, res);
});

async function notificationTemplateUpdate(req: any, res: any) {
  const paramParse = UpdateNotificationTemplateParams.safeParse(req.params);
  const bodyParse = UpdateNotificationTemplateBody.safeParse(req.body);
  if (!paramParse.success || !bodyParse.success) { res.status(400).json({ error: "Validation failed" }); return; }
  const { tenantId } = req.user!;
  const [updated] = await db.update(notificationTemplatesTable).set({ ...bodyParse.data, updatedAt: new Date() })
    .where(and(eq(notificationTemplatesTable.id, paramParse.data.id), eq(notificationTemplatesTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Template not found" }); return; }
  res.json(updated);
}

router.delete("/notification-templates/:id", requireAuth, async (req, res) => {
  const parse = DeleteNotificationTemplateParams.safeParse(req.params);
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { tenantId } = req.user!;
  await db.delete(notificationTemplatesTable).where(and(eq(notificationTemplatesTable.id, parse.data.id), eq(notificationTemplatesTable.tenantId, tenantId)));
  res.json({ success: true });
});

router.get("/notification-logs", requireAuth, async (req, res) => {
  const parse = ListNotificationLogsQueryParams.safeParse(req.query);
  if (!parse.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const { tenantId } = req.user!;
  const { page, limit, customerId, status } = parse.data;
  const offset = (page - 1) * limit;
  const conditions = [eq(notificationLogsTable.tenantId, tenantId)];
  if (customerId) conditions.push(eq(notificationLogsTable.customerId, customerId));
  if (status) conditions.push(eq(notificationLogsTable.status, status));
  const [rows, [{ total }]] = await Promise.all([
    db.select({ log: notificationLogsTable, customerName: sql<string | null>`${customersTable.firstName} || ' ' || ${customersTable.lastName}` })
      .from(notificationLogsTable).leftJoin(customersTable, eq(notificationLogsTable.customerId, customersTable.id))
      .where(and(...conditions)).orderBy(desc(notificationLogsTable.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(notificationLogsTable).where(and(...conditions)),
  ]);
  res.json({ data: rows.map(r => ({ ...r.log, customerName: r.customerName })), total: Number(total), page, limit });
});

// Send an ad-hoc notification (used by the admin dashboard's "Test SMS" button,
// and for one-off sends outside the templated event flow in lib/notify.ts).
// Actually attempts delivery through the configured provider — previously
// this just wrote a log row claiming SENT without sending anything.
router.post("/notifications/send", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { customerId, channel, recipient, templateId, message } = req.body;

  if (!channel || !recipient) {
    res.status(400).json({ error: "channel and recipient are required" });
    return;
  }
  const validChannels = ["SMS", "EMAIL", "WHATSAPP"];
  if (!validChannels.includes(channel)) {
    res.status(400).json({ error: `channel must be one of: ${validChannels.join(", ")}` });
    return;
  }
  if (channel !== "SMS") {
    // EMAIL/WHATSAPP have no provider wired up yet — say so rather than logging a fake SENT.
    res.status(501).json({ error: `${channel} sending is not implemented yet` });
    return;
  }
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required for a direct SMS send" });
    return;
  }

  const [log] = await db.insert(notificationLogsTable).values({
    tenantId, customerId: customerId ?? null, templateId: templateId ?? null,
    channel, recipient, body: message, status: "SENDING",
  }).returning();

  const provider = await getSmsProvider(tenantId);
  const result = await provider.send({ to: recipient, message });

  const [updated] = await db.update(notificationLogsTable).set(
    result.success
      ? { status: "SENT", providerMessageId: result.providerMessageId, sentAt: new Date() }
      : { status: "QUEUED", errorMessage: result.error, nextRetryAt: new Date(Date.now() + 60_000) },
  ).where(eq(notificationLogsTable.id, log.id)).returning();

  res.status(result.success ? 201 : 502).json({ ...updated, deliveryError: result.success ? undefined : result.error });
});

// --- SMS provider settings (Settings > Notifications > SMS) -----------------

router.get("/settings/sms", requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.BUSINESS_OWNER), async (req, res) => {
  const { tenantId } = req.user!;
  const [settings] = await db.select().from(tenantSmsSettingsTable).where(eq(tenantSmsSettingsTable.tenantId, tenantId)).limit(1);
  if (!settings) {
    // No row yet — this is the "⚠ Configuration Required" state; the
    // deployment-wide TEXIN_* env vars may still work as a fallback (see
    // lib/sms/index.ts), this just reports whether *this tenant* has
    // configured their own.
    res.json({ provider: "texin", senderId: null, apiUrl: null, hasApiKey: false, hasApiSecret: false, isEnabled: false, configured: false });
    return;
  }
  // Never return decrypted secrets to the client — only whether they're set.
  res.json({
    provider: settings.provider, senderId: settings.senderId, apiUrl: settings.apiUrl,
    hasApiKey: !!settings.apiKeyEncrypted, hasApiSecret: !!settings.apiSecretEncrypted,
    isEnabled: settings.isEnabled, configured: true, updatedAt: settings.updatedAt,
  });
});

router.put("/settings/sms", requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.BUSINESS_OWNER), async (req, res) => {
  const { tenantId } = req.user!;
  const { provider, senderId, apiUrl, apiKey, apiSecret, isEnabled } = req.body ?? {};
  if (provider !== undefined && provider !== "texin") { res.status(400).json({ error: "Only the 'texin' provider is supported right now" }); return; }

  const [existing] = await db.select().from(tenantSmsSettingsTable).where(eq(tenantSmsSettingsTable.tenantId, tenantId)).limit(1);
  const values = {
    tenantId,
    provider: "texin",
    senderId: senderId !== undefined ? senderId : existing?.senderId ?? null,
    apiUrl: apiUrl !== undefined ? apiUrl : existing?.apiUrl ?? null,
    // Only re-encrypt when a new value is actually supplied — a PUT that
    // omits apiKey/apiSecret (e.g. just flipping isEnabled) must not wipe
    // out previously-saved credentials.
    apiKeyEncrypted: typeof apiKey === "string" && apiKey ? encryptCredential(apiKey) : existing?.apiKeyEncrypted ?? null,
    apiSecretEncrypted: typeof apiSecret === "string" && apiSecret ? encryptCredential(apiSecret) : existing?.apiSecretEncrypted ?? null,
    isEnabled: isEnabled !== undefined ? !!isEnabled : existing?.isEnabled ?? false,
    updatedAt: new Date(),
  };

  const [saved] = existing
    ? await db.update(tenantSmsSettingsTable).set(values).where(eq(tenantSmsSettingsTable.tenantId, tenantId)).returning()
    : await db.insert(tenantSmsSettingsTable).values(values).returning();

  res.json({
    provider: saved!.provider, senderId: saved!.senderId, apiUrl: saved!.apiUrl,
    hasApiKey: !!saved!.apiKeyEncrypted, hasApiSecret: !!saved!.apiSecretEncrypted,
    isEnabled: saved!.isEnabled, configured: true, updatedAt: saved!.updatedAt,
  });
});

router.post("/settings/sms/test", requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.BUSINESS_OWNER), async (req, res) => {
  const { tenantId } = req.user!;
  const { phone } = req.body ?? {};
  if (typeof phone !== "string" || !phone) { res.status(400).json({ error: "phone is required" }); return; }
  const provider = await getSmsProvider(tenantId);
  const result = await provider.send({ to: phone, message: "This is a test message from your PulseNet notification settings." });
  res.status(result.success ? 200 : 502).json(result);
});

export default router;
