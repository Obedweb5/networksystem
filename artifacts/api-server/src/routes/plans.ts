import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { servicePlansTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { ListPlansQueryParams, CreatePlanBody, GetPlanParams, UpdatePlanParams, UpdatePlanBody, DeletePlanParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/plans", requireAuth, async (req, res) => {
  const parse = ListPlansQueryParams.safeParse(req.query);
  if (!parse.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const { tenantId } = req.user!;
  const conditions = [eq(servicePlansTable.tenantId, tenantId)];
  if (parse.data.isActive !== undefined) conditions.push(eq(servicePlansTable.isActive, parse.data.isActive));
  if (parse.data.type) conditions.push(eq(servicePlansTable.type, parse.data.type));
  const data = await db.select().from(servicePlansTable).where(and(...conditions)).orderBy(desc(servicePlansTable.createdAt));
  res.json(data.map(p => ({ ...p, price: p.price })));
});

router.post("/plans", requireAuth, async (req, res) => {
  const parse = CreatePlanBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Validation failed", details: parse.error.issues }); return; }
  const { tenantId } = req.user!;
  const [plan] = await db.insert(servicePlansTable).values({ ...parse.data, tenantId }).returning();
  res.status(201).json(plan);
});

router.get("/plans/:id", requireAuth, async (req, res) => {
  const parse = GetPlanParams.safeParse(req.params);
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { tenantId } = req.user!;
  const [plan] = await db.select().from(servicePlansTable).where(and(eq(servicePlansTable.id, parse.data.id), eq(servicePlansTable.tenantId, tenantId))).limit(1);
  if (!plan) { res.status(404).json({ error: "Plan not found" }); return; }
  res.json(plan);
});

router.patch("/plans/:id", requireAuth, async (req, res) => {
  const paramParse = UpdatePlanParams.safeParse(req.params);
  const bodyParse = UpdatePlanBody.safeParse(req.body);
  if (!paramParse.success || !bodyParse.success) { res.status(400).json({ error: "Validation failed" }); return; }
  const { tenantId } = req.user!;
  const [updated] = await db.update(servicePlansTable).set({ ...bodyParse.data, updatedAt: new Date() })
    .where(and(eq(servicePlansTable.id, paramParse.data.id), eq(servicePlansTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Plan not found" }); return; }
  res.json(updated);
});

router.delete("/plans/:id", requireAuth, async (req, res) => {
  const parse = DeletePlanParams.safeParse(req.params);
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { tenantId } = req.user!;
  const [updated] = await db.update(servicePlansTable).set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(servicePlansTable.id, parse.data.id), eq(servicePlansTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "Plan not found" }); return; }
  res.json({ success: true });
});

export default router;
