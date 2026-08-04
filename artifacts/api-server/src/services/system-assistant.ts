import { and, eq, or, ilike, desc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  customersTable, subscriptionsTable, servicePlansTable, walletsTable, loyaltyAccountsTable,
  invoicesTable, routersTable,
  nocIncidentsTable, nocIncidentEventsTable, nocRecommendationsTable, nocRecommendationStatusEnum,
  voucherBatchesTable, usersTable, tenantsTable,
} from "@workspace/db/schema";
import {
  suspendSubscription, reactivateSubscription, provisionSubscription, reprovisionSubscription,
} from "./provisioning-engine";
import { disconnectPppoeSession, disconnectHotspotSession } from "@workspace/mikrotik";
import { restartMonitoring } from "./noc-collector";
import { executeRecommendation, rejectRecommendation } from "./noc-actions";
import { getNocSettings } from "./noc-settings";
import { logger } from "../lib/logger";

/**
 * System Assistant — a general-purpose, tool-using chat layer over the
 * whole platform (not just the NOC).
 *
 * Uses Google's Gemini API (free tier available via Google AI Studio) —
 * deliberately a different provider/key than noc-llm.ts's narrative layer,
 * which still uses ANTHROPIC_API_KEY. The two are independent: this file
 * degrading to "not configured" doesn't affect NOC root-cause narratives,
 * and vice versa.
 *
 * Design mirrors noc-llm.ts's safety posture, extended with tools:
 *  - Every "read" tool is a thin, tenant-scoped query against tables that
 *    already exist — no new data access path, just a natural-language
 *    front door onto the same rows the dashboard/customers/routers pages
 *    already show this user.
 *  - Every "action" tool calls the SAME audited, idempotent engine
 *    functions the REST routes call (provisioning-engine.ts,
 *    noc-actions.ts) — it does not touch the DB directly for mutations,
 *    and it re-checks the same role requirements the equivalent REST route
 *    enforces (see requireOperator below) before running anything.
 *  - A chat message the user actually sent and the server authenticated is
 *    treated as human intent, exactly like a click on "Approve" in the NOC
 *    UI — so REQUIRES_APPROVAL-tier actions (suspend, reprovision) can run
 *    when asked for directly, same as they could from the existing UI.
 *  - The model cannot invent a tool call outside this fixed list, and every
 *    tool call the model makes is recorded in the returned trace so the
 *    UI can show exactly what was looked up or changed.
 */

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.0-flash";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_TOOL_ITERATIONS = 8;

function model(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

function apiKey(): string | null {
  // GEMINI_API_KEY is the documented name; GOOGLE_API_KEY accepted too
  // since that's what some Google AI Studio quick-start snippets use.
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

export function isAssistantConfigured(): boolean {
  return apiKey() !== null;
}

export interface AssistantActor {
  userId: string;
  tenantId: string;
  roles: string[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolTrace {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  ok: boolean;
}

export interface AssistantTurnResult {
  reply: string;
  toolTrace: ToolTrace[];
}

// ---------------------------------------------------------------------------
// Known gaps — grounded in what's actually in the codebase (ComingSoon
// panels, the 501 in routes/notifications.ts, etc.), not guessed. Kept as
// data so it's trivial to update as gaps get closed, and so the model is
// citing real facts rather than inferring from silence.
// ---------------------------------------------------------------------------

const KNOWN_GAPS = [
  { area: "Notifications", gap: "Email and WhatsApp are recognized channels in the data model but have no provider wired up — only SMS actually sends. Sending EMAIL/WHATSAPP returns HTTP 501." },
  { area: "Payments", gap: "Bank transfer is not available as a payment method — there is no reconciliation flow to match an incoming bank transfer to a subscription (unlike the M-PESA callback path)." },
  { area: "Payments", gap: "No other payment providers (card, other mobile money) are wired up beyond M-PESA." },
  { area: "Backups", gap: "There is no in-app database backup/restore. Backups must be handled at the infrastructure level (e.g. the Postgres provider's own snapshot tooling)." },
  { area: "Integrations", gap: "No third-party integrations (accounting software, CRM, etc.) exist yet." },
  { area: "AI narrative", gap: "The NOC root-cause narrative layer (incident reports, plain-English fault summaries) silently degrades to rule-based/unavailable if ANTHROPIC_API_KEY is not configured for the environment. This chat assistant is a separate integration (Gemini) and degrades independently if GEMINI_API_KEY is missing." },
] as const;

// ---------------------------------------------------------------------------
// System prompt — architecture knowledge so the model can explain the
// platform accurately without needing a tool call for conceptual questions.
// ---------------------------------------------------------------------------

const SYSTEM_KNOWLEDGE = `
This platform is a multi-tenant ISP / hotspot billing and network-management system. Major parts:

- Customers: people/accounts (customersTable), each with a wallet (prepaid balance) and a loyalty points account.
- Plans (servicePlansTable): PPPoE or Hotspot service tiers (speed, price, validity) a subscription is provisioned against.
- Subscriptions (subscriptionsTable): a customer's instance of a plan. Status is ACTIVE, SUSPENDED, OVERDUE, EXPIRED, or CANCELLED. Provisioning onto a router (creating the PPPoE secret or hotspot user) is handled by provisioning-engine.ts, which is idempotent and audited (provisioningAuditLogsTable).
- Invoices & payments: invoicesTable/paymentsTable, driven mainly by M-PESA STK push callbacks (mpesa.ts) which move an invoice to PAID and trigger provisioning/reactivation.
- Vouchers: pre-generated hotspot access codes (voucherBatchesTable/vouchersTable), redeemed by customers directly.
- Routers: MikroTik devices (routersTable) polled periodically for health (router_health_snapshots) and live PPPoE/hotspot sessions, all via the RouterOS API (lib/mikrotik).
- RADIUS: a separate radius-server artifact provides AAA for routers configured to authenticate via RADIUS instead of router-local secrets.
- AI NOC: a rule-based fault detector (noc-analysis.ts) that turns router/billing signals into incidents and recommendations. An LLM (noc-llm.ts) only narrates already-computed signals into readable prose — it never decides what's safe to run. noc-actions.ts's ACTION_RISK_LEVEL map (developer-defined, not model-controlled) decides whether a recommendation can auto-execute (SAFE), needs a human click (REQUIRES_APPROVAL), or is informational only.
- Auto-remediation: an opt-in setting (off by default) that lets SAFE-tier recommendations run unattended on a timer; anything riskier always needs a human.

Roles: SUPER_ADMIN and BUSINESS_OWNER have full tenant administration. STAFF and TECHNICIAN can operate the network/subscriptions but not tenant settings or users. RESELLER has narrower billing/reporting access. Everything is scoped by tenantId — one deployment can serve many ISPs, each seeing only their own data.
`.trim();

function buildSystemPrompt(actor: AssistantActor): string {
  return [
    "You are the in-app System Assistant for this ISP management platform, talking to an authenticated staff member inside the admin dashboard.",
    "You can explain how the system works, answer questions about live data using your tools, and — when explicitly asked — perform actions using your tools.",
    "Always use a tool to check current data rather than guessing at numbers, statuses, or IDs; never invent a customer, subscription, router, or invoice that a tool didn't return.",
    "Before running an action tool that changes something (suspend, reactivate, reprovision, disconnect, resolve, approve/reject, retry provisioning, restart monitoring), make sure the person's message actually asked for that action — do not take actions the user didn't request, and if a request is ambiguous (e.g. which of several matching customers), ask which one instead of guessing.",
    "If a tool call fails or a role check blocks an action, tell the user plainly why, and don't retry the same call.",
    "When asked what's missing, not implemented, or incomplete in the system, call list_known_gaps and answer from that — don't speculate beyond it, but you may add relevant context you already know about the surrounding feature.",
    "Keep answers concise and concrete. Use plain prose; short bullet lists are fine for multi-item answers. No walls of text.",
    `\nPlatform architecture reference:\n${SYSTEM_KNOWLEDGE}`,
    `\nThis user: userId=${actor.userId}, roles=${actor.roles.join(", ") || "(none)"}, tenantId=${actor.tenantId}.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Role gates for action tools — mirrors the requireRole(...) sets already
// enforced by the equivalent REST routes (routes/noc.ts, routes/subscriptions.ts,
// routes/sessions.ts). Re-checked here independently of whatever the route
// layer did, since this service can in principle be called from anywhere.
// ---------------------------------------------------------------------------

const OPERATOR_ROLES = ["SUPER_ADMIN", "BUSINESS_OWNER", "STAFF", "TECHNICIAN"];

function requireOperator(actor: AssistantActor): string | null {
  const has = actor.roles.some((r) => OPERATOR_ROLES.includes(r.toUpperCase()));
  return has ? null : "This action requires an operator role (super_admin, business_owner, staff, or technician). Your account doesn't have one of those roles.";
}

// ---------------------------------------------------------------------------
// Tool definitions — plain JSON-schema style (provider-agnostic); converted
// to Gemini's function-declaration Schema format by toGeminiTools() below.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "search_customers",
    description: "Search customers by name or phone number, optionally filtered by active status. Returns basic info plus their active subscription if any.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name or phone fragment to search for. Omit to list recent customers." },
        isActive: { type: "boolean", description: "Filter to active or inactive customers only." },
        limit: { type: "integer", description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "get_customer",
    description: "Get full detail for one customer by id: profile, wallet balance, loyalty points, and all subscriptions.",
    input_schema: { type: "object", properties: { customerId: { type: "string" } }, required: ["customerId"] },
  },
  {
    name: "list_subscriptions",
    description: "List subscriptions, optionally filtered by status (ACTIVE, SUSPENDED, OVERDUE, EXPIRED, CANCELLED) or customerId.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "OVERDUE", "EXPIRED", "CANCELLED"] },
        customerId: { type: "string" },
        limit: { type: "integer", description: "Default 20, max 50." },
      },
    },
  },
  {
    name: "get_subscription",
    description: "Get full detail for one subscription by id, including plan, router, and status.",
    input_schema: { type: "object", properties: { subscriptionId: { type: "string" } }, required: ["subscriptionId"] },
  },
  {
    name: "list_invoices",
    description: "List invoices, optionally filtered by status (DRAFT, PENDING, PAID, VOID) or customerId.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["DRAFT", "PENDING", "PAID", "VOID"] },
        customerId: { type: "string" },
        limit: { type: "integer", description: "Default 20, max 50." },
      },
    },
  },
  {
    name: "list_routers",
    description: "List all routers for this tenant with their latest health snapshot (status, CPU/memory, active session counts).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_plans",
    description: "List all service plans (PPPoE and Hotspot) configured for this tenant.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_voucher_batches",
    description: "List hotspot voucher batches with redemption counts.",
    input_schema: { type: "object", properties: { limit: { type: "integer", description: "Default 10, max 30." } } },
  },
  {
    name: "get_noc_overview",
    description: "Get the current NOC dashboard summary: routers online/degraded/offline, active sessions, open incidents, pending recommendations, subscription and payment stats.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_incidents",
    description: "List NOC incidents, optionally filtered by status (OPEN, ACKNOWLEDGED, RESOLVED, AUTO_RESOLVED).",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["OPEN", "ACKNOWLEDGED", "RESOLVED", "AUTO_RESOLVED"] }, limit: { type: "integer" } } },
  },
  {
    name: "list_recommendations",
    description: "List NOC recommendations (AI-suggested or rule-suggested fixes), optionally filtered by status.",
    input_schema: { type: "object", properties: { status: { type: "string", enum: nocRecommendationStatusEnum.enumValues as unknown as string[] } } },
  },
  {
    name: "list_known_gaps",
    description: "List known missing / not-yet-built features in this system, grounded in the actual codebase (not speculation). Use this whenever the user asks what's missing, incomplete, or not implemented.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_tenant_info",
    description: "Get this tenant's (ISP business's) profile info and staff user count.",
    input_schema: { type: "object", properties: {} },
  },

  // --- Action tools --------------------------------------------------------
  {
    name: "suspend_subscription",
    description: "Suspend an active subscription (deprovisions it from the router). Requires an operator role. Only run this when the user explicitly asked to suspend something.",
    input_schema: { type: "object", properties: { subscriptionId: { type: "string" }, reason: { type: "string" } }, required: ["subscriptionId", "reason"] },
  },
  {
    name: "reactivate_subscription",
    description: "Reactivate a suspended/overdue subscription (re-provisions it on the router). Requires an operator role.",
    input_schema: { type: "object", properties: { subscriptionId: { type: "string" } }, required: ["subscriptionId"] },
  },
  {
    name: "retry_provisioning",
    description: "Re-run provisioning for a subscription that failed to provision. Requires an operator role.",
    input_schema: { type: "object", properties: { subscriptionId: { type: "string" } }, required: ["subscriptionId"] },
  },
  {
    name: "reprovision_router",
    description: "Move a subscription to a different router and re-provision it there. Requires an operator role.",
    input_schema: { type: "object", properties: { subscriptionId: { type: "string" }, newRouterId: { type: "string" } }, required: ["subscriptionId", "newRouterId"] },
  },
  {
    name: "disconnect_session",
    description: "Force-disconnect a live PPPoE or hotspot session on a router. Requires an operator role.",
    input_schema: {
      type: "object",
      properties: { routerId: { type: "string" }, sessionId: { type: "string" }, sessionType: { type: "string", enum: ["PPPOE", "HOTSPOT"] } },
      required: ["routerId", "sessionId", "sessionType"],
    },
  },
  {
    name: "restart_monitoring",
    description: "Reset this server's own in-memory polling state for a router (does not touch the router itself). Safe, no role restriction beyond being authenticated.",
    input_schema: { type: "object", properties: { routerId: { type: "string" } }, required: ["routerId"] },
  },
  {
    name: "acknowledge_incident",
    description: "Acknowledge an open NOC incident. Requires an operator role.",
    input_schema: { type: "object", properties: { incidentId: { type: "string" } }, required: ["incidentId"] },
  },
  {
    name: "resolve_incident",
    description: "Resolve a NOC incident, with an optional note. Requires an operator role.",
    input_schema: { type: "object", properties: { incidentId: { type: "string" }, note: { type: "string" } }, required: ["incidentId"] },
  },
  {
    name: "approve_recommendation",
    description: "Approve and execute a pending NOC recommendation (works for both SAFE and REQUIRES_APPROVAL tiers, since this is an explicit human request). Requires an operator role.",
    input_schema: { type: "object", properties: { recommendationId: { type: "string" } }, required: ["recommendationId"] },
  },
  {
    name: "reject_recommendation",
    description: "Dismiss/reject a pending NOC recommendation. Requires an operator role.",
    input_schema: { type: "object", properties: { recommendationId: { type: "string" } }, required: ["recommendationId"] },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function runTool(name: string, input: Record<string, unknown>, actor: AssistantActor): Promise<unknown> {
  const { tenantId } = actor;

  switch (name) {
    case "search_customers": {
      const limit = Math.min(Number(input.limit ?? 10) || 10, 25);
      const conditions = [eq(customersTable.tenantId, tenantId)];
      if (typeof input.isActive === "boolean") conditions.push(eq(customersTable.isActive, input.isActive));
      if (typeof input.query === "string" && input.query.trim()) {
        const q = `%${input.query.trim()}%`;
        conditions.push(or(ilike(customersTable.firstName, q), ilike(customersTable.lastName, q), ilike(customersTable.phone, q))!);
      }
      const rows = await db.select().from(customersTable).where(and(...conditions)).orderBy(desc(customersTable.createdAt)).limit(limit);
      return { customers: rows.map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`, phone: c.phone, email: c.email, isActive: c.isActive, accountNumber: c.accountNumber })) };
    }

    case "get_customer": {
      const [customer] = await db.select().from(customersTable).where(and(eq(customersTable.id, String(input.customerId)), eq(customersTable.tenantId, tenantId))).limit(1);
      if (!customer) return { error: "Customer not found" };
      const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.customerId, customer.id)).limit(1);
      const [loyalty] = await db.select().from(loyaltyAccountsTable).where(eq(loyaltyAccountsTable.customerId, customer.id)).limit(1);
      // loyalty.balance is the points balance (loyaltyAccountsTable has no separate "pointsBalance" column)
      const subs = await db.select({ sub: subscriptionsTable, planName: servicePlansTable.name })
        .from(subscriptionsTable).leftJoin(servicePlansTable, eq(subscriptionsTable.planId, servicePlansTable.id))
        .where(eq(subscriptionsTable.customerId, customer.id)).orderBy(desc(subscriptionsTable.createdAt));
      return {
        id: customer.id, name: `${customer.firstName} ${customer.lastName}`, phone: customer.phone, email: customer.email,
        isActive: customer.isActive, accountNumber: customer.accountNumber, createdAt: customer.createdAt,
        wallet: wallet ? { balance: wallet.balance, currency: wallet.currency } : null,
        loyaltyPoints: loyalty?.balance ?? null,
        subscriptions: subs.map((s) => ({ id: s.sub.id, plan: s.planName, status: s.sub.status, expiresAt: s.sub.expiresAt, routerId: s.sub.routerId })),
      };
    }

    case "list_subscriptions": {
      const limit = Math.min(Number(input.limit ?? 20) || 20, 50);
      const conditions = [eq(subscriptionsTable.tenantId, tenantId)];
      if (typeof input.status === "string") conditions.push(eq(subscriptionsTable.status, input.status as "ACTIVE"));
      if (typeof input.customerId === "string") conditions.push(eq(subscriptionsTable.customerId, input.customerId));
      const rows = await db.select({ sub: subscriptionsTable, planName: servicePlansTable.name, customerName: sql<string>`${customersTable.firstName} || ' ' || ${customersTable.lastName}` })
        .from(subscriptionsTable)
        .leftJoin(servicePlansTable, eq(subscriptionsTable.planId, servicePlansTable.id))
        .leftJoin(customersTable, eq(subscriptionsTable.customerId, customersTable.id))
        .where(and(...conditions)).orderBy(desc(subscriptionsTable.createdAt)).limit(limit);
      return { subscriptions: rows.map((r) => ({ id: r.sub.id, customer: r.customerName, plan: r.planName, status: r.sub.status, expiresAt: r.sub.expiresAt })) };
    }

    case "get_subscription": {
      const [row] = await db.select({ sub: subscriptionsTable, planName: servicePlansTable.name, customerName: sql<string>`${customersTable.firstName} || ' ' || ${customersTable.lastName}` })
        .from(subscriptionsTable)
        .leftJoin(servicePlansTable, eq(subscriptionsTable.planId, servicePlansTable.id))
        .leftJoin(customersTable, eq(subscriptionsTable.customerId, customersTable.id))
        .where(and(eq(subscriptionsTable.id, String(input.subscriptionId)), eq(subscriptionsTable.tenantId, tenantId))).limit(1);
      if (!row) return { error: "Subscription not found" };
      return { id: row.sub.id, customer: row.customerName, plan: row.planName, status: row.sub.status, routerId: row.sub.routerId, startsAt: row.sub.startsAt, expiresAt: row.sub.expiresAt, autoRenew: row.sub.autoRenew };
    }

    case "list_invoices": {
      const limit = Math.min(Number(input.limit ?? 20) || 20, 50);
      const conditions = [eq(invoicesTable.tenantId, tenantId)];
      if (typeof input.status === "string") conditions.push(eq(invoicesTable.status, input.status as "PAID"));
      if (typeof input.customerId === "string") conditions.push(eq(invoicesTable.customerId, input.customerId));
      const rows = await db.select({ inv: invoicesTable, customerName: sql<string>`${customersTable.firstName} || ' ' || ${customersTable.lastName}` })
        .from(invoicesTable).leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
        .where(and(...conditions)).orderBy(desc(invoicesTable.createdAt)).limit(limit);
      return { invoices: rows.map((r) => ({ id: r.inv.id, customer: r.customerName, amount: r.inv.amount, status: r.inv.status, createdAt: r.inv.createdAt })) };
    }

    case "list_routers": {
      const routers = await db.select().from(routersTable).where(eq(routersTable.tenantId, tenantId)).orderBy(routersTable.name);
      if (routers.length === 0) return { routers: [] };
      const latest = await db.execute(sql`
        select distinct on (router_id) router_id, status, captured_at, cpu_load_percent, memory_used_percent, pppoe_active_count, hotspot_active_count
        from router_health_snapshots where tenant_id = ${tenantId} order by router_id, captured_at desc
      `);
      const byRouter = new Map((latest.rows as Array<Record<string, unknown>>).map((r) => [r.router_id as string, r]));
      return {
        routers: routers.map((r) => {
          const s = byRouter.get(r.id);
          return { id: r.id, name: r.name, ipAddress: r.ipAddress, isActive: r.isActive, status: s?.status ?? "OFFLINE", cpuLoadPercent: s?.cpu_load_percent ?? null, memoryUsedPercent: s?.memory_used_percent ?? null, pppoeActive: s?.pppoe_active_count ?? null, hotspotActive: s?.hotspot_active_count ?? null };
        }),
      };
    }

    case "list_plans": {
      const rows = await db.select().from(servicePlansTable).where(eq(servicePlansTable.tenantId, tenantId));
      return { plans: rows.map((p) => ({ id: p.id, name: p.name, type: p.type, price: p.price, durationDays: p.durationDays, isActive: p.isActive })) };
    }

    case "list_voucher_batches": {
      const limit = Math.min(Number(input.limit ?? 10) || 10, 30);
      const rows = await db.select().from(voucherBatchesTable).where(eq(voucherBatchesTable.tenantId, tenantId)).orderBy(desc(voucherBatchesTable.createdAt)).limit(limit);
      return { batches: rows.map((b) => ({ id: b.id, name: b.name, quantity: b.quantity, createdAt: b.createdAt })) };
    }

    case "get_noc_overview": {
      const settings = await getNocSettings(tenantId);
      const [openIncidents] = await db.select({ n: sql<string>`count(*)` }).from(nocIncidentsTable).where(and(eq(nocIncidentsTable.tenantId, tenantId), sql`${nocIncidentsTable.status} in ('OPEN','ACKNOWLEDGED')`));
      const [pendingRecs] = await db.select({ n: sql<string>`count(*)` }).from(nocRecommendationsTable).where(and(eq(nocRecommendationsTable.tenantId, tenantId), eq(nocRecommendationsTable.status, "PENDING")));
      return { openIncidents: Number(openIncidents?.n ?? 0), pendingRecommendations: Number(pendingRecs?.n ?? 0), autoRemediationEnabled: settings.autoRemediationEnabled };
    }

    case "list_incidents": {
      const limit = Math.min(Number(input.limit ?? 20) || 20, 50);
      const conditions = [eq(nocIncidentsTable.tenantId, tenantId)];
      if (typeof input.status === "string") conditions.push(eq(nocIncidentsTable.status, input.status as "OPEN"));
      const rows = await db.select().from(nocIncidentsTable).where(and(...conditions)).orderBy(desc(nocIncidentsTable.openedAt)).limit(limit);
      return { incidents: rows.map((i) => ({ id: i.id, title: i.title, severity: i.severity, status: i.status, customersImpacted: i.customersImpactedCount, openedAt: i.openedAt })) };
    }

    case "list_recommendations": {
      const conditions = [eq(nocRecommendationsTable.tenantId, tenantId)];
      if (typeof input.status === "string") conditions.push(eq(nocRecommendationsTable.status, input.status as "PENDING"));
      const rows = await db.select().from(nocRecommendationsTable).where(and(...conditions)).orderBy(desc(nocRecommendationsTable.createdAt)).limit(50);
      return { recommendations: rows.map((r) => ({ id: r.id, title: r.title, actionType: r.actionType, riskLevel: r.riskLevel, status: r.status, rationale: r.rationale })) };
    }

    case "list_known_gaps":
      return { gaps: KNOWN_GAPS };

    case "get_tenant_info": {
      const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
      const [{ n: staffCount }] = await db.select({ n: sql<string>`count(*)` }).from(usersTable).where(eq(usersTable.tenantId, tenantId));
      return tenant ? { name: tenant.name, staffCount: Number(staffCount ?? 0) } : { error: "Tenant not found" };
    }

    // --- Actions -------------------------------------------------------

    case "suspend_subscription": {
      const gate = requireOperator(actor); if (gate) return { error: gate };
      const outcome = await suspendSubscription(String(input.subscriptionId), String(input.reason ?? "Suspended via System Assistant"), "SUSPENDED", { userId: actor.userId });
      return { success: outcome.success, error: outcome.error };
    }
    case "reactivate_subscription": {
      const gate = requireOperator(actor); if (gate) return { error: gate };
      const outcome = await reactivateSubscription(String(input.subscriptionId), { userId: actor.userId });
      return { success: outcome.success, error: outcome.error };
    }
    case "retry_provisioning": {
      const gate = requireOperator(actor); if (gate) return { error: gate };
      const outcome = await provisionSubscription(String(input.subscriptionId), { userId: actor.userId });
      return { success: outcome.success, error: outcome.error };
    }
    case "reprovision_router": {
      const gate = requireOperator(actor); if (gate) return { error: gate };
      const outcome = await reprovisionSubscription(String(input.subscriptionId), { newRouterId: String(input.newRouterId) }, { userId: actor.userId });
      return { success: outcome.success, error: outcome.error };
    }
    case "disconnect_session": {
      const gate = requireOperator(actor); if (gate) return { error: gate };
      const [router] = await db.select().from(routersTable).where(and(eq(routersTable.id, String(input.routerId)), eq(routersTable.tenantId, tenantId))).limit(1);
      if (!router) return { error: "Router not found" };
      const config = { id: router.id, tenantId: router.tenantId, name: router.name, ipAddress: router.ipAddress, apiPort: router.apiPort ?? 8728, apiUsername: router.apiUsername, apiSecret: router.apiSecret };
      const result = input.sessionType === "HOTSPOT" ? await disconnectHotspotSession(config, String(input.sessionId)) : await disconnectPppoeSession(config, String(input.sessionId));
      return { success: result.success, error: result.error };
    }
    case "restart_monitoring": {
      restartMonitoring(String(input.routerId));
      return { success: true };
    }
    case "acknowledge_incident": {
      const gate = requireOperator(actor); if (gate) return { error: gate };
      const [incident] = await db.select().from(nocIncidentsTable).where(and(eq(nocIncidentsTable.id, String(input.incidentId)), eq(nocIncidentsTable.tenantId, tenantId))).limit(1);
      if (!incident) return { error: "Incident not found" };
      if (incident.status !== "OPEN") return { error: `Incident is already ${incident.status}` };
      await db.update(nocIncidentsTable).set({ status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedBy: actor.userId, updatedAt: new Date() }).where(eq(nocIncidentsTable.id, incident.id));
      await db.insert(nocIncidentEventsTable).values({ tenantId, incidentId: incident.id, kind: "ACKNOWLEDGED", message: "Acknowledged via System Assistant.", actorUserId: actor.userId });
      return { success: true };
    }
    case "resolve_incident": {
      const gate = requireOperator(actor); if (gate) return { error: gate };
      const [incident] = await db.select().from(nocIncidentsTable).where(and(eq(nocIncidentsTable.id, String(input.incidentId)), eq(nocIncidentsTable.tenantId, tenantId))).limit(1);
      if (!incident) return { error: "Incident not found" };
      if (incident.status === "RESOLVED" || incident.status === "AUTO_RESOLVED") return { error: "Incident is already resolved" };
      await db.update(nocIncidentsTable).set({ status: "RESOLVED", resolvedAt: new Date(), resolvedBy: actor.userId, autoResolved: false, updatedAt: new Date() }).where(eq(nocIncidentsTable.id, incident.id));
      await db.insert(nocIncidentEventsTable).values({ tenantId, incidentId: incident.id, kind: "RESOLVED", message: (typeof input.note === "string" && input.note.trim()) || "Resolved via System Assistant.", actorUserId: actor.userId });
      return { success: true };
    }
    case "approve_recommendation": {
      const gate = requireOperator(actor); if (gate) return { error: gate };
      const result = await executeRecommendation(String(input.recommendationId), tenantId, { userId: actor.userId });
      return result;
    }
    case "reject_recommendation": {
      const gate = requireOperator(actor); if (gate) return { error: gate };
      const result = await rejectRecommendation(String(input.recommendationId), tenantId, actor.userId);
      return result;
    }

    default:
      return { error: `Unknown tool "${name}"` };
  }
}

// ---------------------------------------------------------------------------
// Gemini schema conversion — TOOLS above is plain lowercase JSON-schema
// ("object", "string", ...); Gemini's function-declaration Schema wants
// uppercase Type enum values ("OBJECT", "STRING", ...). This walks the tree
// and converts, so TOOLS itself stays provider-agnostic and readable.
// ---------------------------------------------------------------------------

interface JsonSchemaLike {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
  required?: string[];
}

function toGeminiSchema(schema: JsonSchemaLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (schema.type) out.type = schema.type.toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.required) out.required = schema.required;
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

function toGeminiTools(): Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }> {
  return [{
    functionDeclarations: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toGeminiSchema(t.input_schema as unknown as JsonSchemaLike),
    })),
  }];
}

// ---------------------------------------------------------------------------
// Chat loop (Gemini generateContent, function-calling)
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{ content?: GeminiContent; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

async function callGemini(system: string, contents: GeminiContent[], key: string): Promise<GeminiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model())}:generateContent?key=${encodeURIComponent(key)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        tools: toGeminiTools(),
        generationConfig: { maxOutputTokens: 1500 },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.error({ status: response.status, body: body.slice(0, 500) }, "System assistant request failed");
      throw new Error(`Assistant request failed (${response.status})`);
    }
    return (await response.json()) as GeminiResponse;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runAssistantTurn(history: ChatMessage[], actor: AssistantActor): Promise<AssistantTurnResult> {
  const key = apiKey();
  if (!key) {
    return { reply: "The System Assistant isn't configured yet — a GEMINI_API_KEY (from Google AI Studio) needs to be set for this environment.", toolTrace: [] };
  }

  const system = buildSystemPrompt(actor);
  const contents: GeminiContent[] = history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const toolTrace: ToolTrace[] = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const result = await callGemini(system, contents, key);

    if (result.promptFeedback?.blockReason) {
      return { reply: "That request was blocked by the model's safety filters — try rephrasing it.", toolTrace };
    }

    const candidate = result.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const textBlocks = parts.map((p) => p.text ?? "").join("\n").trim();
    const functionCalls = parts.filter((p) => p.functionCall);

    if (functionCalls.length === 0) {
      return { reply: textBlocks || "I don't have anything to add.", toolTrace };
    }

    contents.push({ role: "model", parts });

    const responseParts: GeminiPart[] = [];
    for (const call of functionCalls) {
      const name = call.functionCall!.name;
      const input = call.functionCall!.args ?? {};
      let output: unknown;
      let ok = true;
      try {
        output = await runTool(name, input, actor);
        ok = !(output && typeof output === "object" && "error" in (output as Record<string, unknown>) && (output as Record<string, unknown>).error);
      } catch (err) {
        output = { error: err instanceof Error ? err.message : String(err) };
        ok = false;
      }
      toolTrace.push({ name, input, output, ok });
      responseParts.push({ functionResponse: { name, response: { result: output } } });
    }
    contents.push({ role: "function", parts: responseParts });
  }

  return { reply: "I made several tool calls but couldn't finish reasoning about the result — try narrowing your question.", toolTrace };
}

