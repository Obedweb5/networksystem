import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  routersTable, routerHealthSnapshotsTable, nocIncidentsTable, nocIncidentEventsTable,
  nocRecommendationsTable, nocRecommendationStatusEnum, nocCapacityForecastsTable, nocSettingsTable,
  subscriptionsTable, customersTable, invoicesTable, provisioningAuditLogsTable,
} from "@workspace/db/schema";
import { MikroTikClient } from "@workspace/mikrotik";
import { requireAuth, requireRole } from "../middlewares/auth";
import { getNocSettings } from "../services/noc-settings";
import { executeRecommendation, rejectRecommendation, findOrphanSessions } from "../services/noc-actions";
import { generateIncidentReport } from "../services/noc-analysis";
import { subscribe } from "../services/noc-sse";
import { isNocLlmConfigured } from "../services/noc-llm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Infra-facing actions (acknowledge/resolve/approve/reject/settings) use the
// same role set as sessions.ts's session-disconnect route and
// subscriptions.ts's provisioning actions — resellers manage subscriptions/
// billing, not physical network operations.
const NOC_OPERATOR_ROLES = ["SUPER_ADMIN", "BUSINESS_OWNER", "STAFF", "TECHNICIAN"] as const;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

router.get("/noc/overview", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;

  const routers = await db.select().from(routersTable).where(eq(routersTable.tenantId, tenantId));
  const routerIds = routers.map((r) => r.id);

  let statusCounts = { ONLINE: 0, DEGRADED: 0, OFFLINE: 0 };
  let pppoeTotal = 0;
  let hotspotTotal = 0;
  if (routerIds.length > 0) {
    const latestPerRouter = await db.execute(sql`
      select distinct on (router_id) router_id, status, pppoe_active_count, hotspot_active_count
      from router_health_snapshots
      where tenant_id = ${tenantId}
      order by router_id, captured_at desc
    `);
    for (const row of latestPerRouter.rows as Array<Record<string, unknown>>) {
      const status = row.status as "ONLINE" | "DEGRADED" | "OFFLINE";
      if (status in statusCounts) statusCounts[status] += 1;
      pppoeTotal += Number(row.pppoe_active_count ?? 0);
      hotspotTotal += Number(row.hotspot_active_count ?? 0);
    }
  }

  const [openIncidents] = await db.select({ n: count() }).from(nocIncidentsTable).where(and(eq(nocIncidentsTable.tenantId, tenantId), sql`${nocIncidentsTable.status} in ('OPEN','ACKNOWLEDGED')`));
  const [criticalIncidents] = await db.select({ n: count() }).from(nocIncidentsTable).where(and(eq(nocIncidentsTable.tenantId, tenantId), sql`${nocIncidentsTable.status} in ('OPEN','ACKNOWLEDGED')`, eq(nocIncidentsTable.severity, "CRITICAL")));
  const [pendingRecs] = await db.select({ n: count() }).from(nocRecommendationsTable).where(and(eq(nocRecommendationsTable.tenantId, tenantId), eq(nocRecommendationsTable.status, "PENDING")));

  const since30d = new Date(Date.now() - 30 * 86_400_000);
  const [subStats] = await db.select({
    active: sql<string>`count(*) filter (where ${subscriptionsTable.status} = 'ACTIVE')`,
    suspended: sql<string>`count(*) filter (where ${subscriptionsTable.status} = 'SUSPENDED')`,
    overdue: sql<string>`count(*) filter (where ${subscriptionsTable.status} = 'OVERDUE')`,
    expired: sql<string>`count(*) filter (where ${subscriptionsTable.status} = 'EXPIRED')`,
  }).from(subscriptionsTable).where(eq(subscriptionsTable.tenantId, tenantId));

  const [invoiceStats] = await db.select({
    paid: sql<string>`count(*) filter (where ${invoicesTable.status} = 'PAID' and ${invoicesTable.createdAt} >= ${since30d})`,
    failed: sql<string>`count(*) filter (where (${invoicesTable.status} = 'VOID' or (${invoicesTable.status} = 'PENDING' and ${invoicesTable.dueAt} < now())) and ${invoicesTable.createdAt} >= ${since30d})`,
  }).from(invoicesTable).where(eq(invoicesTable.tenantId, tenantId));

  const since1h = new Date(Date.now() - 3_600_000);
  const [provisioningStats] = await db.select({
    succeeded: sql<string>`count(*) filter (where ${provisioningAuditLogsTable.status} = 'SUCCESS')`,
    failed: sql<string>`count(*) filter (where ${provisioningAuditLogsTable.status} = 'FAILED')`,
  }).from(provisioningAuditLogsTable).where(and(eq(provisioningAuditLogsTable.tenantId, tenantId), gte(provisioningAuditLogsTable.executedAt, since1h)));

  res.json({
    routers: { total: routers.length, online: statusCounts.ONLINE, degraded: statusCounts.DEGRADED, offline: statusCounts.OFFLINE },
    sessions: { pppoeActive: pppoeTotal, hotspotActive: hotspotTotal },
    incidents: { open: Number(openIncidents?.n ?? 0), critical: Number(criticalIncidents?.n ?? 0) },
    recommendations: { pending: Number(pendingRecs?.n ?? 0) },
    subscriptions: { active: Number(subStats?.active ?? 0), suspended: Number(subStats?.suspended ?? 0), overdue: Number(subStats?.overdue ?? 0), expired: Number(subStats?.expired ?? 0) },
    payments: { paidLast30d: Number(invoiceStats?.paid ?? 0), failedLast30d: Number(invoiceStats?.failed ?? 0) },
    provisioning: { succeededLastHour: Number(provisioningStats?.succeeded ?? 0), failedLastHour: Number(provisioningStats?.failed ?? 0) },
    llmNarrativeAvailable: isNocLlmConfigured(),
  });
});

// ---------------------------------------------------------------------------
// Routers (latest snapshot per router)
// ---------------------------------------------------------------------------

router.get("/noc/routers", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const routers = await db.select().from(routersTable).where(eq(routersTable.tenantId, tenantId)).orderBy(routersTable.name);
  if (routers.length === 0) { res.json({ routers: [] }); return; }

  const latest = await db.execute(sql`
    select distinct on (router_id) router_id, status, captured_at, cpu_load_percent, memory_used_percent,
           uptime_seconds, pppoe_active_count, hotspot_active_count, rx_bps, tx_bps, error_message
    from router_health_snapshots
    where tenant_id = ${tenantId}
    order by router_id, captured_at desc
  `);
  const byRouter = new Map((latest.rows as Array<Record<string, unknown>>).map((r) => [r.router_id as string, r]));

  res.json({
    routers: routers.map((r) => {
      const snap = byRouter.get(r.id);
      return {
        id: r.id, name: r.name, ipAddress: r.ipAddress, siteId: r.siteId, isActive: r.isActive,
        status: snap?.status ?? "OFFLINE",
        lastSeenAt: snap?.captured_at ?? null,
        cpuLoadPercent: snap ? Number(snap.cpu_load_percent) : null,
        memoryUsedPercent: snap ? Number(snap.memory_used_percent) : null,
        uptimeSeconds: snap ? Number(snap.uptime_seconds) : null,
        pppoeActiveCount: snap ? Number(snap.pppoe_active_count) : null,
        hotspotActiveCount: snap ? Number(snap.hotspot_active_count) : null,
        rxBps: snap?.rx_bps != null ? Number(snap.rx_bps) : null,
        txBps: snap?.tx_bps != null ? Number(snap.tx_bps) : null,
        errorMessage: snap?.error_message ?? null,
      };
    }),
  });
});

const HistoryQuery = z.object({ hours: z.coerce.number().min(1).max(24 * 30).default(24) });

router.get("/noc/routers/:id/history", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const parse = HistoryQuery.safeParse(req.query);
  if (!parse.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const [r] = await db.select().from(routersTable).where(and(eq(routersTable.id, req.params.id), eq(routersTable.tenantId, tenantId))).limit(1);
  if (!r) { res.status(404).json({ error: "Router not found" }); return; }

  const since = new Date(Date.now() - parse.data.hours * 3_600_000);
  const rows = await db.select().from(routerHealthSnapshotsTable)
    .where(and(eq(routerHealthSnapshotsTable.routerId, r.id), gte(routerHealthSnapshotsTable.capturedAt, since)))
    .orderBy(routerHealthSnapshotsTable.capturedAt);
  res.json({ router: { id: r.id, name: r.name }, snapshots: rows });
});

// ---------------------------------------------------------------------------
// Cross-router log aggregation (Network > Logs view)
// ---------------------------------------------------------------------------

router.get("/noc/logs", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const routers = await db.select().from(routersTable).where(and(eq(routersTable.tenantId, tenantId), eq(routersTable.isActive, true)));

  const results = await Promise.allSettled(routers.map(async (r) => {
    const client = new MikroTikClient({ id: r.id, tenantId: r.tenantId, name: r.name, ipAddress: r.ipAddress, apiPort: r.apiPort ?? 8728, apiUsername: r.apiUsername, apiSecret: r.apiSecret });
    try {
      const connectResult = await client.connect();
      if (!connectResult.success) return [];
      const logRes = await client.run("/log", "print", {});
      const rows = Array.isArray(logRes.data) ? logRes.data : logRes.data ? [logRes.data] : [];
      return (rows as Array<Record<string, unknown>>).slice(-20).map((l) => ({ routerId: r.id, routerName: r.name, time: l.time, topics: l.topics, message: l.message }));
    } finally {
      await client.disconnect().catch(() => {});
    }
  }));

  const logs = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  res.json({ logs: logs.slice(-200) });
});

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

const ListIncidentsQuery = z.object({ status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "AUTO_RESOLVED", "ALL"]).optional() });

router.get("/noc/incidents", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const parse = ListIncidentsQuery.safeParse(req.query);
  if (!parse.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const conditions = [eq(nocIncidentsTable.tenantId, tenantId)];
  if (!parse.data.status || parse.data.status === "ALL") {
    // default: everything from the last 30 days so a busy tenant's history stays bounded
    conditions.push(gte(nocIncidentsTable.openedAt, new Date(Date.now() - 30 * 86_400_000)));
  } else {
    conditions.push(eq(nocIncidentsTable.status, parse.data.status));
  }
  const rows = await db.select().from(nocIncidentsTable).where(and(...conditions)).orderBy(desc(nocIncidentsTable.openedAt)).limit(200);
  res.json({ incidents: rows });
});

router.get("/noc/incidents/:id", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const [incident] = await db.select().from(nocIncidentsTable).where(and(eq(nocIncidentsTable.id, req.params.id), eq(nocIncidentsTable.tenantId, tenantId))).limit(1);
  if (!incident) { res.status(404).json({ error: "Incident not found" }); return; }
  const [events, recommendations] = await Promise.all([
    db.select().from(nocIncidentEventsTable).where(eq(nocIncidentEventsTable.incidentId, incident.id)).orderBy(nocIncidentEventsTable.createdAt),
    db.select().from(nocRecommendationsTable).where(eq(nocRecommendationsTable.incidentId, incident.id)).orderBy(nocRecommendationsTable.createdAt),
  ]);
  res.json({ incident, events, recommendations });
});

router.post("/noc/incidents/:id/acknowledge", requireAuth, requireRole(...NOC_OPERATOR_ROLES), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const [incident] = await db.select().from(nocIncidentsTable).where(and(eq(nocIncidentsTable.id, req.params.id), eq(nocIncidentsTable.tenantId, tenantId))).limit(1);
  if (!incident) { res.status(404).json({ error: "Incident not found" }); return; }
  if (incident.status !== "OPEN") { res.status(409).json({ error: `Incident is already ${incident.status}` }); return; }
  await db.update(nocIncidentsTable).set({ status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedBy: userId, updatedAt: new Date() }).where(eq(nocIncidentsTable.id, incident.id));
  await db.insert(nocIncidentEventsTable).values({ tenantId, incidentId: incident.id, kind: "ACKNOWLEDGED", message: "Acknowledged by staff.", actorUserId: userId, actorLabel: undefined });
  res.json({ success: true });
});

const ResolveBody = z.object({ note: z.string().max(2000).optional() });

router.post("/noc/incidents/:id/resolve", requireAuth, requireRole(...NOC_OPERATOR_ROLES), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const parse = ResolveBody.safeParse(req.body ?? {});
  if (!parse.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const [incident] = await db.select().from(nocIncidentsTable).where(and(eq(nocIncidentsTable.id, req.params.id), eq(nocIncidentsTable.tenantId, tenantId))).limit(1);
  if (!incident) { res.status(404).json({ error: "Incident not found" }); return; }
  if (incident.status === "RESOLVED" || incident.status === "AUTO_RESOLVED") { res.status(409).json({ error: "Incident is already resolved" }); return; }
  await db.update(nocIncidentsTable).set({ status: "RESOLVED", resolvedAt: new Date(), resolvedBy: userId, autoResolved: false, updatedAt: new Date() }).where(eq(nocIncidentsTable.id, incident.id));
  await db.insert(nocIncidentEventsTable).values({ tenantId, incidentId: incident.id, kind: "RESOLVED", message: parse.data.note || "Resolved by staff.", actorUserId: userId });
  res.json({ success: true });
});

router.get("/noc/incidents/:id/report", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const report = await generateIncidentReport(req.params.id, tenantId);
  if (!report) { res.status(404).json({ error: "Incident not found" }); return; }
  res.json(report);
});

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

const ListRecsQuery = z.object({ status: z.enum(nocRecommendationStatusEnum.enumValues).optional() });

router.get("/noc/recommendations", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const parse = ListRecsQuery.safeParse(req.query);
  if (!parse.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const conditions = [eq(nocRecommendationsTable.tenantId, tenantId)];
  if (parse.data.status) conditions.push(eq(nocRecommendationsTable.status, parse.data.status));
  const rows = await db.select().from(nocRecommendationsTable).where(and(...conditions)).orderBy(desc(nocRecommendationsTable.createdAt)).limit(200);
  res.json({ recommendations: rows });
});

router.post("/noc/recommendations/:id/approve", requireAuth, requireRole(...NOC_OPERATOR_ROLES), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const result = await executeRecommendation(req.params.id, tenantId, { userId });
  if (!result.success) { res.status(422).json({ error: result.error }); return; }
  res.json({ success: true, result });
});

router.post("/noc/recommendations/:id/reject", requireAuth, requireRole(...NOC_OPERATOR_ROLES), async (req, res) => {
  const { tenantId, id: userId } = req.user!;
  const result = await rejectRecommendation(req.params.id, tenantId, userId);
  if (!result.success) { res.status(422).json({ error: result.error }); return; }
  res.json({ success: true });
});

router.get("/noc/routers/:id/orphan-sessions", requireAuth, requireRole(...NOC_OPERATOR_ROLES), async (req, res) => {
  const { tenantId } = req.user!;
  const [r] = await db.select().from(routersTable).where(and(eq(routersTable.id, req.params.id), eq(routersTable.tenantId, tenantId))).limit(1);
  if (!r) { res.status(404).json({ error: "Router not found" }); return; }
  const orphans = await findOrphanSessions(r.id).catch((err) => { logger.error({ err }, "findOrphanSessions failed"); return []; });
  res.json({ orphans });
});

// ---------------------------------------------------------------------------
// Capacity forecasts
// ---------------------------------------------------------------------------

router.get("/noc/forecasts", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const rows = await db.execute(sql`
    select distinct on (router_id, metric) *
    from noc_capacity_forecasts
    where tenant_id = ${tenantId}
    order by router_id, metric, generated_at desc
  `);
  res.json({ forecasts: rows.rows });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.get("/noc/settings", requireAuth, async (req, res) => {
  const settings = await getNocSettings(req.user!.tenantId);
  res.json({ settings });
});

const UpdateSettingsBody = z.object({
  autoRemediationEnabled: z.boolean().optional(),
  llmNarrativeEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().min(15).max(3600).optional(),
  analysisIntervalSeconds: z.number().int().min(30).max(3600).optional(),
  snapshotRetentionDays: z.number().int().min(7).max(730).optional(),
});

router.put("/noc/settings", requireAuth, requireRole("SUPER_ADMIN", "BUSINESS_OWNER"), async (req, res) => {
  const parse = UpdateSettingsBody.safeParse(req.body ?? {});
  if (!parse.success) { res.status(400).json({ error: "Invalid body", details: parse.error.flatten() }); return; }
  const { tenantId } = req.user!;
  const current = await getNocSettings(tenantId);
  const [updated] = await db.insert(nocSettingsTable).values({ tenantId, ...current, ...parse.data, updatedAt: new Date() })
    .onConflictDoUpdate({ target: nocSettingsTable.tenantId, set: { ...parse.data, updatedAt: new Date() } })
    .returning();
  res.json({ settings: updated });
});

// ---------------------------------------------------------------------------
// Real-time stream
// ---------------------------------------------------------------------------

router.get("/noc/stream", requireAuth, (req, res) => {
  const { tenantId } = req.user!;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`event: connected\ndata: {}\n\n`);
  const unsubscribe = subscribe(tenantId, res);
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000);
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); res.end(); });
});

export default router;
