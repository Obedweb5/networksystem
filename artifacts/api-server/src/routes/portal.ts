import { Router, type IRouter } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { loyaltyAccountsTable, loyaltyTransactionsTable, customerOtpCodesTable, customerPortalRefreshTokensTable, customersTable, hotspotSessionsTable, provisioningMappingsTable, routersTable, servicePlansTable, stkPushRequestsTable, subscriptionsTable, walletsTable, mpesaTransactionLogsTable, voucherBatchesTable, vouchersTable } from "@workspace/db/schema";
import { normalizeMac } from "@workspace/mikrotik";
import { and, desc, eq, gt, isNull, isNotNull, sql } from "drizzle-orm";
import { optionalCustomerAuth, requireCustomerAuth, signCustomerAccessToken } from "../middlewares/customer-auth";
import { initiateStkPush, MpesaApiError, MpesaConfigError } from "../lib/mpesa";
import { resolveMpesaCredentials } from "../lib/mpesa-config";
import { queueCustomerNotification } from "../lib/notify";
import { recordAuditEvent, AUDIT_ACTIONS } from "../lib/audit-log";
import { logger } from "../lib/logger";
import { provisionSubscription, reactivateSubscription } from "../services/provisioning-engine";
import { renewOrCreateSubscription } from "../services/subscription-lifecycle";
import { voucherRedeemRateLimiter, reconnectRateLimiter, portalSignInRateLimiter, otpRequestRateLimiter, otpVerifyRateLimiter } from "../middlewares/rate-limit";

const router: IRouter = Router();
const PHONE = /^0[17]\d{8}$/;
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const CUSTOMER_REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const publicPlan = (p: typeof servicePlansTable.$inferSelect) => ({ id: p.id, name: p.name, description: p.description, price: p.price, durationDays: p.durationDays, validityHours: p.validityHours, dataLimitMb: p.dataLimitMb, speedUpKbps: p.speedUpKbps, speedDownKbps: p.speedDownKbps });
const token = (c: typeof customersTable.$inferSelect) => ({ id: c.id, tenantId: c.tenantId, phone: c.phone, accountNumber: c.accountNumber, role: "customer" as const });
const pushStatus = (p: typeof stkPushRequestsTable.$inferSelect) => ({ id: p.id, status: p.status, checkoutRequestId: p.checkoutRequestId, amount: p.amount, phone: p.phone, failureReason: p.failureReason, subscriptionId: p.subscriptionId });

/**
 * Resolves a device to the customer it belongs to, purely from purchase/
 * provisioning history — no cookie, no login. Checked in two places because
 * they're populated at different times: `hotspot_sessions` is written by
 * polling/observing router activity, while `provisioning_mappings` is
 * written synchronously the moment a payment or voucher provisions a
 * device, so a device that *just* paid may not have a sessions row yet.
 * Shared by `GET /portal/device-status` and `POST /portal/vouchers/redeem`
 * (the latter uses it to identify a returning device redeeming without a
 * phone number) so there is one MAC→customer lookup, not two.
 */
async function findCustomerByMac(tenantId: string, mac: string): Promise<typeof customersTable.$inferSelect | undefined> {
  const [session] = await db.select({ customerId: hotspotSessionsTable.customerId })
    .from(hotspotSessionsTable)
    .innerJoin(routersTable, eq(hotspotSessionsTable.routerId, routersTable.id))
    .where(and(eq(routersTable.tenantId, tenantId), eq(hotspotSessionsTable.macAddress, mac), isNotNull(hotspotSessionsTable.customerId)))
    .orderBy(desc(hotspotSessionsTable.startedAt))
    .limit(1);
  if (session?.customerId) {
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, session.customerId)).limit(1);
    if (customer) return customer;
  }
  const [mapping] = await db.select({ customerId: provisioningMappingsTable.customerId })
    .from(provisioningMappingsTable)
    .where(and(eq(provisioningMappingsTable.tenantId, tenantId), eq(provisioningMappingsTable.boundMacAddress, mac)))
    .orderBy(desc(provisioningMappingsTable.updatedAt))
    .limit(1);
  if (mapping?.customerId) {
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, mapping.customerId)).limit(1);
    if (customer) return customer;
  }
  return undefined;
}

router.get("/portal/packages", async (req, res) => {
  const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
  if (!tenantId) { res.status(400).json({ error: "tenantId is required" }); return; }
  const plans = await db.select().from(servicePlansTable).where(and(eq(servicePlansTable.tenantId, tenantId), eq(servicePlansTable.type, "HOTSPOT"), eq(servicePlansTable.isActive, true))).orderBy(servicePlansTable.price);
  res.json(plans.map(publicPlan));
});

/**
 * Tells the captive portal (login.html) whether — and why — it should show
 * itself to this device, instead of the router silently authorizing it.
 * Built entirely from existing tables (hotspot_sessions.macAddress links a
 * device to a customer; subscriptions.status/expiresAt tells us if their
 * package is still good) — no new schema.
 *
 * `graceHours` is a display-only grace window: it does not touch the
 * router-side expiry sweep (which still disables access exactly at
 * expiresAt). It only affects which reason/copy the portal shows during
 * that window — see mikrotik-hotspot/README.md for the tradeoff.
 */
router.get("/portal/device-status", async (req, res) => {
  const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
  const mac = typeof req.query.mac === "string" && req.query.mac.trim() ? req.query.mac.trim().toUpperCase() : undefined;
  const phone = typeof req.query.phone === "string" && PHONE.test(req.query.phone) ? req.query.phone : undefined;
  const graceHours = Math.max(0, Number(req.query.graceHours) || 0);
  if (!tenantId) { res.status(400).json({ error: "tenantId is required" }); return; }

  let customer: typeof customersTable.$inferSelect | undefined;
  if (mac) {
    customer = await findCustomerByMac(tenantId, mac);
  }
  // Fallback: a customer on a device we've never seen (e.g. new phone) can still
  // be recognized by the number they already pay with — this is the "unknown
  // device, verify by phone" path, and reuses the same phone lookup the
  // guest STK-push flow already does.
  if (!customer && phone) {
    [customer] = await db.select().from(customersTable).where(and(eq(customersTable.tenantId, tenantId), eq(customersTable.phone, phone))).limit(1);
  }

  if (!customer) { res.json({ reason: (mac || phone) ? "UNKNOWN_DEVICE" : "NEW", customer: false, subscription: null }); return; }
  if (!customer.isActive) { res.json({ reason: "SUSPENDED", customer: true, subscription: null }); return; }

  const [sub] = await db.select().from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.tenantId, tenantId), eq(subscriptionsTable.customerId, customer.id)))
    .orderBy(desc(subscriptionsTable.expiresAt)).limit(1);

  if (!sub) { res.json({ reason: "NEW", customer: true, subscription: null }); return; }

  const subOut = { id: sub.id, status: sub.status, expiresAt: sub.expiresAt, planId: sub.planId };
  if (sub.status === "SUSPENDED") { res.json({ reason: "SUSPENDED", customer: true, subscription: subOut }); return; }

  const graceEndsAt = sub.expiresAt.getTime() + graceHours * 3600_000;
  const expired = sub.status === "EXPIRED" || sub.status === "CANCELLED" || sub.expiresAt.getTime() < Date.now();
  if (expired && Date.now() >= graceEndsAt) { res.json({ reason: "EXPIRED", customer: true, subscription: subOut }); return; }

  // For a HOTSPOT plan, "ACTIVE" billing doesn't guarantee the *device*
  // asking is bound yet (binding is async/best-effort with its own retry).
  // Report that separately so the captive page can keep showing "activating
  // your access" instead of prematurely claiming success and telling the
  // customer to manually reconnect.
  let deviceBound: boolean | null = null;
  if (mac) {
    const [mapping] = await db.select({ ipBindingStatus: provisioningMappingsTable.ipBindingStatus, boundMacAddress: provisioningMappingsTable.boundMacAddress })
      .from(provisioningMappingsTable)
      .where(eq(provisioningMappingsTable.subscriptionId, sub.id))
      .limit(1);
    if (mapping) deviceBound = mapping.ipBindingStatus === "BOUND" && mapping.boundMacAddress === mac;
  }

  res.json({ reason: "ACTIVE", customer: true, subscription: subOut, deviceBound });
});

/**
 * Step 1 of optional customer login: request a one-time code for a phone
 * number. Knowing the number alone must never be enough to sign in (that
 * was the identifier-only account-takeover gap this replaces), so this only
 * ever queues a code for delivery — it never returns a token.
 */
router.post("/portal/auth/otp/request", otpRequestRateLimiter, async (req, res) => {
  const { tenantId, phone } = req.body ?? {};
  if (!tenantId || typeof tenantId !== "string" || typeof phone !== "string" || !PHONE.test(phone)) {
    res.status(400).json({ error: "A valid tenantId and Kenyan phone number are required" });
    return;
  }

  const [customer] = await db.select().from(customersTable).where(and(eq(customersTable.tenantId, tenantId), eq(customersTable.phone, phone))).limit(1);
  // Always return the same response whether or not the number is a known
  // customer, so this endpoint can't be used to enumerate customers by phone.
  if (customer && customer.isActive) {
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    await db.insert(customerOtpCodesTable).values({ tenantId, customerId: customer.id, codeHash, expiresAt: new Date(Date.now() + OTP_TTL_MS) });
    await queueCustomerNotification(customer, "otp_login", { code, expiryMinutes: OTP_TTL_MS / 60_000 });

    // NOTE (SMS delivery): actually delivering this code requires a real SMS
    // gateway wired into deployment secrets (see lib/notify.ts, lib/sms/,
    // and DEPLOYMENT.md) — a tenant can configure one from Settings >
    // Notifications > SMS in the admin dashboard, or fall back to the
    // deployment-wide TEXIN_* env vars. Until one is configured the code is
    // only ever logged server-side in non-production for local testing. It
    // is never returned in this response and never written to
    // notification_logs (that table is delivery-tracking only, not a place
    // to persist a live credential).
    if (process.env.NODE_ENV !== "production") {
      logger.info({ customerId: customer.id, code }, "Customer OTP generated (dev-only log; wire up an SMS gateway to deliver this)");
    }
    await recordAuditEvent({ tenantId, action: AUDIT_ACTIONS.CUSTOMER_OTP_REQUESTED, req, targetType: "customer", targetId: customer.id });
  }

  res.json({ message: "If that number is registered, a verification code has been sent." });
});

/** Step 2: exchange the code for a session. This is the only way a customer token is ever issued. */
router.post("/portal/auth/otp/verify", otpVerifyRateLimiter, async (req, res) => {
  const { tenantId, phone, code } = req.body ?? {};
  if (!tenantId || typeof tenantId !== "string" || typeof phone !== "string" || !PHONE.test(phone) || typeof code !== "string" || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "A valid tenantId, phone, and 6-digit code are required" });
    return;
  }

  const [customer] = await db.select().from(customersTable).where(and(eq(customersTable.tenantId, tenantId), eq(customersTable.phone, phone))).limit(1);
  // Same "Invalid or expired code" response whether the customer, the
  // pending code, or the code value itself is wrong — none of these should
  // be distinguishable to an attacker guessing codes for a known number.
  if (!customer || !customer.isActive) { res.status(401).json({ error: "Invalid or expired code" }); return; }

  const [otp] = await db.select().from(customerOtpCodesTable)
    .where(and(eq(customerOtpCodesTable.customerId, customer.id), isNull(customerOtpCodesTable.consumedAt), gt(customerOtpCodesTable.expiresAt, new Date())))
    .orderBy(desc(customerOtpCodesTable.createdAt)).limit(1);
  if (!otp || otp.attempts >= MAX_OTP_ATTEMPTS) { res.status(401).json({ error: "Invalid or expired code" }); return; }

  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  if (codeHash !== otp.codeHash) {
    await db.update(customerOtpCodesTable).set({ attempts: otp.attempts + 1 }).where(eq(customerOtpCodesTable.id, otp.id));
    await recordAuditEvent({ tenantId, action: AUDIT_ACTIONS.CUSTOMER_OTP_FAILED, req, targetType: "customer", targetId: customer.id });
    res.status(401).json({ error: "Invalid or expired code" });
    return;
  }

  const rawRefresh = crypto.randomBytes(40).toString("hex");
  const refreshHash = crypto.createHash("sha256").update(rawRefresh).digest("hex");
  await db.transaction(async (tx) => {
    await tx.update(customerOtpCodesTable).set({ consumedAt: new Date() }).where(eq(customerOtpCodesTable.id, otp.id));
    await tx.insert(customerPortalRefreshTokensTable).values({ customerId: customer.id, tokenHash: refreshHash, expiresAt: new Date(Date.now() + CUSTOMER_REFRESH_TOKEN_TTL_MS) });
  });

  await recordAuditEvent({ tenantId, action: AUDIT_ACTIONS.CUSTOMER_OTP_VERIFIED, req, targetType: "customer", targetId: customer.id });
  res.json({
    accessToken: signCustomerAccessToken(token(customer)),
    refreshToken: rawRefresh,
    expiresIn: 900,
    tokenType: "Bearer",
    customer: { id: customer.id, tenantId: customer.tenantId, phone: customer.phone, firstName: customer.firstName, lastName: customer.lastName, accountNumber: customer.accountNumber },
  });
});

router.post("/portal/auth/logout", requireCustomerAuth, async (req, res) => {
  const raw = req.body?.refreshToken;
  if (typeof raw === "string") {
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    await db.update(customerPortalRefreshTokensTable).set({ revokedAt: new Date() })
      .where(and(eq(customerPortalRefreshTokensTable.tokenHash, tokenHash), eq(customerPortalRefreshTokensTable.customerId, req.customer!.id)));
  }
  await recordAuditEvent({ tenantId: req.customer!.tenantId, action: AUDIT_ACTIONS.CUSTOMER_LOGOUT, req, targetType: "customer", targetId: req.customer!.id });
  res.json({ success: true });
});
router.post("/portal/auth/refresh", async (req, res) => {
  const raw = req.body?.refreshToken;
  if (typeof raw !== "string") { res.status(400).json({ error: "refreshToken is required" }); return; }
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const [record] = await db.select().from(customerPortalRefreshTokensTable).where(and(eq(customerPortalRefreshTokensTable.tokenHash, tokenHash), isNull(customerPortalRefreshTokensTable.revokedAt), gt(customerPortalRefreshTokensTable.expiresAt, new Date()))).limit(1);
  if (!record) { res.status(401).json({ error: "Invalid refresh token" }); return; }
  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, record.customerId)).limit(1);
  if (!customer || !customer.isActive) { res.status(401).json({ error: "Customer unavailable" }); return; }
  res.json({ accessToken: signCustomerAccessToken(token(customer)), expiresIn: 900, tokenType: "Bearer" });
});
router.get("/portal/me", requireCustomerAuth, async (req, res) => {
  const [customer] = await db.select().from(customersTable).where(and(eq(customersTable.id, req.customer!.id), eq(customersTable.tenantId, req.customer!.tenantId))).limit(1);
  if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
  const [[wallet], [loyalty]] = await Promise.all([db.select().from(walletsTable).where(eq(walletsTable.customerId, customer.id)).limit(1), db.select().from(loyaltyAccountsTable).where(eq(loyaltyAccountsTable.customerId, customer.id)).limit(1)]);
  res.json({ ...customer, wallet: wallet ? { balance: wallet.balance, currency: wallet.currency } : null, loyalty: loyalty ? { balance: loyalty.balance, lifetimeEarned: loyalty.lifetimeEarned } : null });
});
/** Was previously undocumented/unimplemented — only GET existed, so customer-portal's profile.tsx (useUpdatePortalMe) always failed to save. Same response shape as GET so the query cache can be updated in place. */
router.patch("/portal/me", requireCustomerAuth, async (req, res) => {
  const { firstName, lastName, email, address } = req.body ?? {};
  const patch: Partial<typeof customersTable.$inferInsert> = {};
  if (firstName !== undefined) {
    if (typeof firstName !== "string" || !firstName.trim()) { res.status(400).json({ error: "firstName cannot be empty" }); return; }
    patch.firstName = firstName.trim();
  }
  if (lastName !== undefined) {
    if (typeof lastName !== "string" || !lastName.trim()) { res.status(400).json({ error: "lastName cannot be empty" }); return; }
    patch.lastName = lastName.trim();
  }
  if (email !== undefined) {
    if (email !== null && (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) { res.status(400).json({ error: "Invalid email" }); return; }
    patch.email = email === null ? null : email.trim();
  }
  if (address !== undefined) {
    if (address !== null && typeof address !== "string") { res.status(400).json({ error: "Invalid address" }); return; }
    patch.address = address === null ? null : address.trim();
  }

  const [customer] = Object.keys(patch).length
    ? await db.update(customersTable).set(patch).where(and(eq(customersTable.id, req.customer!.id), eq(customersTable.tenantId, req.customer!.tenantId))).returning()
    : await db.select().from(customersTable).where(and(eq(customersTable.id, req.customer!.id), eq(customersTable.tenantId, req.customer!.tenantId))).limit(1);
  if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
  const [[wallet], [loyalty]] = await Promise.all([db.select().from(walletsTable).where(eq(walletsTable.customerId, customer.id)).limit(1), db.select().from(loyaltyAccountsTable).where(eq(loyaltyAccountsTable.customerId, customer.id)).limit(1)]);
  res.json({ ...customer, wallet: wallet ? { balance: wallet.balance, currency: wallet.currency } : null, loyalty: loyalty ? { balance: loyalty.balance, lifetimeEarned: loyalty.lifetimeEarned } : null });
});
router.get("/portal/dashboard", requireCustomerAuth, async (req, res) => {
  const id = req.customer!.id;
  const [[activeSession], [wallet], [loyalty], sessions] = await Promise.all([db.select().from(hotspotSessionsTable).where(and(eq(hotspotSessionsTable.customerId, id), isNull(hotspotSessionsTable.endedAt))).limit(1), db.select().from(walletsTable).where(eq(walletsTable.customerId, id)).limit(1), db.select().from(loyaltyAccountsTable).where(eq(loyaltyAccountsTable.customerId, id)).limit(1), db.select({ count: sql<number>`count(*)` }).from(hotspotSessionsTable).where(eq(hotspotSessionsTable.customerId, id))]);
  res.json({ activeSession: activeSession ?? null, wallet: wallet ? { balance: wallet.balance, currency: wallet.currency } : null, loyalty: loyalty ? { balance: loyalty.balance, lifetimeEarned: loyalty.lifetimeEarned } : null, recentSessionCount: Number(sessions[0]?.count ?? 0) });
});
router.get("/portal/sessions/current", requireCustomerAuth, async (req, res) => {
  const [session] = await db.select().from(hotspotSessionsTable).where(and(eq(hotspotSessionsTable.customerId, req.customer!.id), isNull(hotspotSessionsTable.endedAt))).limit(1);
  res.json({ session: session ? { ...session, durationSeconds: Math.max(0, Math.floor((Date.now() - session.startedAt.getTime()) / 1000)) } : null });
});
router.get("/portal/sessions/history", requireCustomerAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const rows = await db.select().from(hotspotSessionsTable).where(eq(hotspotSessionsTable.customerId, req.customer!.id)).orderBy(desc(hotspotSessionsTable.startedAt)).limit(limit);
  // `durationSeconds` isn't a stored column — it's derived the same way
  // `/portal/sessions/current` derives it, so a still-open session here
  // (endedAt null, e.g. today's session appearing in its own history) shows
  // its live elapsed time instead of silently omitting the field.
  res.json(rows.map((row) => ({
    ...row,
    durationSeconds: Math.max(0, Math.floor(((row.endedAt ?? new Date()).getTime() - row.startedAt.getTime()) / 1000)),
  })));
});
router.get("/portal/loyalty", requireCustomerAuth, async (req, res) => {
  const [account] = await db.select().from(loyaltyAccountsTable).where(eq(loyaltyAccountsTable.customerId, req.customer!.id)).limit(1);
  if (!account) { res.json({ balance: 0, lifetimeEarned: 0, transactions: [] }); return; }
  const transactions = await db.select().from(loyaltyTransactionsTable).where(eq(loyaltyTransactionsTable.loyaltyAccountId, account.id)).orderBy(desc(loyaltyTransactionsTable.createdAt)).limit(50);
  res.json({ balance: account.balance, lifetimeEarned: account.lifetimeEarned, transactions });
});
/** Was previously undocumented/unimplemented — the customer portal's loyalty.tsx has always called this. */
router.post("/portal/loyalty/redeem", requireCustomerAuth, async (req, res) => {
  const { points, description } = req.body ?? {};
  if (typeof points !== "number" || !Number.isInteger(points) || points <= 0) {
    res.status(400).json({ error: "A positive whole number of points is required" });
    return;
  }

  const [account] = await db.select().from(loyaltyAccountsTable).where(eq(loyaltyAccountsTable.customerId, req.customer!.id)).limit(1);
  if (!account || account.balance < points) {
    res.status(400).json({ error: "You don't have enough points." });
    return;
  }

  const newBalance = account.balance - points;
  const redemptionDescription = typeof description === "string" && description.trim() ? description.trim() : "Self-service redemption";
  const transaction = await db.transaction(async (tx) => {
    await tx.update(loyaltyAccountsTable).set({ balance: newBalance, updatedAt: new Date() }).where(eq(loyaltyAccountsTable.id, account.id));
    const [row] = await tx.insert(loyaltyTransactionsTable).values({
      loyaltyAccountId: account.id,
      type: "redeem",
      points: -points,
      balanceAfter: newBalance,
      description: redemptionDescription,
    }).returning();
    return row;
  });

  await recordAuditEvent({ tenantId: req.customer!.tenantId, action: AUDIT_ACTIONS.CUSTOMER_LOYALTY_REDEEMED, req, targetType: "customer", targetId: req.customer!.id });
  res.json({ success: true, newBalance, transaction });
});
router.post("/portal/payments/stk-push", optionalCustomerAuth, async (req, res) => {
  const { planId, phone, mac: rawMac } = req.body ?? {};
  if (typeof planId !== "string" || typeof phone !== "string" || !PHONE.test(phone)) { res.status(400).json({ error: "A valid planId and Kenyan M-PESA phone are required" }); return; }
  // Optional: the captive portal sends RouterOS's `$(mac)` template value so
  // a successful payment can bind this exact device — no MAC/IP binding, no
  // credentials, but everything else about checkout works the same either way.
  const mac = typeof rawMac === "string" ? normalizeMac(rawMac) : null;
  const [plan] = await db.select().from(servicePlansTable).where(and(eq(servicePlansTable.id, planId), eq(servicePlansTable.type, "HOTSPOT"), eq(servicePlansTable.isActive, true))).limit(1);
  if (!plan) { res.status(404).json({ error: "Package not found" }); return; }
  let customer: typeof customersTable.$inferSelect | undefined;
  if (req.customer) [customer] = await db.select().from(customersTable).where(and(eq(customersTable.id, req.customer.id), eq(customersTable.tenantId, plan.tenantId))).limit(1);
  if (!customer) { [customer] = await db.select().from(customersTable).where(and(eq(customersTable.tenantId, plan.tenantId), eq(customersTable.phone, phone))).limit(1); if (!customer) [customer] = await db.insert(customersTable).values({ tenantId: plan.tenantId, firstName: "Customer", lastName: phone.slice(-4), phone }).returning(); }

  // Ask Safaricom to actually push the STK prompt to the customer's phone
  // before we create the PENDING row — if Daraja rejects the request there
  // is nothing to track yet, and we can return a clear error immediately.
  const tenantMpesaCreds = await resolveMpesaCredentials(plan.tenantId);
  let stkResult: Awaited<ReturnType<typeof initiateStkPush>>;
  try {
    stkResult = await initiateStkPush({
      phone,
      amount: Number(plan.price),
      accountReference: customer.accountNumber ?? customer.phone,
      transactionDesc: plan.name,
    }, tenantMpesaCreds);
  } catch (err) {
    logger.error({ err, planId, customerId: customer.id }, "Daraja STK push initiation failed");
    await db.insert(mpesaTransactionLogsTable).values({
      tenantId: plan.tenantId, type: "STK_PUSH_RESPONSE",
      payload: { error: err instanceof Error ? err.message : String(err) },
    }).catch(() => {});
    if (err instanceof MpesaConfigError) { res.status(503).json({ error: "M-PESA is not configured on this deployment yet." }); return; }
    if (err instanceof MpesaApiError) { res.status(502).json({ error: err.message }); return; }
    res.status(502).json({ error: "Could not reach the M-PESA payment gateway. Please try again." });
    return;
  }

  const [push] = await db.insert(stkPushRequestsTable).values({
    tenantId: plan.tenantId, customerId: customer.id, planId: plan.id, phone, amount: plan.price, macAddress: mac,
    checkoutRequestId: stkResult.checkoutRequestId, merchantRequestId: stkResult.merchantRequestId,
  }).returning();

  await db.insert(mpesaTransactionLogsTable).values({
    tenantId: plan.tenantId, stkPushRequestId: push.id, type: "STK_PUSH_RESPONSE",
    checkoutRequestId: stkResult.checkoutRequestId,
    payload: { ...stkResult },
  }).catch((err) => logger.error({ err }, "Failed to log STK push response"));

  // The verified M-PESA callback, not this route, must mark payment complete.
  res.status(201).json(pushStatus(push));
});
// Safaricom confirmation codes are 10 upper-case alphanumeric characters
// (e.g. "SFC1A2B3C4") — always containing at least one letter, which is what
// lets us pick the code out of a pasted SMS without also matching the
// 10-digit phone number that also appears in that same message.
const RECEIPT_CODE = /^[A-Z0-9]{10}$/;
function extractReceiptCode(rawCode: unknown, rawMessage: unknown): string | null {
  if (typeof rawCode === "string" && rawCode.trim()) {
    const code = rawCode.trim().toUpperCase();
    return RECEIPT_CODE.test(code) ? code : null;
  }
  if (typeof rawMessage === "string" && rawMessage.trim()) {
    const tokens = rawMessage.toUpperCase().match(/[A-Z0-9]{10}/g) ?? [];
    return tokens.find((t) => /[A-Z]/.test(t)) ?? null;
  }
  return null;
}

/**
 * "Already paid?" — for a customer whose STK push actually succeeded but
 * this device never got connected automatically (they closed the tab, the
 * bind-poll timed out, they're checking out from a different device than
 * the one they want online, etc). Looks the payment up by the M-PESA
 * receipt number Daraja's callback already stored on the stk_push_requests
 * row — no new payment logic, no re-charging, just re-running device
 * binding against a payment that's already COMPLETED via
 * `reactivateSubscription`, exactly like the automatic post-payment path
 * and the manual admin "reactivate" action both already do.
 */
router.post("/portal/payments/verify", reconnectRateLimiter, async (req, res) => {
  const { tenantId, code: rawCode, message, mac: rawMac } = req.body ?? {};
  if (!tenantId || typeof tenantId !== "string") { res.status(400).json({ error: "tenantId is required" }); return; }
  const code = extractReceiptCode(rawCode, message);
  if (!code) { res.status(400).json({ error: "Enter the M-PESA transaction code, or paste the full confirmation message." }); return; }
  const mac = typeof rawMac === "string" ? normalizeMac(rawMac) : null;

  const [push] = await db.select().from(stkPushRequestsTable)
    .where(and(eq(stkPushRequestsTable.tenantId, tenantId), eq(stkPushRequestsTable.mpesaReceiptNumber, code), eq(stkPushRequestsTable.status, "COMPLETED")))
    .limit(1);
  if (!push || !push.subscriptionId) { res.status(404).json({ error: "We couldn't find a completed payment with that code. Double-check it, or contact support." }); return; }

  const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, push.subscriptionId)).limit(1);
  if (!sub || sub.status !== "ACTIVE") { res.status(409).json({ error: "That payment isn't linked to an active package. Please contact support." }); return; }

  if (mac) {
    await reactivateSubscription(sub.id, {}, mac).catch((err) => logger.error({ err, subscriptionId: sub.id }, "Device binding after manual payment verification failed"));
  }
  res.json({ subscriptionId: sub.id, status: sub.status });
});

/**
 * Self-serve voucher redemption — no staff auth, unlike POST /vouchers/redeem
 * (which is the admin-facing tool for redeeming on a customer's behalf).
 * Reuses the same code/status checks as that route, and hands off to the
 * same `renewOrCreateSubscription` + `provisionSubscription` any paid
 * checkout uses, so a redeemed voucher activates and connects a device
 * exactly like a completed M-PESA payment does.
 *
 * Deliberately code-only (no phone field in the UI): the customer is
 * resolved by device MAC via `findCustomerByMac` — the same lookup
 * `/portal/device-status` uses — so a device with purchase history redeems
 * straight onto its existing account. A device with no history yet gets a
 * placeholder customer record (phone column is NOT NULL and has no real
 * number to put there); if that same person later pays via M-PESA with
 * their real phone, that flow creates its own separate customer record —
 * support can merge the two manually if that ever needs reconciling.
 *
 * If the deployment's login.html sends a `routerId` (see ROUTER_ID in that
 * file's config block — it identifies which physical hotspot served this
 * page), a batch created with an admin-set routerId/siteId restriction can
 * only be redeemed at that hotspot/site; a batch with neither set redeems
 * anywhere, unchanged from before. Redemption details (device MAC, IP,
 * user agent, and which router it was redeemed through) are recorded on
 * the voucher row for support/audit — the admin-facing POST /vouchers/redeem
 * leaves these null since that's staff redeeming on the customer's behalf,
 * not a device self-serving.
 */
router.post("/portal/vouchers/redeem", voucherRedeemRateLimiter, async (req, res) => {
  const { tenantId, code: rawCode, mac: rawMac, routerId: rawRouterId } = req.body ?? {};
  if (!tenantId || typeof tenantId !== "string" || typeof rawCode !== "string" || !rawCode.trim()) {
    res.status(400).json({ error: "A voucher code is required" });
    return;
  }
  const code = rawCode.trim().toUpperCase();
  const mac = typeof rawMac === "string" ? normalizeMac(rawMac) : null;
  const requestedRouterId = typeof rawRouterId === "string" && rawRouterId.trim() ? rawRouterId.trim() : null;
  // Resolved once up front (rather than trusting the client-supplied id
  // outright) so a bogus/unknown routerId never reaches the `redeemedRouterId`
  // insert below, which has a real FK constraint against `routers`.
  const deviceRouter = requestedRouterId
    ? (await db.select({ id: routersTable.id, siteId: routersTable.siteId }).from(routersTable).where(eq(routersTable.id, requestedRouterId)).limit(1))[0]
    : undefined;
  const routerId = deviceRouter?.id ?? null;

  const [row] = await db.select({ voucher: vouchersTable, batch: voucherBatchesTable })
    .from(vouchersTable)
    .innerJoin(voucherBatchesTable, eq(vouchersTable.batchId, voucherBatchesTable.id))
    .where(and(eq(vouchersTable.code, code), eq(voucherBatchesTable.tenantId, tenantId)))
    .limit(1);
  if (!row) { res.status(404).json({ error: "Voucher not found" }); return; }
  if (row.voucher.status === "USED") { res.status(409).json({ error: "This voucher has already been redeemed." }); return; }
  if (row.voucher.status === "VOID") { res.status(409).json({ error: "This voucher has been voided. Please contact support." }); return; }
  const alreadyExpired = row.voucher.status === "EXPIRED" || (row.voucher.expiresAt !== null && row.voucher.expiresAt.getTime() < Date.now());
  if (alreadyExpired) {
    if (row.voucher.status !== "EXPIRED") await db.update(vouchersTable).set({ status: "EXPIRED" }).where(eq(vouchersTable.id, row.voucher.id));
    res.status(409).json({ error: "This voucher has expired." });
    return;
  }
  if (!row.batch.isActive) { res.status(409).json({ error: "This voucher is no longer active. Please contact support." }); return; }

  // Optional hotspot/site restriction: a batch scoped to a specific router
  // and/or site can only be redeemed from a device connecting through it.
  if (row.batch.routerId || row.batch.siteId) {
    const routerMismatch = row.batch.routerId && row.batch.routerId !== deviceRouter?.id;
    const siteMismatch = row.batch.siteId && row.batch.siteId !== deviceRouter?.siteId;
    if (!deviceRouter || routerMismatch || siteMismatch) {
      res.status(403).json({ error: "This voucher isn't valid at this hotspot." });
      return;
    }
  }

  const [plan] = await db.select().from(servicePlansTable).where(eq(servicePlansTable.id, row.batch.planId)).limit(1);
  if (!plan || !plan.isActive) { res.status(409).json({ error: "The package for this voucher is no longer available. Please contact support." }); return; }

  let customer = mac ? await findCustomerByMac(tenantId, mac) : undefined;
  if (!customer) {
    const placeholder = `VOUCHER-${(mac ?? code).replace(/[^A-Z0-9]/gi, "").slice(0, 20)}`;
    [customer] = await db.insert(customersTable).values({ tenantId, firstName: "Voucher", lastName: code, phone: placeholder }).returning();
  }

  const subscription = await db.transaction(async (tx) => {
    // Claim the voucher inside the same statement that checks it's still
    // UNUSED — two customers redeeming the same code at once can only ever
    // have one of them win this update. Redemption details are recorded in
    // the same statement so a claimed voucher always carries its audit trail.
    const [claimed] = await tx.update(vouchersTable)
      .set({
        status: "USED", usedByCustomerId: customer!.id, usedAt: new Date(),
        redeemedMacAddress: mac, redeemedIpAddress: req.ip ?? null,
        redeemedUserAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 500) : null,
        redeemedRouterId: routerId,
      })
      .where(and(eq(vouchersTable.id, row.voucher.id), eq(vouchersTable.status, "UNUSED")))
      .returning();
    if (!claimed) return null;
    return renewOrCreateSubscription(tx, { tenantId, customerId: customer!.id, planId: plan.id, durationDays: plan.durationDays, amountPaid: Number(row.batch.unitPrice) });
  });

  if (!subscription) { res.status(409).json({ error: "This voucher was just redeemed. Please try a different code." }); return; }

  await provisionSubscription(subscription.id, {}, mac).catch((err) => logger.error({ err, subscriptionId: subscription.id }, "Provisioning after voucher redemption failed"));

  res.status(200).json({ subscriptionId: subscription.id, status: "ACTIVE" });
});

/**
 * "Already Have an Account? Sign In" — account-number path. No password:
 * identifies an existing customer purely by account number and, if they
 * currently have valid (unexpired, non-suspended) service, reconnects this
 * device — the self-serve equivalent of the phone-based "Verify your
 * number" link, for a customer who already knows their account number and
 * wants to get back online immediately rather than just see a status
 * banner. The username/password option in this same "Sign In" section is
 * the unchanged native RouterOS login form further down this page — that
 * already reuses the existing hotspot/PPPoE authentication as-is.
 */
router.post("/portal/auth/reconnect-account", portalSignInRateLimiter, async (req, res) => {
  const { tenantId, accountNumber: rawAccountNumber, mac: rawMac } = req.body ?? {};
  if (!tenantId || typeof tenantId !== "string" || typeof rawAccountNumber !== "string" || !rawAccountNumber.trim()) {
    res.status(400).json({ error: "Your account number is required" });
    return;
  }
  const mac = typeof rawMac === "string" ? normalizeMac(rawMac) : null;

  const [customer] = await db.select().from(customersTable)
    .where(and(eq(customersTable.tenantId, tenantId), eq(customersTable.accountNumber, rawAccountNumber.trim())))
    .limit(1);
  // Generic message either way — confirming "no such account" to an
  // unauthenticated caller would let someone enumerate valid account numbers.
  const notFoundMessage = "We couldn't find an active account with that number. Double-check it, or contact support.";
  if (!customer) { res.status(404).json({ error: notFoundMessage }); return; }
  if (!customer.isActive) { res.status(403).json({ error: "Your account is suspended. Please contact support." }); return; }

  const [subscription] = await db.select().from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.tenantId, tenantId), eq(subscriptionsTable.customerId, customer.id), eq(subscriptionsTable.status, "ACTIVE")))
    .orderBy(desc(subscriptionsTable.expiresAt)).limit(1);
  if (!subscription || subscription.expiresAt.getTime() < Date.now()) { res.status(404).json({ error: notFoundMessage }); return; }

  if (mac) {
    await reactivateSubscription(subscription.id, {}, mac).catch((err) => logger.error({ err, subscriptionId: subscription.id }, "Device binding after account-number sign-in failed"));
  }
  res.json({ subscriptionId: subscription.id, status: subscription.status });
});


router.get("/portal/payments/stk-push/:id", async (req, res) => {
  const [push] = await db.select().from(stkPushRequestsTable).where(eq(stkPushRequestsTable.id, req.params.id)).limit(1);
  if (!push) { res.status(404).json({ error: "Payment request not found" }); return; }

  let deviceBound: boolean | null = null;
  if (push.status === "COMPLETED" && push.subscriptionId && push.macAddress) {
    const [mapping] = await db.select({ ipBindingStatus: provisioningMappingsTable.ipBindingStatus, boundMacAddress: provisioningMappingsTable.boundMacAddress })
      .from(provisioningMappingsTable)
      .where(eq(provisioningMappingsTable.subscriptionId, push.subscriptionId))
      .limit(1);
    if (mapping) deviceBound = mapping.ipBindingStatus === "BOUND" && mapping.boundMacAddress === push.macAddress;
  }

  res.json({ ...pushStatus(push), deviceBound });
});
export default router;
