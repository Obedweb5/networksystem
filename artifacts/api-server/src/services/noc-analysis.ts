import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  routersTable, routerHealthSnapshotsTable, routerAlertsTable,
  nocIncidentsTable, nocIncidentEventsTable, nocRecommendationsTable, nocCapacityForecastsTable,
  provisioningMappingsTable, provisioningAuditLogsTable, subscriptionsTable, servicePlansTable,
  stkPushRequestsTable,
  type Router, type NocIncident,
} from "@workspace/db/schema";
import type { RouterMetricsResult } from "@workspace/mikrotik";
import { logger } from "../lib/logger";
import { broadcast } from "./noc-sse";
import { narrate } from "./noc-llm";
import { getNocSettings } from "./noc-settings";
import { riskLevelFor, type RouterStatus, type NocActionType } from "./noc-shared";

export type { RouterStatus };

type IncidentCategory = typeof nocIncidentsTable.$inferInsert.category;
type IncidentSeverity = typeof nocIncidentsTable.$inferInsert.severity;

const SEVERITY_RANK: Record<IncidentSeverity, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };

// ---------------------------------------------------------------------------
// Flap detection (in-memory — see collector's runtimeState for why this
// pattern is fine for a single-process deployment)
// ---------------------------------------------------------------------------
const FLAP_WINDOW_MS = 15 * 60_000;
const FLAP_THRESHOLD = 4;
const flapHistory = new Map<string, number[]>();

// ---------------------------------------------------------------------------
// Incident + event primitives
// ---------------------------------------------------------------------------

async function findOpenIncident(tenantId: string, category: IncidentCategory, routerId: string | null): Promise<NocIncident | undefined> {
  const conditions = [
    eq(nocIncidentsTable.tenantId, tenantId),
    eq(nocIncidentsTable.category, category),
    sql`${nocIncidentsTable.status} in ('OPEN', 'ACKNOWLEDGED')`,
  ];
  conditions.push(routerId ? eq(nocIncidentsTable.routerId, routerId) : isNull(nocIncidentsTable.routerId));
  const [row] = await db.select().from(nocIncidentsTable).where(and(...conditions)).orderBy(desc(nocIncidentsTable.openedAt)).limit(1);
  return row;
}

async function addEvent(tenantId: string, incidentId: string, kind: typeof nocIncidentEventsTable.$inferInsert.kind, message: string, opts?: { actorLabel?: string; actorUserId?: string; metadata?: Record<string, unknown> }): Promise<void> {
  await db.insert(nocIncidentEventsTable).values({
    tenantId, incidentId, kind, message,
    actorLabel: opts?.actorLabel ?? "AI NOC", actorUserId: opts?.actorUserId, metadata: opts?.metadata,
  }).catch((err) => logger.error({ err, incidentId }, "Failed to record NOC incident event"));
}

interface OpenIncidentInput {
  tenantId: string;
  routerId: string | null;
  siteId: string | null;
  category: IncidentCategory;
  severity: IncidentSeverity;
  title: string;
  detectionSummary: string;
  customersImpactedCount: number;
  signalSnapshot: Record<string, unknown>;
}

/** Idempotent: refreshes and returns the already-open incident for this tenant+category+router if one exists (bumping severity if it got worse), otherwise opens a new one. This is what stops every analysis tick from spawning a fresh duplicate incident for a condition that simply hasn't cleared yet. */
async function openOrRefreshIncident(input: OpenIncidentInput): Promise<{ row: NocIncident; isNew: boolean }> {
  const existing = await findOpenIncident(input.tenantId, input.category, input.routerId);
  if (existing) {
    const escalated = SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity];
    const [updated] = await db.update(nocIncidentsTable).set({
      severity: escalated ? input.severity : existing.severity,
      detectionSummary: input.detectionSummary,
      customersImpactedCount: input.customersImpactedCount,
      signalSnapshot: input.signalSnapshot,
      updatedAt: new Date(),
    }).where(eq(nocIncidentsTable.id, existing.id)).returning();
    await addEvent(input.tenantId, existing.id, escalated ? "SEVERITY_CHANGED" : "SIGNAL_ADDED", escalated ? `Severity raised to ${input.severity}: ${input.detectionSummary}` : input.detectionSummary);
    broadcast(input.tenantId, { type: "incident.updated", data: { incidentId: existing.id, category: input.category, severity: updated?.severity ?? input.severity } });
    return { row: updated ?? existing, isNew: false };
  }

  const [row] = await db.insert(nocIncidentsTable).values({
    tenantId: input.tenantId, routerId: input.routerId, siteId: input.siteId,
    category: input.category, severity: input.severity, title: input.title,
    detectionSummary: input.detectionSummary, customersImpactedCount: input.customersImpactedCount,
    signalSnapshot: input.signalSnapshot,
  }).returning();
  await addEvent(input.tenantId, row.id, "DETECTED", input.detectionSummary);
  broadcast(input.tenantId, { type: "incident.opened", data: { incidentId: row.id, category: input.category, severity: input.severity, title: input.title } });
  return { row, isNew: true };
}

async function resolveCategoryForRouter(router: Router, category: IncidentCategory, autoResolved: boolean, note: string): Promise<void> {
  const existing = await findOpenIncident(router.tenantId, category, router.id);
  if (!existing) return;
  await db.update(nocIncidentsTable).set({ status: autoResolved ? "AUTO_RESOLVED" : "RESOLVED", resolvedAt: new Date(), autoResolved, updatedAt: new Date() }).where(eq(nocIncidentsTable.id, existing.id));
  await addEvent(router.tenantId, existing.id, "RESOLVED", note);
  broadcast(router.tenantId, { type: "incident.resolved", data: { incidentId: existing.id, category } });
}

async function countImpactedCustomers(routerId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(provisioningMappingsTable)
    .where(and(eq(provisioningMappingsTable.routerId, routerId), eq(provisioningMappingsTable.status, "SUCCESS")));
  return Number(row?.n ?? 0);
}

async function maybeNarrate(tenantId: string, task: string, context: Record<string, unknown>): Promise<string | null> {
  const settings = await getNocSettings(tenantId);
  if (!settings.llmNarrativeEnabled) return null;
  return narrate({ task, context });
}

interface CreateRecommendationInput {
  tenantId: string;
  incidentId?: string;
  routerId?: string;
  subscriptionId?: string;
  title: string;
  rationale: string;
  actionType: NocActionType;
  actionParams?: Record<string, unknown>;
  confidence?: number;
}

async function createRecommendation(input: CreateRecommendationInput): Promise<void> {
  const risk = riskLevelFor(input.actionType);
  const [row] = await db.insert(nocRecommendationsTable).values({
    tenantId: input.tenantId, incidentId: input.incidentId, routerId: input.routerId, subscriptionId: input.subscriptionId,
    title: input.title, rationale: input.rationale, actionType: input.actionType, actionParams: input.actionParams,
    riskLevel: risk, confidence: input.confidence ?? 65,
  }).returning();
  if (input.incidentId) await addEvent(input.tenantId, input.incidentId, "RECOMMENDATION_GENERATED", `${input.title} (${risk === "SAFE" ? "safe to run automatically — will execute now if auto-remediation is enabled for this tenant, otherwise awaiting a staff click" : risk === "INFO_ONLY" ? "informational" : "awaiting approval"})`);
  broadcast(input.tenantId, { type: "recommendation.created", data: { recommendationId: row.id, title: input.title, riskLevel: risk, actionType: input.actionType } });
}

// ---------------------------------------------------------------------------
// Router status transition handling (fault detection + outage correlation)
// — this is the entrypoint the collector calls on every ONLINE/DEGRADED/
// OFFLINE change it observes.
// ---------------------------------------------------------------------------

export async function handleRouterTransition(router: Router, previousStatus: RouterStatus, newStatus: RouterStatus, metrics: RouterMetricsResult): Promise<void> {
  const now = Date.now();
  const recent = [...(flapHistory.get(router.id) ?? []), now].filter((t) => now - t <= FLAP_WINDOW_MS);
  flapHistory.set(router.id, recent);

  if (recent.length >= FLAP_THRESHOLD) {
    await handleFlapping(router, newStatus, recent.length);
    return; // suppress the plain offline/recovery handling below while actively flapping — one incident, not a storm of them
  }

  if (newStatus === "OFFLINE") {
    await handleOffline(router, metrics).catch((err) => logger.error({ err, routerId: router.id }, "handleOffline failed"));
  } else if (previousStatus === "OFFLINE") {
    await resolveCategoryForRouter(router, "ROUTER_OFFLINE", true, `${router.name} is responding again.`);
    await resolveCategoryForRouter(router, "SITE_OUTAGE", true, `${router.name} is responding again.`);
  }

  if (newStatus === "DEGRADED") {
    await handleDegraded(router, metrics).catch((err) => logger.error({ err, routerId: router.id }, "handleDegraded failed"));
  } else if (previousStatus === "DEGRADED" && newStatus === "ONLINE") {
    await resolveCategoryForRouter(router, "RESOURCE_EXHAUSTION", true, `${router.name}'s CPU/memory load is back to normal.`);
  }
}

async function countOfflineSiblings(router: Router): Promise<number> {
  if (!router.siteId) return 0;
  const siblings = await db.select().from(routersTable).where(and(eq(routersTable.siteId, router.siteId), eq(routersTable.isActive, true)));
  let offline = 0;
  for (const s of siblings) {
    if (s.id === router.id) continue;
    const [latest] = await db.select({ status: routerHealthSnapshotsTable.status }).from(routerHealthSnapshotsTable)
      .where(eq(routerHealthSnapshotsTable.routerId, s.id)).orderBy(desc(routerHealthSnapshotsTable.capturedAt)).limit(1);
    if (latest?.status === "OFFLINE") offline += 1;
  }
  return offline;
}

async function recentRouterAlerts(routerId: string): Promise<Array<{ severity: string; message: string }>> {
  const rows = await db.select({ severity: routerAlertsTable.severity, message: routerAlertsTable.message })
    .from(routerAlertsTable).where(and(eq(routerAlertsTable.routerId, routerId), eq(routerAlertsTable.isResolved, false)))
    .orderBy(desc(routerAlertsTable.createdAt)).limit(5);
  return rows;
}

async function recentProvisioningFailureCount(routerId: string): Promise<number> {
  const since = new Date(Date.now() - 30 * 60_000);
  const [row] = await db.select({ n: count() }).from(provisioningAuditLogsTable)
    .where(and(eq(provisioningAuditLogsTable.routerId, routerId), eq(provisioningAuditLogsTable.status, "FAILED"), gte(provisioningAuditLogsTable.executedAt, since)));
  return Number(row?.n ?? 0);
}

async function handleOffline(router: Router, metrics: RouterMetricsResult): Promise<void> {
  const siblingsOffline = await countOfflineSiblings(router);
  const isSiteOutage = siblingsOffline >= 1;
  const category: IncidentCategory = isSiteOutage ? "SITE_OUTAGE" : "ROUTER_OFFLINE";
  const [impacted, alerts, recentFailures] = await Promise.all([
    countImpactedCustomers(router.id),
    recentRouterAlerts(router.id),
    recentProvisioningFailureCount(router.id),
  ]);

  const detectionSummary = isSiteOutage
    ? `${router.name} went offline, and ${siblingsOffline} other router(s) at the same site are also currently unreachable — this points to a shared-site cause (power, uplink, or backhaul) rather than a fault on this device alone. ${impacted} customer(s) are provisioned on ${router.name}.`
    : `${router.name} (${router.ipAddress}) stopped responding to the RouterOS API.${metrics.error ? ` Last error: ${metrics.error}.` : ""} ${impacted} customer(s) are currently provisioned on this router.${recentFailures > 0 ? ` ${recentFailures} provisioning attempt(s) on this router also failed in the last 30 minutes.` : ""}`;

  const signalSnapshot = { reachableError: metrics.error ?? null, siblingsOffline, unresolvedAlerts: alerts, recentProvisioningFailures: recentFailures, cpuLoadPercent: metrics.cpuLoadPercent, memoryUsedPercent: metrics.memoryUsedPercent };

  const { row: incident, isNew } = await openOrRefreshIncident({
    tenantId: router.tenantId, routerId: router.id, siteId: router.siteId, category, severity: "CRITICAL",
    title: isSiteOutage ? `Site outage: ${router.name} + ${siblingsOffline} other router(s) down` : `${router.name} is unreachable`,
    detectionSummary, customersImpactedCount: impacted, signalSnapshot,
  });

  if (!isNew) return; // already tracking this outage — don't re-narrate/re-recommend every tick

  const narrative = await maybeNarrate(router.tenantId, "A MikroTik access router has gone offline. Explain the most likely root cause(s) in priority order and what it means for affected customers.", signalSnapshot);
  if (narrative) await db.update(nocIncidentsTable).set({ rootCauseNarrative: narrative }).where(eq(nocIncidentsTable.id, incident.id));

  await createRecommendation({
    tenantId: router.tenantId, incidentId: incident.id, routerId: router.id,
    title: "Restart monitoring for this router",
    rationale: "Clears the collector's polling backoff and forces an immediate reconnect attempt, so the NOC notices the moment this router is reachable again instead of waiting out the current backoff window. Does not change anything on the router or any customer's account.",
    actionType: "RESTART_MONITORING", actionParams: { routerId: router.id }, confidence: 90,
  });
}

async function handleDegraded(router: Router, metrics: RouterMetricsResult): Promise<void> {
  const impacted = await countImpactedCustomers(router.id);
  const detectionSummary = `${router.name} is reachable but under resource pressure: CPU ${metrics.cpuLoadPercent ?? "?"}%, memory ${metrics.memoryUsedPercent ?? "?"}% used. ${impacted} customer(s) are provisioned on this router and may see degraded performance.`;
  const { row: incident, isNew } = await openOrRefreshIncident({
    tenantId: router.tenantId, routerId: router.id, siteId: router.siteId, category: "RESOURCE_EXHAUSTION", severity: "WARN",
    title: `${router.name} is under resource pressure`, detectionSummary, customersImpactedCount: impacted,
    signalSnapshot: { cpuLoadPercent: metrics.cpuLoadPercent, memoryUsedPercent: metrics.memoryUsedPercent, pppoeActiveCount: metrics.pppoeActiveCount, hotspotActiveCount: metrics.hotspotActiveCount },
  });
  if (!isNew) return;
  const narrative = await maybeNarrate(router.tenantId, "A MikroTik router's CPU or memory usage is sustained above 90%. Explain plausible causes an ISP technician should check.", { cpuLoadPercent: metrics.cpuLoadPercent, memoryUsedPercent: metrics.memoryUsedPercent, pppoeActiveCount: metrics.pppoeActiveCount, hotspotActiveCount: metrics.hotspotActiveCount });
  if (narrative) await db.update(nocIncidentsTable).set({ rootCauseNarrative: narrative }).where(eq(nocIncidentsTable.id, incident.id));
  await createRecommendation({
    tenantId: router.tenantId, incidentId: incident.id, routerId: router.id,
    title: "Investigate sustained high load", rationale: "No router-level action here is unambiguously safe to automate — high CPU/memory can be caused by a legitimate traffic surge, a misbehaving client, or a config/firmware issue, and needs a technician's judgment.",
    actionType: "NONE_INFO_ONLY", confidence: 55,
  });
}

async function handleFlapping(router: Router, currentStatus: RouterStatus, flapCount: number): Promise<void> {
  const impacted = await countImpactedCustomers(router.id);
  const detectionSummary = `${router.name} has changed reachability state ${flapCount} times in the last 15 minutes (currently ${currentStatus}). This pattern usually points to an intermittent link, a marginal power supply, or a routing/DHCP flap rather than a clean hard failure. ${impacted} customer(s) are provisioned on this router.`;
  const { row: incident, isNew } = await openOrRefreshIncident({
    tenantId: router.tenantId, routerId: router.id, siteId: router.siteId, category: "ROUTER_FLAPPING", severity: "CRITICAL",
    title: `${router.name} is flapping`, detectionSummary, customersImpactedCount: impacted, signalSnapshot: { flapCount, currentStatus },
  });
  if (!isNew) return;
  const narrative = await maybeNarrate(router.tenantId, "A MikroTik router is repeatedly going online and offline within a short window (flapping). Explain likely causes and diagnostic steps.", { flapCount, currentStatus });
  if (narrative) await db.update(nocIncidentsTable).set({ rootCauseNarrative: narrative }).where(eq(nocIncidentsTable.id, incident.id));
}

/** Called from the periodic sweep: a flapping incident only auto-resolves once the router has gone quiet (no transitions) for a full flap window — there may be no *new* transition to trigger that check otherwise. */
async function resolveStaleFlappingIncidents(): Promise<void> {
  const now = Date.now();
  const openFlapping = await db.select().from(nocIncidentsTable).where(and(eq(nocIncidentsTable.category, "ROUTER_FLAPPING"), sql`${nocIncidentsTable.status} in ('OPEN', 'ACKNOWLEDGED')`));
  for (const incident of openFlapping) {
    if (!incident.routerId) continue;
    const history = flapHistory.get(incident.routerId) ?? [];
    const stillFlapping = history.filter((t) => now - t <= FLAP_WINDOW_MS).length >= FLAP_THRESHOLD;
    if (stillFlapping) continue;
    const [router] = await db.select().from(routersTable).where(eq(routersTable.id, incident.routerId)).limit(1);
    if (router) await resolveCategoryForRouter(router, "ROUTER_FLAPPING", true, `${router.name} has been stable for ${Math.round(FLAP_WINDOW_MS / 60_000)} minutes.`);
  }
}

// ---------------------------------------------------------------------------
// Statistical anomaly detection (session count + bandwidth vs. rolling baseline)
// ---------------------------------------------------------------------------

const ANOMALY_BASELINE_DAYS = 14;
const ANOMALY_MIN_SAMPLES = 30;
const ANOMALY_Z_THRESHOLD = 3;

async function runAnomalyScan(router: Router): Promise<void> {
  const since = new Date(Date.now() - ANOMALY_BASELINE_DAYS * 86_400_000);
  const [stats] = await db.select({
    n: count(),
    pppoeAvg: sql<string>`avg(${routerHealthSnapshotsTable.pppoeActiveCount})`,
    pppoeStddev: sql<string>`stddev_pop(${routerHealthSnapshotsTable.pppoeActiveCount})`,
    hotspotAvg: sql<string>`avg(${routerHealthSnapshotsTable.hotspotActiveCount})`,
    hotspotStddev: sql<string>`stddev_pop(${routerHealthSnapshotsTable.hotspotActiveCount})`,
    bwAvg: sql<string>`avg(coalesce(${routerHealthSnapshotsTable.rxBps},0)::numeric + coalesce(${routerHealthSnapshotsTable.txBps},0)::numeric)`,
    bwStddev: sql<string>`stddev_pop(coalesce(${routerHealthSnapshotsTable.rxBps},0)::numeric + coalesce(${routerHealthSnapshotsTable.txBps},0)::numeric)`,
  }).from(routerHealthSnapshotsTable).where(and(eq(routerHealthSnapshotsTable.routerId, router.id), eq(routerHealthSnapshotsTable.status, "ONLINE"), gte(routerHealthSnapshotsTable.capturedAt, since)));

  if (!stats || Number(stats.n) < ANOMALY_MIN_SAMPLES) return; // not enough history to have an honest baseline yet

  const [latest] = await db.select().from(routerHealthSnapshotsTable)
    .where(and(eq(routerHealthSnapshotsTable.routerId, router.id), eq(routerHealthSnapshotsTable.status, "ONLINE")))
    .orderBy(desc(routerHealthSnapshotsTable.capturedAt)).limit(1);
  if (!latest) return;

  const bwValue = Number(latest.rxBps ?? 0) + Number(latest.txBps ?? 0);
  const checks: Array<{ label: string; value: number | null; avg: string | null; stddev: string | null; category: IncidentCategory }> = [
    { label: "PPPoE session count", value: latest.pppoeActiveCount, avg: stats.pppoeAvg, stddev: stats.pppoeStddev, category: "SESSION_ANOMALY" },
    { label: "Hotspot session count", value: latest.hotspotActiveCount, avg: stats.hotspotAvg, stddev: stats.hotspotStddev, category: "SESSION_ANOMALY" },
    { label: "Combined bandwidth", value: bwValue, avg: stats.bwAvg, stddev: stats.bwStddev, category: "BANDWIDTH_ANOMALY" },
  ];

  for (const c of checks) {
    if (c.value == null || c.avg == null || c.stddev == null) continue;
    const avgN = Number(c.avg);
    const stddevN = Number(c.stddev);
    if (!Number.isFinite(avgN) || !Number.isFinite(stddevN) || stddevN < 1e-6) continue;
    const z = (c.value - avgN) / stddevN;
    if (Math.abs(z) < ANOMALY_Z_THRESHOLD) continue;

    const direction = z > 0 ? "spiked well above" : "dropped well below";
    const impacted = await countImpactedCustomers(router.id);
    const detectionSummary = `${c.label} on ${router.name} has ${direction} its ${ANOMALY_BASELINE_DAYS}-day normal range: currently ${c.value.toFixed(0)}, vs a baseline of ${avgN.toFixed(1)} ± ${stddevN.toFixed(1)} (z-score ${z.toFixed(1)}, based on ${stats.n} samples).`;
    const { row: incident, isNew } = await openOrRefreshIncident({
      tenantId: router.tenantId, routerId: router.id, siteId: router.siteId, category: c.category, severity: "WARN",
      title: `${c.label} anomaly on ${router.name}`, detectionSummary, customersImpactedCount: impacted,
      signalSnapshot: { metric: c.label, value: c.value, baselineAvg: avgN, baselineStddev: stddevN, zScore: z, sampleCount: Number(stats.n) },
    });
    if (isNew) {
      const narrative = await maybeNarrate(router.tenantId, `A statistical anomaly was detected in ${c.label.toLowerCase()} on an ISP access router (z-score ${z.toFixed(1)} vs its own ${ANOMALY_BASELINE_DAYS}-day baseline). Explain plausible operational causes.`, { metric: c.label, value: c.value, baselineAvg: avgN, baselineStddev: stddevN, zScore: z });
      if (narrative) await db.update(nocIncidentsTable).set({ rootCauseNarrative: narrative }).where(eq(nocIncidentsTable.id, incident.id));
    }
  }
}

// ---------------------------------------------------------------------------
// Congestion detection: observed peak vs. sold/provisioned capacity
// ---------------------------------------------------------------------------

async function soldCapacityKbps(routerId: string): Promise<number> {
  const [row] = await db.select({
    kbps: sql<string>`coalesce(sum(coalesce(${servicePlansTable.speedDownKbps},0) + coalesce(${servicePlansTable.speedUpKbps},0)), 0)`,
  }).from(provisioningMappingsTable)
    .innerJoin(subscriptionsTable, eq(provisioningMappingsTable.subscriptionId, subscriptionsTable.id))
    .innerJoin(servicePlansTable, eq(subscriptionsTable.planId, servicePlansTable.id))
    .where(and(eq(provisioningMappingsTable.routerId, routerId), eq(provisioningMappingsTable.status, "SUCCESS"), eq(subscriptionsTable.status, "ACTIVE")));
  return Number(row?.kbps ?? 0);
}

const CONGESTION_THRESHOLD_PERCENT = 85;

async function runCongestionScan(router: Router): Promise<number> {
  const sold = await soldCapacityKbps(router.id);
  if (sold <= 0) return sold; // nothing sold here yet — no meaningful denominator, and nothing to forecast against

  const since = new Date(Date.now() - 24 * 3600_000);
  const [peak] = await db.select({
    peakBps: sql<string>`max(coalesce(${routerHealthSnapshotsTable.rxBps},0)::numeric + coalesce(${routerHealthSnapshotsTable.txBps},0)::numeric)`,
  }).from(routerHealthSnapshotsTable).where(and(eq(routerHealthSnapshotsTable.routerId, router.id), gte(routerHealthSnapshotsTable.capturedAt, since)));

  const peakKbps = Number(peak?.peakBps ?? 0) / 1000;
  const utilization = (peakKbps / sold) * 100;
  if (utilization < CONGESTION_THRESHOLD_PERCENT) return sold;

  const impacted = await countImpactedCustomers(router.id);
  const detectionSummary = `Peak observed throughput on ${router.name} in the last 24h was ${(peakKbps / 1000).toFixed(1)} Mbps against ${(sold / 1000).toFixed(1)} Mbps currently sold across active subscriptions on this router (${utilization.toFixed(0)}% of sold capacity).`;
  const { row: incident, isNew } = await openOrRefreshIncident({
    tenantId: router.tenantId, routerId: router.id, siteId: router.siteId, category: "CONGESTION_RISK",
    severity: utilization >= 100 ? "CRITICAL" : "WARN",
    title: `${router.name} is at ${utilization.toFixed(0)}% of sold capacity`,
    detectionSummary, customersImpactedCount: impacted, signalSnapshot: { soldKbps: sold, peakKbps, utilization },
  });
  if (isNew) {
    await createRecommendation({
      tenantId: router.tenantId, incidentId: incident.id, routerId: router.id,
      title: "Review capacity for this router",
      rationale: `Observed peak traffic is at or above ${CONGESTION_THRESHOLD_PERCENT}% of the bandwidth currently sold on this router. New signups or existing customers' peak-hour speeds may degrade if this trend continues — consider a capacity upgrade, traffic shaping review, or pausing new signups routed here.`,
      actionType: "NONE_INFO_ONLY", confidence: 70,
    });
  }
  return sold;
}

// ---------------------------------------------------------------------------
// Capacity forecasting — least-squares trend on trailing daily peaks.
// Deliberately simple and explainable rather than a black-box model: an ISP
// operator can sanity-check "peak has grown ~1.2 points of utilization per
// day for the last 3 weeks" in a way they can't sanity-check an opaque ML
// forecast, and the data volume here (tens of daily points) doesn't justify
// anything heavier.
// ---------------------------------------------------------------------------

function leastSquares(points: Array<{ x: number; y: number }>): { slope: number; intercept: number } {
  const n = points.length;
  const sumX = points.reduce((a, p) => a + p.x, 0);
  const sumY = points.reduce((a, p) => a + p.y, 0);
  const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
  const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return { slope: 0, intercept: n ? sumY / n : 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

const FORECAST_WINDOW_DAYS = 30;
const FORECAST_MIN_DAYS = 5;

async function runForecast(router: Router, sold: number): Promise<void> {
  if (sold <= 0) return;
  const since = new Date(Date.now() - FORECAST_WINDOW_DAYS * 86_400_000);
  const rows = await db.select({
    day: sql<string>`to_char(${routerHealthSnapshotsTable.capturedAt}, 'YYYY-MM-DD')`,
    peakBps: sql<string>`max(coalesce(${routerHealthSnapshotsTable.rxBps},0)::numeric + coalesce(${routerHealthSnapshotsTable.txBps},0)::numeric)`,
  }).from(routerHealthSnapshotsTable)
    .where(and(eq(routerHealthSnapshotsTable.routerId, router.id), gte(routerHealthSnapshotsTable.capturedAt, since)))
    .groupBy(sql`to_char(${routerHealthSnapshotsTable.capturedAt}, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${routerHealthSnapshotsTable.capturedAt}, 'YYYY-MM-DD')`);

  if (rows.length < FORECAST_MIN_DAYS) {
    // Not an error — a freshly-deployed NOC just hasn't collected enough
    // history yet. Record that honestly instead of pretending to forecast.
    await db.insert(nocCapacityForecastsTable).values({
      tenantId: router.tenantId, routerId: router.id, metric: "BANDWIDTH",
      currentUtilizationPercent: "0", trendSlopePerDay: null, projectedBreachAt: null,
      breachThresholdPercent: CONGESTION_THRESHOLD_PERCENT, sampleDays: rows.length,
    });
    return;
  }

  const points = rows.map((r, i) => ({ x: i, y: (Number(r.peakBps) / 1000 / sold) * 100 }));
  const { slope, intercept } = leastSquares(points);
  const currentUtil = points[points.length - 1].y;

  let projectedBreachAt: Date | null = null;
  if (slope > 0.01 && currentUtil < CONGESTION_THRESHOLD_PERCENT) {
    const breachAtX = (CONGESTION_THRESHOLD_PERCENT - intercept) / slope;
    const daysFromNow = breachAtX - (points.length - 1);
    if (daysFromNow > 0 && daysFromNow < 365) projectedBreachAt = new Date(Date.now() + daysFromNow * 86_400_000);
  }

  await db.insert(nocCapacityForecastsTable).values({
    tenantId: router.tenantId, routerId: router.id, metric: "BANDWIDTH",
    currentUtilizationPercent: currentUtil.toFixed(2), trendSlopePerDay: slope.toFixed(4),
    projectedBreachAt, breachThresholdPercent: CONGESTION_THRESHOLD_PERCENT, sampleDays: rows.length,
  });

  if (projectedBreachAt) {
    const daysOut = Math.round((projectedBreachAt.getTime() - Date.now()) / 86_400_000);
    if (daysOut <= 21) {
      const impacted = await countImpactedCustomers(router.id);
      await openOrRefreshIncident({
        tenantId: router.tenantId, routerId: router.id, siteId: router.siteId, category: "CONGESTION_RISK", severity: daysOut <= 7 ? "CRITICAL" : "WARN",
        title: `${router.name} projected to hit ${CONGESTION_THRESHOLD_PERCENT}% capacity in ~${daysOut}d`,
        detectionSummary: `At the current growth trend (${slope.toFixed(2)} utilization points/day over ${rows.length} days of data), ${router.name} is projected to reach ${CONGESTION_THRESHOLD_PERCENT}% of sold capacity around ${projectedBreachAt.toISOString().slice(0, 10)}.`,
        customersImpactedCount: impacted, signalSnapshot: { slope, currentUtil, sampleDays: rows.length, projectedBreachAt: projectedBreachAt.toISOString() },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Provisioning + payment health (deep integration with the provisioning
// engine and billing, as opposed to router telemetry)
// ---------------------------------------------------------------------------

async function runProvisioningHealthScan(): Promise<void> {
  const since = new Date(Date.now() - 30 * 60_000);
  const grouped = await db.select({ routerId: provisioningAuditLogsTable.routerId, tenantId: provisioningAuditLogsTable.tenantId, failures: count() })
    .from(provisioningAuditLogsTable)
    .where(and(eq(provisioningAuditLogsTable.status, "FAILED"), gte(provisioningAuditLogsTable.executedAt, since)))
    .groupBy(provisioningAuditLogsTable.routerId, provisioningAuditLogsTable.tenantId);

  for (const g of grouped) {
    if (Number(g.failures) < 3) continue;
    const [router] = await db.select().from(routersTable).where(eq(routersTable.id, g.routerId)).limit(1);
    if (!router) continue;

    const { row: incident, isNew } = await openOrRefreshIncident({
      tenantId: g.tenantId, routerId: g.routerId, siteId: router.siteId, category: "PROVISIONING_FAILURE_SPIKE", severity: "WARN",
      title: `Provisioning failures spiking on ${router.name}`,
      detectionSummary: `${g.failures} provisioning attempt(s) failed on ${router.name} in the last 30 minutes — this may indicate the router itself is degraded even though it's still answering health checks, or a systemic credential/config issue.`,
      customersImpactedCount: Number(g.failures), signalSnapshot: { failures: Number(g.failures), windowMinutes: 30 },
    });
    if (!isNew) continue;

    const failedSubs = await db.selectDistinct({ subscriptionId: provisioningMappingsTable.subscriptionId }).from(provisioningMappingsTable)
      .where(and(eq(provisioningMappingsTable.routerId, g.routerId), eq(provisioningMappingsTable.status, "FAILED"))).limit(5);
    for (const s of failedSubs) {
      await createRecommendation({
        tenantId: g.tenantId, incidentId: incident.id, routerId: g.routerId, subscriptionId: s.subscriptionId,
        title: "Retry provisioning for this subscription",
        rationale: "This subscription's provisioning is currently FAILED and waiting out its own retry backoff. Provisioning is idempotent and safe to re-run now instead of waiting.",
        actionType: "RETRY_PROVISIONING", actionParams: { subscriptionId: s.subscriptionId }, confidence: 80,
      });
    }
  }
}

async function runPaymentHealthScan(): Promise<void> {
  const since = new Date(Date.now() - 60 * 60_000);
  const grouped = await db.select({
    tenantId: stkPushRequestsTable.tenantId, total: count(),
    failed: sql<string>`count(*) filter (where ${stkPushRequestsTable.status} = 'FAILED')`,
  }).from(stkPushRequestsTable).where(gte(stkPushRequestsTable.createdAt, since)).groupBy(stkPushRequestsTable.tenantId);

  for (const g of grouped) {
    const total = Number(g.total);
    const failed = Number(g.failed);
    if (total < 5) continue; // too little volume in an hour to say anything statistically meaningful
    const failureRate = failed / total;
    if (failureRate < 0.4) continue;

    await openOrRefreshIncident({
      tenantId: g.tenantId, routerId: null, siteId: null, category: "PAYMENT_FAILURE_SPIKE",
      severity: failureRate >= 0.7 ? "CRITICAL" : "WARN",
      title: "M-PESA payment failures are elevated",
      detectionSummary: `${failed} of ${total} STK push attempts failed in the last hour (${Math.round(failureRate * 100)}%). This is a billing/Safaricom-side signal — the NOC has no safe automated remediation for it, only visibility.`,
      customersImpactedCount: failed, signalSnapshot: { total, failed, failureRate },
    });
  }
}

// ---------------------------------------------------------------------------
// Periodic sweep orchestration
// ---------------------------------------------------------------------------

export async function runNocAnalysisSweep(): Promise<void> {
  const routers = await db.select().from(routersTable).where(eq(routersTable.isActive, true));
  for (const router of routers) {
    await runAnomalyScan(router).catch((err) => logger.error({ err, routerId: router.id }, "Anomaly scan failed"));
    const sold = await runCongestionScan(router).catch((err) => { logger.error({ err, routerId: router.id }, "Congestion scan failed"); return 0; });
    await runForecast(router, sold).catch((err) => logger.error({ err, routerId: router.id }, "Forecast failed"));
  }
  await runProvisioningHealthScan().catch((err) => logger.error({ err }, "Provisioning health scan failed"));
  await runPaymentHealthScan().catch((err) => logger.error({ err }, "Payment health scan failed"));
  await resolveStaleFlappingIncidents().catch((err) => logger.error({ err }, "Stale-flap resolution failed"));
}

export function startNocAnalysisSweep(intervalMs = 180_000): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runNocAnalysisSweep();
    } catch (err) {
      logger.error({ err }, "NOC analysis sweep failed");
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), intervalMs).unref();
  // First run shortly after boot, not immediately — give the collector a
  // few ticks to persist some snapshots first so anomaly/congestion scans
  // have at least a little data rather than trivially bailing out on all of it.
  setTimeout(() => void tick(), 45_000).unref();
}

// ---------------------------------------------------------------------------
// Incident report generation
// ---------------------------------------------------------------------------

export async function generateIncidentReport(incidentId: string, tenantId: string): Promise<{ markdown: string } | null> {
  const [incident] = await db.select().from(nocIncidentsTable).where(and(eq(nocIncidentsTable.id, incidentId), eq(nocIncidentsTable.tenantId, tenantId))).limit(1);
  if (!incident) return null;
  const events = await db.select().from(nocIncidentEventsTable).where(eq(nocIncidentEventsTable.incidentId, incidentId)).orderBy(nocIncidentEventsTable.createdAt);
  const recommendations = await db.select().from(nocRecommendationsTable).where(eq(nocRecommendationsTable.incidentId, incidentId)).orderBy(nocRecommendationsTable.createdAt);
  const router = incident.routerId ? (await db.select().from(routersTable).where(eq(routersTable.id, incident.routerId)).limit(1))[0] : undefined;

  const durationMin = incident.resolvedAt ? Math.round((incident.resolvedAt.getTime() - incident.openedAt.getTime()) / 60_000) : null;

  let narrative = incident.rootCauseNarrative;
  if (!narrative) {
    narrative = await maybeNarrate(
      tenantId,
      "Write a concise incident-report narrative (root cause, impact, resolution) for ISP operations staff and management, given this incident's full structured record.",
      { incident, events, recommendations },
    );
  }

  const lines: string[] = [];
  lines.push(`# Incident Report: ${incident.title}`);
  lines.push("");
  lines.push(`**Category:** ${incident.category}  `);
  lines.push(`**Severity:** ${incident.severity}  `);
  lines.push(`**Status:** ${incident.status}  `);
  if (router) lines.push(`**Router:** ${router.name} (${router.ipAddress})  `);
  lines.push(`**Customers impacted:** ${incident.customersImpactedCount}  `);
  lines.push(`**Opened:** ${incident.openedAt.toISOString()}  `);
  if (incident.resolvedAt) lines.push(`**Resolved:** ${incident.resolvedAt.toISOString()} (${durationMin} min)  `);
  lines.push("");
  lines.push("## Summary");
  lines.push(incident.detectionSummary);
  if (narrative) {
    lines.push("");
    lines.push("## Root cause analysis");
    lines.push(narrative);
  }
  if (recommendations.length) {
    lines.push("");
    lines.push("## Recommendations & actions");
    for (const r of recommendations) {
      lines.push(`- **${r.title}** _(${r.riskLevel}, ${r.status})_ — ${r.rationale}`);
    }
  }
  lines.push("");
  lines.push("## Timeline");
  for (const e of events) {
    lines.push(`- ${e.createdAt.toISOString()} — **${e.kind}** (${e.actorLabel ?? "staff"}): ${e.message}`);
  }

  await addEvent(tenantId, incidentId, "REPORT_GENERATED", "Incident report generated.");
  return { markdown: lines.join("\n") };
}
