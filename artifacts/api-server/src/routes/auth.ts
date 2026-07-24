import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import * as zod from "zod";
import { db } from "@workspace/db";
import {
  usersTable,
  refreshTokensTable,
  tenantsTable,
  passwordResetTokensTable,
  ROLES,
  ALL_ROLES,
  type Role,
} from "@workspace/db/schema";
import { eq, and, gt, isNull, desc } from "drizzle-orm";
import { LoginBody, RefreshTokenBody, LogoutBody, SignupBody, ForgotPasswordBody, ResetPasswordBody } from "@workspace/api-zod";
import { requireAuth, requireRole, signAccessToken, signTwoFactorPendingToken, verifyTwoFactorPendingToken } from "../middlewares/auth";
import { loginRateLimiter, registerRateLimiter, passwordResetRateLimiter, twoFactorRateLimiter } from "../middlewares/rate-limit";
import { recordAuditEvent, clientIp, AUDIT_ACTIONS } from "../lib/audit-log";
import { generateTwoFactorSecret, twoFactorKeyUri, verifyTwoFactorCode } from "../lib/two-factor";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

type UserRow = typeof usersTable.$inferSelect;

function publicUser(user: UserRow) {
  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, tenantId: user.tenantId, roles: user.roles ?? [] };
}

/** Issues a fresh access + refresh token pair and records the session/device. */
async function issueSession(user: UserRow, req: Request) {
  const authUser = { id: user.id, tenantId: user.tenantId, email: user.email, roles: user.roles ?? [] };
  const accessToken = signAccessToken(authUser);
  const rawRefresh = crypto.randomBytes(40).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawRefresh).digest("hex");
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await db.insert(refreshTokensTable).values({
    userId: user.id, tokenHash, expiresAt,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    ipAddress: clientIp(req),
  });
  await db.update(usersTable).set({ lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null }).where(eq(usersTable.id, user.id));
  return { accessToken, refreshToken: rawRefresh, expiresIn: 900, tokenType: "Bearer" as const, user: publicUser(user) };
}

function isLocked(user: UserRow): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
}

/** Records a failed password attempt and locks the account after too many. */
async function registerFailedAttempt(user: UserRow, req: Request): Promise<void> {
  const attempts = user.failedLoginAttempts + 1;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    await db.update(usersTable).set({ failedLoginAttempts: 0, lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) }).where(eq(usersTable.id, user.id));
    await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.LOGIN_LOCKED, req, metadata: { attempts } });
  } else {
    await db.update(usersTable).set({ failedLoginAttempts: attempts }).where(eq(usersTable.id, user.id));
  }
  await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.LOGIN_FAILURE, req, metadata: { attempts } });
}

// ─── Login ──────────────────────────────────────────────────────────────────

router.post("/auth/login", loginRateLimiter, async (req, res) => {
  const parse = LoginBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request", details: parse.error.issues }); return; }
  const { email, password } = parse.data;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user) {
    await recordAuditEvent({ action: AUDIT_ACTIONS.LOGIN_FAILURE, req, metadata: { email, reason: "no_such_user" } });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (isLocked(user)) {
    await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.LOGIN_LOCKED, req, metadata: { reason: "still_locked" } });
    res.status(423).json({ error: "Account temporarily locked due to multiple failed attempts. Try again later." });
    return;
  }

  if (user.status === "PENDING_APPROVAL") { res.status(403).json({ error: "Account is pending admin approval" }); return; }
  if (user.status === "SUSPENDED" || user.status === "REJECTED" || !user.isActive) { res.status(403).json({ error: "Account is not active" }); return; }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    await registerFailedAttempt(user, req);
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  if (user.twoFactorEnabled) {
    const tempToken = signTwoFactorPendingToken(user.id);
    res.json({ requires2FA: true, tempToken });
    return;
  }

  const session = await issueSession(user, req);
  await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.LOGIN_SUCCESS, req });
  res.json(session);
});

/** Completes login after /auth/login returned requires2FA. */
router.post("/auth/login/2fa", twoFactorRateLimiter, async (req, res) => {
  const parse = zod.object({ tempToken: zod.string().min(1), code: zod.string().min(6).max(6) }).safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request", details: parse.error.issues }); return; }

  const userId = verifyTwoFactorPendingToken(parse.data.tempToken);
  if (!userId) { res.status(401).json({ error: "Invalid or expired verification session. Please log in again." }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) { res.status(401).json({ error: "Two-factor authentication is not available for this account" }); return; }
  if (isLocked(user)) { res.status(423).json({ error: "Account temporarily locked. Try again later." }); return; }

  if (!verifyTwoFactorCode(user.twoFactorSecret, parse.data.code)) {
    await registerFailedAttempt(user, req);
    await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.TWO_FACTOR_CHALLENGE_FAILED, req });
    res.status(401).json({ error: "Invalid verification code" });
    return;
  }

  const session = await issueSession(user, req);
  await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.LOGIN_SUCCESS, req, metadata: { via: "2fa" } });
  res.json(session);
});

router.post("/auth/refresh", async (req, res) => {
  const parse = RefreshTokenBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request" }); return; }
  const oldTokenHash = crypto.createHash("sha256").update(parse.data.refreshToken).digest("hex");
  const [record] = await db.select().from(refreshTokensTable).where(eq(refreshTokensTable.tokenHash, oldTokenHash)).limit(1);
  if (!record || record.revokedAt || record.expiresAt < new Date()) { res.status(401).json({ error: "Invalid refresh token" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, record.userId)).limit(1);
  if (!user || !user.isActive || user.status !== "ACTIVE") { res.status(401).json({ error: "User not found" }); return; }

  // Rotate: revoke old token, issue a fresh one tied to this device's current request.
  await db.update(refreshTokensTable).set({ revokedAt: new Date() }).where(eq(refreshTokensTable.id, record.id));
  const session = await issueSession(user, req);
  await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.TOKEN_REFRESH, req });
  res.json(session);
});

router.post("/auth/logout", requireAuth, async (req, res) => {
  const parse = LogoutBody.safeParse(req.body);
  if (parse.success && parse.data.refreshToken) {
    const tokenHash = crypto.createHash("sha256").update(parse.data.refreshToken).digest("hex");
    await db.update(refreshTokensTable).set({ revokedAt: new Date() }).where(eq(refreshTokensTable.tokenHash, tokenHash));
  }
  await recordAuditEvent({ tenantId: req.user!.tenantId, userId: req.user!.id, action: AUDIT_ACTIONS.LOGOUT, req });
  res.json({ success: true });
});

router.get("/auth/me", requireAuth, async (req, res) => {
  const { id } = req.user!;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json({ user: { ...publicUser(user), status: user.status, twoFactorEnabled: user.twoFactorEnabled } });
});

// ─── First-run bootstrap (trusted; not the public registration flow) ─────────
// Creates a tenant and its owner immediately, active, no approval step.
// Intended for initial deployment setup, not for public sign-ups — see
// POST /auth/register below for the self-service flow with admin approval.

router.post("/auth/signup", async (req, res) => {
  const parse = SignupBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request", details: parse.error.issues }); return; }
  const { companyName, firstName, lastName, email, password } = parse.data;

  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing) { res.status(409).json({ error: "Email already in use" }); return; }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  const { user } = await db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenantsTable).values({ name: companyName, slug: `${slug}-${Date.now()}` }).returning();
    const [user] = await tx.insert(usersTable).values({
      tenantId: tenant.id, email, passwordHash, firstName, lastName,
      roles: [ROLES.BUSINESS_OWNER], status: "ACTIVE",
    }).returning();
    return { tenant, user };
  });

  const session = await issueSession(user, req);
  await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.SIGNUP, req });
  res.status(201).json(session);
});

// ─── Public self-registration (Create Account) ────────────────────────────────
// Creates the organization/tenant and owner account immediately, but the
// account starts PENDING_APPROVAL with no role — it cannot log in until a
// Super Admin or Business Owner approves it and assigns a role.

const RegisterBody = zod.object({
  fullName: zod.string().min(2),
  email: zod.string().email(),
  phone: zod.string().min(7).max(20),
  companyName: zod.string().min(2),
  businessLocation: zod.string().min(1),
  password: zod.string().min(8),
  confirmPassword: zod.string().min(8),
});

router.post("/auth/register", registerRateLimiter, async (req, res) => {
  const parse = RegisterBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request", details: parse.error.issues }); return; }
  const { fullName, email, phone, companyName, businessLocation, password, confirmPassword } = parse.data;

  if (password !== confirmPassword) { res.status(400).json({ error: "Passwords do not match" }); return; }

  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing) { res.status(409).json({ error: "Email already in use" }); return; }

  const [firstName, ...rest] = fullName.trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName;

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  const { tenant, user } = await db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenantsTable).values({ name: companyName, slug: `${slug}-${Date.now()}` }).returning();
    const [user] = await tx.insert(usersTable).values({
      tenantId: tenant.id, email, passwordHash, firstName, lastName, phone, businessLocation,
      roles: [], status: "PENDING_APPROVAL",
    }).returning();
    return { tenant, user };
  });

  // NOTE (email/phone verification): per current scope this route does not send
  // a verification email or OTP — that requires a real email/SMS provider
  // (see .env.example). The account is created but gated on admin approval
  // below either way, so an unverified contact detail can't grant access.
  await recordAuditEvent({ tenantId: tenant.id, userId: user.id, action: AUDIT_ACTIONS.REGISTER, req });

  res.status(201).json({
    message: "Registration received. Your account is pending admin approval before you can sign in.",
    pendingApproval: true,
    userId: user.id,
  });
});

// ─── Forgot / reset password ───────────────────────────────────────────────

router.post("/auth/forgot-password", passwordResetRateLimiter, async (req, res) => {
  const parse = ForgotPasswordBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request", details: parse.error.issues }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, parse.data.email)).limit(1);
  // Always return the same response whether or not the account exists, so this
  // endpoint can't be used to enumerate registered emails.
  if (user) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    await db.insert(passwordResetTokensTable).values({
      userId: user.id, tokenHash, expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });
    // NOTE (email/SMS delivery): sending the reset link/OTP requires a real
    // provider (see .env.example — "M-PESA/Daraja and OTP gateway credentials
    // belong in the deployment secret store"). Until one is wired in, the raw
    // token is only ever logged server-side in non-production for local testing
    // — it is never returned in the API response.
    if (process.env.NODE_ENV !== "production") {
      logger.info({ userId: user.id, rawToken }, "Password reset token generated (dev-only log; wire up an email/SMS provider to deliver this)");
    }
    await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED, req });
  }

  res.json({ message: "If that email is registered, password reset instructions have been sent." });
});

router.post("/auth/reset-password", passwordResetRateLimiter, async (req, res) => {
  const parse = ResetPasswordBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request", details: parse.error.issues }); return; }

  const tokenHash = crypto.createHash("sha256").update(parse.data.token).digest("hex");
  const [record] = await db.select().from(passwordResetTokensTable)
    .where(and(eq(passwordResetTokensTable.tokenHash, tokenHash), isNull(passwordResetTokensTable.usedAt), gt(passwordResetTokensTable.expiresAt, new Date())))
    .limit(1);
  if (!record) { res.status(400).json({ error: "Invalid or expired token" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, record.userId)).limit(1);
  if (!user) { res.status(400).json({ error: "Invalid or expired token" }); return; }

  const passwordHash = await bcrypt.hash(parse.data.password, BCRYPT_ROUNDS);
  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(usersTable.id, user.id));
    await tx.update(passwordResetTokensTable).set({ usedAt: new Date() }).where(eq(passwordResetTokensTable.id, record.id));
    // Changing the password invalidates every existing session — a stolen
    // refresh token shouldn't survive a password reset.
    await tx.update(refreshTokensTable).set({ revokedAt: new Date() }).where(and(eq(refreshTokensTable.userId, user.id), isNull(refreshTokensTable.revokedAt)));
  });

  await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED, req });
  res.json({ message: "Password updated successfully. Please log in with your new password." });
});

// ─── Two-factor authentication ─────────────────────────────────────────────

router.post("/auth/2fa/setup", requireAuth, async (req, res) => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (user.twoFactorEnabled) { res.status(400).json({ error: "Two-factor authentication is already enabled. Disable it before reconfiguring." }); return; }

  const secret = generateTwoFactorSecret();
  await db.update(usersTable).set({ twoFactorSecret: secret }).where(eq(usersTable.id, user.id));
  res.json({ secret, otpauthUrl: twoFactorKeyUri(user.email, secret) });
});

router.post("/auth/2fa/verify", requireAuth, twoFactorRateLimiter, async (req, res) => {
  const parse = zod.object({ code: zod.string().min(6).max(6) }).safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
  if (!user?.twoFactorSecret) { res.status(400).json({ error: "Start setup with POST /auth/2fa/setup first" }); return; }

  if (!verifyTwoFactorCode(user.twoFactorSecret, parse.data.code)) { res.status(400).json({ error: "Invalid verification code" }); return; }

  await db.update(usersTable).set({ twoFactorEnabled: true }).where(eq(usersTable.id, user.id));
  await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.TWO_FACTOR_ENABLED, req });
  res.json({ message: "Two-factor authentication enabled." });
});

router.post("/auth/2fa/disable", requireAuth, async (req, res) => {
  const parse = zod.object({ password: zod.string().min(1) }).safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (!(await bcrypt.compare(parse.data.password, user.passwordHash))) { res.status(401).json({ error: "Incorrect password" }); return; }

  await db.update(usersTable).set({ twoFactorEnabled: false, twoFactorSecret: null }).where(eq(usersTable.id, user.id));
  await recordAuditEvent({ tenantId: user.tenantId, userId: user.id, action: AUDIT_ACTIONS.TWO_FACTOR_DISABLED, req });
  res.json({ message: "Two-factor authentication disabled." });
});

// ─── Session / device management ───────────────────────────────────────────

router.get("/auth/sessions", requireAuth, async (req, res) => {
  const sessions = await db.select({
    id: refreshTokensTable.id, userAgent: refreshTokensTable.userAgent, ipAddress: refreshTokensTable.ipAddress,
    createdAt: refreshTokensTable.createdAt, lastUsedAt: refreshTokensTable.lastUsedAt, expiresAt: refreshTokensTable.expiresAt,
  }).from(refreshTokensTable)
    .where(and(eq(refreshTokensTable.userId, req.user!.id), isNull(refreshTokensTable.revokedAt), gt(refreshTokensTable.expiresAt, new Date())))
    .orderBy(desc(refreshTokensTable.lastUsedAt));
  res.json({ sessions });
});

router.post("/auth/sessions/:id/revoke", requireAuth, async (req, res) => {
  const [session] = await db.select({ id: refreshTokensTable.id }).from(refreshTokensTable)
    .where(and(eq(refreshTokensTable.id, req.params.id), eq(refreshTokensTable.userId, req.user!.id))).limit(1);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  await db.update(refreshTokensTable).set({ revokedAt: new Date() }).where(eq(refreshTokensTable.id, session.id));
  await recordAuditEvent({ tenantId: req.user!.tenantId, userId: req.user!.id, action: AUDIT_ACTIONS.SESSION_REVOKED, req, targetType: "refresh_token", targetId: session.id });
  res.json({ success: true });
});

// ─── Role-based access control: pending-account approval ──────────────────
// A newly self-registered account has no role and cannot sign in until it's
// approved here. A self-registration always creates a brand-new tenant, so
// its owner has no same-tenant peer to approve them — approval for a new
// organization is necessarily a platform-level Super Admin action. A
// Business Owner can only see/approve pending users already inside their
// own tenant (e.g. a future "join an existing org" invite flow).

router.get("/auth/pending-users", requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.BUSINESS_OWNER), async (req, res) => {
  const isSuperAdmin = req.user!.roles.includes(ROLES.SUPER_ADMIN);
  const conditions = [eq(usersTable.status, "PENDING_APPROVAL")];
  if (!isSuperAdmin) conditions.push(eq(usersTable.tenantId, req.user!.tenantId));

  const pending = await db.select({
    id: usersTable.id, tenantId: usersTable.tenantId, email: usersTable.email, firstName: usersTable.firstName, lastName: usersTable.lastName,
    phone: usersTable.phone, businessLocation: usersTable.businessLocation, createdAt: usersTable.createdAt,
  }).from(usersTable).where(and(...conditions)).orderBy(desc(usersTable.createdAt));
  res.json({ users: pending });
});

const ApproveUserBody = zod.object({ userId: zod.uuid(), role: zod.enum(ALL_ROLES as [Role, ...Role[]]) });

router.post("/auth/approve-user", requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.BUSINESS_OWNER), async (req, res) => {
  const parse = ApproveUserBody.safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request", details: parse.error.issues }); return; }
  const { userId, role } = parse.data;

  // Only an existing Super Admin can mint another Super Admin.
  if (role === ROLES.SUPER_ADMIN && !req.user!.roles.includes(ROLES.SUPER_ADMIN)) {
    res.status(403).json({ error: "Only a Super Admin can assign the Super Admin role" });
    return;
  }

  const isSuperAdmin = req.user!.roles.includes(ROLES.SUPER_ADMIN);
  const conditions = [eq(usersTable.id, userId), eq(usersTable.status, "PENDING_APPROVAL")];
  if (!isSuperAdmin) conditions.push(eq(usersTable.tenantId, req.user!.tenantId));
  const [target] = await db.select().from(usersTable).where(and(...conditions)).limit(1);
  if (!target) { res.status(404).json({ error: "No pending user found with that id" }); return; }

  await db.update(usersTable).set({
    status: "ACTIVE", roles: [role], approvedBy: req.user!.id, approvedAt: new Date(), updatedAt: new Date(),
  }).where(eq(usersTable.id, userId));

  await recordAuditEvent({ tenantId: target.tenantId, userId: req.user!.id, action: AUDIT_ACTIONS.USER_APPROVED, req, targetType: "user", targetId: userId, metadata: { role } });
  res.json({ message: "User approved." });
});

router.post("/auth/reject-user", requireAuth, requireRole(ROLES.SUPER_ADMIN, ROLES.BUSINESS_OWNER), async (req, res) => {
  const parse = zod.object({ userId: zod.uuid(), reason: zod.string().optional() }).safeParse(req.body);
  if (!parse.success) { res.status(400).json({ error: "Invalid request", details: parse.error.issues }); return; }

  const isSuperAdmin = req.user!.roles.includes(ROLES.SUPER_ADMIN);
  const conditions = [eq(usersTable.id, parse.data.userId), eq(usersTable.status, "PENDING_APPROVAL")];
  if (!isSuperAdmin) conditions.push(eq(usersTable.tenantId, req.user!.tenantId));
  const [target] = await db.select({ id: usersTable.id, tenantId: usersTable.tenantId, status: usersTable.status }).from(usersTable)
    .where(and(...conditions)).limit(1);
  if (!target) { res.status(404).json({ error: "No pending user found with that id" }); return; }

  await db.update(usersTable).set({ status: "REJECTED", updatedAt: new Date() }).where(eq(usersTable.id, target.id));
  await recordAuditEvent({ tenantId: target.tenantId, userId: req.user!.id, action: AUDIT_ACTIONS.USER_REJECTED, req, targetType: "user", targetId: target.id, metadata: { reason: parse.data.reason } });
  res.json({ message: "User rejected." });
});

export default router;
