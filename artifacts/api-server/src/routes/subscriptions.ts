import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { subscriptionsTable, servicePlansTable, customersTable, provisioningMappingsTable, subscriptionStatusHistoryTable, routersTable } from "@workspace/db/schema";
import { eq, and, sql, desc, count, inArray } from "drizzle-orm";
import {
  ListSubscriptionsQueryParams, CreateSubscriptionBody,
  GetSubscriptionParams, UpdateSubscriptionParams, UpdateSubscriptionBody,
} from "@workspace/api-zod";
import { requireAuth, requireRole } from "../middlewares/auth";
import {
  provisionSubscription, suspendSubscription, reactivateSubscription,
  deprovisionSubscription, reprovisionSubscription, resetSubscriberPassword, bulkAction,
} from "../services/provisioning-engine";

const router: IRouter = Router();

// Roles allowed to trigger provisioning-affecting actions (network access
// changes are more consequential than ordinary CRUD, so resellers — who can
// otherwise manage customers/billing — are excluded from these).
const PROVISIONING_ROLES = ["SUPER_ADMIN", "BUSINESS_OWNER", "STAFF", "TECHNICIAN"];

router.get("/subscriptions", requireAuth, async (req, res) => {
  const parse = ListSubscriptionsQueryParams.safeParse(req.query);
  if (!parse.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const { tenantId } = req.user!;
  const { page, limit, customerId, status } = parse.data;
  const offset = (page - 1) * limit;
  const conditions = [eq(subscriptionsTable.tenantId, tenantId)];
  if (customerId) conditions.push(eq(subscriptionsTable.customerId, customerId));
  if (status) conditions.push(eq(subscriptionsTable.status, status));
  const [rows, [{ total }]] = await Promise.all([
    db.select({
      sub: subscriptionsTable,
      planName: servicePlansTable.name,
      planType: servicePlansTable.type,
      customerName: sql<string>`${customersTable.firstName} || ' ' || ${customersTable.lastName}`,
      routerName: routersTable.name,
    }).from(subscriptionsTable)
      .leftJoin(servicePlansTable, eq(subscriptionsTable.planId, servicePlansTable.id))
      .leftJoin(customersTable, eq(subscriptionsTable.customerId, customersTable.id))
      .leftJoin(routersTable, eq(subscriptionsTable.routerId, routersTable.id))
      .where(and(...conditions)).orderBy(desc(subscriptionsTable.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(subscriptionsTable).where(and(...conditions)),
  ]);
  res.json({ data: rows.map(r => ({ ...r.sub, planName: r.planName, planType: r.planType, customerName: r.customerName, routerName: r.routerName })), total: Number(total), page, limit });
});

router.post("/subscriptions", requireAuth, async (req, res) => {
  const parse = CreateSubscriptionBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Validation failed", details: parse.error.issues }); return; }
  // routerId isn't in the generated OpenAPI body yet — accept it as an
  // optional hand-validated extra field (see PROJECT_GUIDE.md precedent for
  // fields ahead of the generated client). Omitted, the provisioning engine
  // resolves a router automatically from the customer's site.
  const routerIdParse = z.string().uuid().optional().safeParse(req.body?.routerId);
  if (!routerIdParse.success) { res.status(400).json({ error: "routerId must be a valid UUID if provided" }); return; }

  const { tenantId } = req.user!;
  const [plan] = await db.select().from(servicePlansTable).where(and(eq(servicePlansTable.id, parse.data.planId), eq(servicePlansTable.tenantId, tenantId))).limit(1);
  if (!plan) { res.status(400).json({ error: "Plan not found" }); return; }
  const [customer] = await db.select().from(customersTable).where(and(eq(customersTable.id, parse.data.customerId), eq(customersTable.tenantId, tenantId))).limit(1);
  if (!customer) { res.status(400).json({ error: "Customer not found" }); return; }

  const startsAt = parse.data.startsAt;
  const expiresAt = new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
  const [sub] = await db.insert(subscriptionsTable).values({
    tenantId, customerId: parse.data.customerId, planId: parse.data.planId,
    routerId: routerIdParse.data, startsAt, expiresAt, autoRenew: parse.data.autoRenew ?? false,
  }).returning();

  // Best-effort, synchronous provisioning attempt so the common case (router
  // reachable) returns an already-connected subscriber. A failure here is
  // not a request failure — the retry sweep in provisioning-engine.ts picks
  // it up automatically, exactly like every other provisioning failure path.
  let provisioning: { success: boolean; error?: string } = { success: false };
  try {
    provisioning = await provisionSubscription(sub.id, { userId: req.user!.id });
  } catch (err) {
    provisioning = { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  res.status(201).json({ ...sub, provisioning });
});

router.get("/subscriptions/:id", requireAuth, async (req, res) => {
  const parse = GetSubscriptionParams.safeParse(req.params);
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { tenantId } = req.user!;
  const [row] = await db.select({
    sub: subscriptionsTable,
    planName: servicePlansTable.name,
    planType: servicePlansTable.type,
    customerName: sql<string>`${customersTable.firstName} || ' ' || ${customersTable.lastName}`,
    routerName: routersTable.name,
  }).from(subscriptionsTable)
    .leftJoin(servicePlansTable, eq(subscriptionsTable.planId, servicePlansTable.id))
    .leftJoin(customersTable, eq(subscriptionsTable.customerId, customersTable.id))
    .leftJoin(routersTable, eq(subscriptionsTable.routerId, routersTable.id))
    .where(and(eq(subscriptionsTable.id, parse.data.id), eq(subscriptionsTable.tenantId, tenantId))).limit(1);
  if (!row) { res.status(404).json({ error: "Subscription not found" }); return; }
  res.json({ ...row.sub, planName: row.planName, planType: row.planType, customerName: row.customerName, routerName: row.routerName });
});

router.patch("/subscriptions/:id", requireAuth, async (req, res) => {
  const paramParse = UpdateSubscriptionParams.safeParse(req.params);
  const bodyParse = UpdateSubscriptionBody.safeParse(req.body);
  if (!paramParse.success || !bodyParse.success) { res.status(400).json({ error: "Validation failed" }); return; }
  const { tenantId } = req.user!;

  const [existing] = await db.select().from(subscriptionsTable).where(and(eq(subscriptionsTable.id, paramParse.data.id), eq(subscriptionsTable.tenantId, tenantId))).limit(1);
  if (!existing) { res.status(404).json({ error: "Subscription not found" }); return; }

  // A status change here must actually change network access, not just the
  // database row — route it through the engine instead of a raw update.
  // (autoRenew-only updates skip the engine entirely; nothing to provision.)
  if (bodyParse.data.status && bodyParse.data.status !== existing.status) {
    if (!PROVISIONING_ROLES.some((r) => req.user!.roles.includes(r))) { res.status(403).json({ error: "Forbidden: insufficient role to change subscription status" }); return; }
    const target = bodyParse.data.status;
    const outcome = target === "ACTIVE"
      ? await reactivateSubscription(existing.id, { userId: req.user!.id })
      : target === "CANCELLED"
        ? await deprovisionSubscription(existing.id, "Status changed via admin update", { userId: req.user!.id })
        : await suspendSubscription(existing.id, "Status changed via admin update", target === "EXPIRED" ? "EXPIRED" : "SUSPENDED", { userId: req.user!.id });
    if (!outcome.success) { res.status(502).json({ error: `Status updated in billing but the router action failed: ${outcome.error}`, errorCode: outcome.errorCode }); return; }
  }

  if (bodyParse.data.autoRenew !== undefined) {
    await db.update(subscriptionsTable).set({ autoRenew: bodyParse.data.autoRenew, updatedAt: new Date() }).where(eq(subscriptionsTable.id, existing.id));
  }

  const [updated] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, existing.id)).limit(1);
  res.json(updated);
});

// --- Provisioning lifecycle actions -----------------------------------

router.post("/subscriptions/:id/provision", requireAuth, requireRole(...PROVISIONING_ROLES), async (req, res) => {
  const sub = await requireOwnedSubscription(req, res);
  if (!sub) return;
  const outcome = await provisionSubscription(sub.id, { userId: req.user!.id });
  res.status(outcome.success ? 200 : 502).json(outcome);
});

router.post("/subscriptions/:id/suspend", requireAuth, requireRole(...PROVISIONING_ROLES), async (req, res) => {
  const sub = await requireOwnedSubscription(req, res);
  if (!sub) return;
  const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : "Suspended by staff";
  const outcome = await suspendSubscription(sub.id, reason, "SUSPENDED", { userId: req.user!.id });
  res.status(outcome.success ? 200 : 502).json(outcome);
});

router.post("/subscriptions/:id/reactivate", requireAuth, requireRole(...PROVISIONING_ROLES), async (req, res) => {
  const sub = await requireOwnedSubscription(req, res);
  if (!sub) return;
  const outcome = await reactivateSubscription(sub.id, { userId: req.user!.id });
  res.status(outcome.success ? 200 : 502).json(outcome);
});

router.post("/subscriptions/:id/cancel", requireAuth, requireRole(...PROVISIONING_ROLES), async (req, res) => {
  const sub = await requireOwnedSubscription(req, res);
  if (!sub) return;
  const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : "Cancelled by staff";
  const outcome = await deprovisionSubscription(sub.id, reason, { userId: req.user!.id });
  res.status(outcome.success ? 200 : 502).json(outcome);
});

const ReprovisionBody = z.object({ newPlanId: z.string().uuid().optional(), newRouterId: z.string().uuid().optional() });

router.post("/subscriptions/:id/reprovision", requireAuth, requireRole(...PROVISIONING_ROLES), async (req, res) => {
  const sub = await requireOwnedSubscription(req, res);
  if (!sub) return;
  const bodyParse = ReprovisionBody.safeParse(req.body ?? {});
  if (!bodyParse.success) { res.status(400).json({ error: "newPlanId/newRouterId must be valid UUIDs if provided" }); return; }
  if (!bodyParse.data.newPlanId && !bodyParse.data.newRouterId) { res.status(400).json({ error: "Provide newPlanId and/or newRouterId" }); return; }
  const outcome = await reprovisionSubscription(sub.id, bodyParse.data, { userId: req.user!.id });
  res.status(outcome.success ? 200 : 502).json(outcome);
});

router.post("/subscriptions/:id/reset-password", requireAuth, requireRole(...PROVISIONING_ROLES), async (req, res) => {
  const sub = await requireOwnedSubscription(req, res);
  if (!sub) return;
  const outcome = await resetSubscriberPassword(sub.id, { userId: req.user!.id });
  // The plaintext password is returned exactly once, here, for staff to hand
  // to the customer — it is never stored in plaintext or logged anywhere.
  res.status(outcome.success ? 200 : 502).json(outcome);
});

router.get("/subscriptions/:id/provisioning", requireAuth, async (req, res) => {
  const sub = await requireOwnedSubscription(req, res);
  if (!sub) return;
  const [mapping] = await db.select().from(provisioningMappingsTable).where(eq(provisioningMappingsTable.subscriptionId, sub.id)).limit(1);
  const history = await db.select().from(subscriptionStatusHistoryTable).where(eq(subscriptionStatusHistoryTable.subscriptionId, sub.id)).orderBy(desc(subscriptionStatusHistoryTable.createdAt)).limit(50);
  // pppoePasswordEncrypted is intentionally never included in this response.
  res.json({
    mapping: mapping ? { ...mapping, pppoePasswordEncrypted: undefined } : null,
    history,
  });
});

const BulkActionBody = z.object({
  subscriptionIds: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["provision", "suspend", "reactivate", "deprovision"]),
  reason: z.string().optional(),
});

router.post("/subscriptions/bulk-action", requireAuth, requireRole(...PROVISIONING_ROLES), async (req, res) => {
  const parse = BulkActionBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Validation failed", details: parse.error.issues }); return; }
  const { tenantId } = req.user!;

  // Scope to this tenant's own subscriptions before touching anything —
  // a bulk action must never be able to reach across tenants.
  const owned = await db.select({ id: subscriptionsTable.id }).from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.tenantId, tenantId), inArray(subscriptionsTable.id, parse.data.subscriptionIds)));
  const ownedIds = new Set(owned.map((o) => o.id));
  const skipped = parse.data.subscriptionIds.filter((id) => !ownedIds.has(id));

  const results = await bulkAction(parse.data.subscriptionIds.filter((id) => ownedIds.has(id)), parse.data.action, parse.data.reason, { userId: req.user!.id });
  res.json({
    results,
    skipped: skipped.map((id) => ({ subscriptionId: id, reason: "Not found in this tenant" })),
    summary: { total: parse.data.subscriptionIds.length, succeeded: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length + skipped.length },
  });
});

/** Loads a subscription scoped to the caller's tenant, or sends 404 and returns undefined. */
async function requireOwnedSubscription(req: Request, res: Response) {
  const parse = GetSubscriptionParams.safeParse(req.params);
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return undefined; }
  const { tenantId } = req.user!;
  const [sub] = await db.select().from(subscriptionsTable).where(and(eq(subscriptionsTable.id, parse.data.id), eq(subscriptionsTable.tenantId, tenantId))).limit(1);
  if (!sub) { res.status(404).json({ error: "Subscription not found" }); return undefined; }
  return sub;
}

export default router;
