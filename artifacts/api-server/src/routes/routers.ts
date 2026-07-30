import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { routersTable, routerAlertsTable, hotspotSessionsTable, customersTable } from "@workspace/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import {
  ListRoutersQueryParams, CreateRouterBody, GetRouterParams,
  UpdateRouterParams, UpdateRouterBody, DeleteRouterParams,
  GetRouterAlertsParams, GetRouterAlertsQueryParams, ResolveRouterAlertParams,
  GetHotspotSessionsParams, GetHotspotSessionsQueryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { MikroTikClient } from "@workspace/mikrotik";

const router: IRouter = Router();

router.get("/routers", requireAuth, async (req, res) => {
  const parse = ListRoutersQueryParams.safeParse(req.query);
  if (!parse.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const { tenantId } = req.user!;
  const conditions = [eq(routersTable.tenantId, tenantId)];
  if (parse.data.isActive !== undefined) conditions.push(eq(routersTable.isActive, parse.data.isActive));
  const data = await db.select().from(routersTable).where(and(...conditions)).orderBy(desc(routersTable.createdAt));
  res.json(data);
});

router.post("/routers", requireAuth, async (req, res) => {
  const parse = CreateRouterBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Validation failed", details: parse.error.issues }); return; }
  const { tenantId } = req.user!;
  const [r] = await db.insert(routersTable).values({ tenantId, ...parse.data, apiPort: parse.data.apiPort ?? 8728 }).returning();
  res.status(201).json(r);
});

router.get("/routers/:id", requireAuth, async (req, res) => {
  const parse = GetRouterParams.safeParse(req.params);
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { tenantId } = req.user!;
  const [r] = await db.select().from(routersTable).where(and(eq(routersTable.id, parse.data.id), eq(routersTable.tenantId, tenantId))).limit(1);
  if (!r) { res.status(404).json({ error: "Router not found" }); return; }
  res.json(r);
});

router.patch("/routers/:id", requireAuth, async (req, res) => {
  const paramParse = UpdateRouterParams.safeParse(req.params);
  const bodyParse = UpdateRouterBody.safeParse(req.body);
  if (!paramParse.success || !bodyParse.success) { res.status(400).json({ error: "Validation failed" }); return; }
  const { tenantId } = req.user!;
  const [updated] = await db.update(routersTable).set({ ...bodyParse.data, updatedAt: new Date() })
    .where(and(eq(routersTable.id, paramParse.data.id), eq(routersTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Router not found" }); return; }
  res.json(updated);
});

router.delete("/routers/:id", requireAuth, async (req, res) => {
  const parse = DeleteRouterParams.safeParse(req.params);
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { tenantId } = req.user!;
  const [updated] = await db.update(routersTable).set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(routersTable.id, parse.data.id), eq(routersTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Router not found" }); return; }
  res.json({ success: true });
});

// Test live MikroTik connectivity and return router stats
router.post("/routers/:id/test", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const [r] = await db.select().from(routersTable)
    .where(and(eq(routersTable.id, String(req.params.id)), eq(routersTable.tenantId, tenantId))).limit(1);
  if (!r) { res.status(404).json({ error: "Router not found" }); return; }

  const client = new MikroTikClient({
    id: r.id, name: r.name, tenantId,
    ipAddress: r.ipAddress, apiPort: r.apiPort ?? 8728,
    apiUsername: r.apiUsername, apiSecret: r.apiSecret,
  });

  try {
    const connectResult = await client.connect();
    if (!connectResult.success) {
      res.json({ reachable: false, error: connectResult.error ?? connectResult.message });
      return;
    }

    const [identityRes, resourceRes] = await Promise.all([
      client.run("/system/identity", "print", {}),
      client.run("/system/resource", "print", {}),
    ]);

    const identity = identityRes.success ? (identityRes.data as any[])?.[0] : null;
    const resource = resourceRes.success ? (resourceRes.data as any[])?.[0] : null;

    res.json({
      reachable: true,
      identity: identity?.name ?? r.name,
      version: resource?.version ?? null,
      uptime: resource?.uptime ?? null,
      cpuLoad: resource?.["cpu-load"] ?? null,
      freeMemory: resource?.["free-memory"] ?? null,
      totalMemory: resource?.["total-memory"] ?? null,
      boardName: resource?.["board-name"] ?? null,
    });
  } catch (err) {
    res.json({ reachable: false, error: String(err) });
  } finally {
    await client.disconnect().catch(() => {});
  }
});

// List active PPPoE sessions from MikroTik router
router.get("/routers/:id/pppoe-sessions", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const [r] = await db.select().from(routersTable)
    .where(and(eq(routersTable.id, String(req.params.id)), eq(routersTable.tenantId, tenantId))).limit(1);
  if (!r) { res.status(404).json({ error: "Router not found" }); return; }

  const client = new MikroTikClient({
    id: r.id, name: r.name, tenantId,
    ipAddress: r.ipAddress, apiPort: r.apiPort ?? 8728,
    apiUsername: r.apiUsername, apiSecret: r.apiSecret,
  });

  try {
    const connectResult = await client.connect();
    if (!connectResult.success) {
      res.json({ reachable: false, sessions: [], error: connectResult.error });
      return;
    }

    const sessionsRes = await client.run("/ppp/active", "print", {});
    const sessions = sessionsRes.success ? (sessionsRes.data as any[]) ?? [] : [];

    res.json({
      reachable: true,
      sessions: sessions.map((s: any) => ({
        id: s[".id"],
        name: s.name,
        service: s.service,
        callerIp: s["caller-id"] ?? null,
        address: s.address ?? null,
        uptime: s.uptime ?? null,
        encodingType: s.encoding ?? null,
      })),
    });
  } catch (err) {
    res.json({ reachable: false, sessions: [], error: String(err) });
  } finally {
    await client.disconnect().catch(() => {});
  }
});

// Disconnect a PPPoE session by name
router.post("/routers/:id/pppoe-sessions/:name/disconnect", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const [r] = await db.select().from(routersTable)
    .where(and(eq(routersTable.id, String(req.params.id)), eq(routersTable.tenantId, tenantId))).limit(1);
  if (!r) { res.status(404).json({ error: "Router not found" }); return; }

  const client = new MikroTikClient({
    id: r.id, name: r.name, tenantId,
    ipAddress: r.ipAddress, apiPort: r.apiPort ?? 8728,
    apiUsername: r.apiUsername, apiSecret: r.apiSecret,
  });

  try {
    const connectResult = await client.connect();
    if (!connectResult.success) {
      res.status(503).json({ error: "Cannot connect to router" });
      return;
    }
    // Find the active session ID by name
    const sessionsRes = await client.run("/ppp/active", "print", {});
    const sessions = sessionsRes.success ? (sessionsRes.data as any[]) ?? [] : [];
    const session = sessions.find((s: any) => s.name === req.params.name);
    if (!session) {
      res.status(404).json({ error: "PPPoE session not found" });
      return;
    }
    // Disconnect the session
    await client.run("/ppp/active", "remove", { ".id": session[".id"] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    await client.disconnect().catch(() => {});
  }
});

// Full monitor snapshot: resource stats + PPPoE count + hotspot count + interfaces + logs
router.get("/routers/:id/monitor", requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const [r] = await db.select().from(routersTable)
    .where(and(eq(routersTable.id, String(req.params.id)), eq(routersTable.tenantId, tenantId))).limit(1);
  if (!r) { res.status(404).json({ error: "Router not found" }); return; }

  const client = new MikroTikClient({
    id: r.id, name: r.name, tenantId,
    ipAddress: r.ipAddress, apiPort: r.apiPort ?? 8728,
    apiUsername: r.apiUsername, apiSecret: r.apiSecret,
  });

  try {
    const connectResult = await client.connect();
    if (!connectResult.success) {
      res.json({ reachable: false, routerName: r.name, error: connectResult.error ?? connectResult.message });
      return;
    }

    const [resourceRes, pppoeRes, ifaceRes, logRes, hotspotRes] = await Promise.allSettled([
      client.run("/system/resource", "print", {}),
      client.run("/ppp/active", "print", {}),
      client.run("/interface", "print", {}),
      client.run("/log", "print", { "count": "20" }),
      client.run("/ip/hotspot/active", "print", {}),
    ]);

    const resource = resourceRes.status === "fulfilled" && resourceRes.value.success
      ? (resourceRes.value.data as any[])?.[0] : null;
    const pppoeList = pppoeRes.status === "fulfilled" && pppoeRes.value.success
      ? (pppoeRes.value.data as any[]) ?? [] : [];
    const ifaceList = ifaceRes.status === "fulfilled" && ifaceRes.value.success
      ? (ifaceRes.value.data as any[]) ?? [] : [];
    const logList = logRes.status === "fulfilled" && logRes.value.success
      ? (logRes.value.data as any[]) ?? [] : [];
    const hotspotList = hotspotRes.status === "fulfilled" && hotspotRes.value.success
      ? (hotspotRes.value.data as any[]) ?? [] : [];

    res.json({
      reachable: true,
      routerName: r.name,
      ipAddress: r.ipAddress,
      identity: resource?.["board-name"] ?? r.name,
      boardName: resource?.["board-name"] ?? null,
      version: resource?.version ?? null,
      uptime: resource?.uptime ?? null,
      cpuLoad: resource?.["cpu-load"] ?? null,
      freeMemory: resource?.["free-memory"] ? Number(resource["free-memory"]) : null,
      totalMemory: resource?.["total-memory"] ? Number(resource["total-memory"]) : null,
      architecture: resource?.["architecture-name"] ?? null,
      pppoeCount: pppoeList.length,
      hotspotCount: hotspotList.length,
      connectedClients: pppoeList.length + hotspotList.length,
      interfaces: ifaceList.map((i: any) => ({
        name: i.name,
        type: i.type,
        running: i.running === "true" || i.running === true,
        disabled: i.disabled === "true" || i.disabled === true,
        rxBytes: i["rx-byte"] ? Number(i["rx-byte"]) : 0,
        txBytes: i["tx-byte"] ? Number(i["tx-byte"]) : 0,
        rxPackets: i["rx-packet"] ? Number(i["rx-packet"]) : 0,
        txPackets: i["tx-packet"] ? Number(i["tx-packet"]) : 0,
      })),
      logs: logList.slice(0, 20).map((l: any) => ({
        time: l.time ?? null,
        topics: l.topics ?? null,
        message: l.message ?? null,
      })),
    });
  } catch (err) {
    res.json({ reachable: false, routerName: r.name, error: String(err) });
  } finally {
    await client.disconnect().catch(() => {});
  }
});

router.get("/routers/:id/alerts", requireAuth, async (req, res) => {
  const paramParse = GetRouterAlertsParams.safeParse(req.params);
  const queryParse = GetRouterAlertsQueryParams.safeParse(req.query);
  if (!paramParse.success || !queryParse.success) { res.status(400).json({ error: "Invalid request" }); return; }
  const conditions = [eq(routerAlertsTable.routerId, paramParse.data.id)];
  if (queryParse.data.isResolved !== undefined) conditions.push(eq(routerAlertsTable.isResolved, queryParse.data.isResolved));
  const alerts = await db.select().from(routerAlertsTable).where(and(...conditions)).orderBy(desc(routerAlertsTable.createdAt));
  res.json(alerts);
});

router.post("/routers/:id/alerts/:alertId/resolve", requireAuth, async (req, res) => {
  const parse = ResolveRouterAlertParams.safeParse({ id: req.params.id, alertId: req.params.alertId });
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [updated] = await db.update(routerAlertsTable).set({ isResolved: true, resolvedAt: new Date() }).where(eq(routerAlertsTable.id, parse.data.alertId)).returning();
  if (!updated) { res.status(404).json({ error: "Alert not found" }); return; }
  res.json(updated);
});

router.get("/routers/:id/sessions", requireAuth, async (req, res) => {
  const paramParse = GetHotspotSessionsParams.safeParse(req.params);
  const queryParse = GetHotspotSessionsQueryParams.safeParse(req.query);
  if (!paramParse.success || !queryParse.success) { res.status(400).json({ error: "Invalid request" }); return; }
  const conditions = [eq(hotspotSessionsTable.routerId, paramParse.data.id)];
  if (queryParse.data.active) conditions.push(sql`${hotspotSessionsTable.endedAt} IS NULL`);
  const rows = await db.select({
    session: hotspotSessionsTable,
    customerName: sql<string | null>`${customersTable.firstName} || ' ' || ${customersTable.lastName}`,
  }).from(hotspotSessionsTable)
    .leftJoin(customersTable, eq(hotspotSessionsTable.customerId, customersTable.id))
    .where(and(...conditions)).orderBy(desc(hotspotSessionsTable.startedAt));
  res.json(rows.map(r => ({ ...r.session, customerName: r.customerName })));
});

export default router;
