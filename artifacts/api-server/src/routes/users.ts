import { Router, type IRouter } from "express";
import bcrypt from "bcrypt";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { ListUsersQueryParams, CreateUserBody, UpdateUserParams, UpdateUserBody, DeleteUserParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

const SALT_ROUNDS = 10;

function safeUser(u: typeof usersTable.$inferSelect) {
  const { passwordHash: _pw, twoFactorSecret: _2fa, ...rest } = u;
  return rest;
}

router.get("/users", requireAuth, async (req, res) => {
  const parse = ListUsersQueryParams.safeParse(req.query);
  if (!parse.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const { tenantId } = req.user!;
  const conditions = [eq(usersTable.tenantId, tenantId)];
  if (parse.data.isActive !== undefined) conditions.push(eq(usersTable.isActive, parse.data.isActive));
  const data = await db.select().from(usersTable).where(and(...conditions)).orderBy(desc(usersTable.createdAt));
  res.json(data.map(safeUser));
});

router.post("/users", requireAuth, async (req, res) => {
  const parse = CreateUserBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Validation failed", details: parse.error.issues }); return; }
  const { tenantId } = req.user!;
  const passwordHash = await bcrypt.hash(parse.data.password, SALT_ROUNDS);
  const [user] = await db.insert(usersTable).values({ tenantId, email: parse.data.email, passwordHash, firstName: parse.data.firstName, lastName: parse.data.lastName, phone: parse.data.phone, roles: parse.data.roles ?? ["staff"] }).returning();
  res.status(201).json(safeUser(user!));
});

router.patch("/users/:id", requireAuth, async (req, res) => {
  const paramParse = UpdateUserParams.safeParse(req.params);
  const bodyParse = UpdateUserBody.safeParse(req.body);
  if (!paramParse.success || !bodyParse.success) { res.status(400).json({ error: "Validation failed" }); return; }
  const { tenantId } = req.user!;
  const [updated] = await db.update(usersTable).set({ ...bodyParse.data, updatedAt: new Date() })
    .where(and(eq(usersTable.id, paramParse.data.id), eq(usersTable.tenantId, tenantId))).returning();
  if (!updated) { res.status(404).json({ error: "User not found" }); return; }
  res.json(safeUser(updated));
});

router.delete("/users/:id", requireAuth, async (req, res) => {
  const parse = DeleteUserParams.safeParse(req.params);
  if (!parse.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const { tenantId } = req.user!;
  await db.update(usersTable).set({ isActive: false, updatedAt: new Date() }).where(and(eq(usersTable.id, parse.data.id), eq(usersTable.tenantId, tenantId)));
  res.json({ success: true });
});

export default router;
