import { createHash, randomBytes } from "node:crypto";
import { verifyToken } from "@clerk/backend";
import type { NextRequest } from "next/server";
import type { Authenticator, AuthMode, Principal } from "../auth";
import { errors } from "../errors";
import { getEnv } from "../env";
import { prisma, Prisma } from "../db";
import { grantSignup } from "../credits";
import { logger } from "../logger";

/** Prisma 7 + @prisma/adapter-pg wraps the driver error; `meta.target` (classic Prisma) is absent,
 * so unique-violation disambiguation goes through the formatted message instead (verified empirically
 * against this stack — see final report). */
function isUniqueViolationOn(err: unknown, constraintName: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  return typeof err.message === "string" && err.message.includes(constraintName);
}

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Clerk JWTs are 3 dot-separated segments; API keys are `ak_live_<...>` opaque tokens. */
function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

async function authenticateClerk(req: NextRequest): Promise<Principal> {
  const token = bearerToken(req);
  if (!token) throw errors.unauthorized();

  const env = getEnv();
  let payload: Awaited<ReturnType<typeof verifyToken>>;
  try {
    payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
      ...(env.CLERK_JWT_KEY ? { jwtKey: env.CLERK_JWT_KEY } : {}),
    });
  } catch {
    throw errors.unauthorized();
  }

  const clerkUserId = payload.sub;
  if (!clerkUserId) throw errors.unauthorized();
  const emailClaim = (payload as Record<string, unknown>)["email"];
  const email = typeof emailClaim === "string" ? emailClaim : undefined;

  const existing = await prisma.user.findUnique({ where: { clerkUserId } });
  if (existing) {
    if (email && email !== existing.email) {
      await prisma.user.update({ where: { id: existing.id }, data: { email } });
    }
    return { kind: "user", userId: existing.id, clerkUserId };
  }

  try {
    const created = await prisma.user.create({ data: { clerkUserId, ...(email ? { email } : {}) } });
    try {
      await grantSignup(created.id);
    } catch (err) {
      logger().error({ err, userId: created.id }, "grantSignup failed for new user");
    }
    return { kind: "user", userId: created.id, clerkUserId };
  } catch (err) {
    // Concurrent first request for the same brand-new Clerk user: the loser re-fetches.
    if (isUniqueViolationOn(err, "User_clerkUserId_key")) {
      const user = await prisma.user.findUniqueOrThrow({ where: { clerkUserId } });
      return { kind: "user", userId: user.id, clerkUserId };
    }
    throw err;
  }
}

async function authenticateApiKey(req: NextRequest): Promise<Principal> {
  const token = bearerToken(req);
  if (!token || !token.startsWith("ak_live_")) throw errors.unauthorized();
  const hashedKey = sha256Hex(token);
  const key = await prisma.apiKey.findUnique({ where: { hashedKey } });
  if (!key || key.revokedAt) throw errors.unauthorized();
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return { kind: "apiKey", userId: key.userId, apiKeyId: key.id };
}

export const authenticator: Authenticator = async (req: NextRequest, mode: AuthMode): Promise<Principal> => {
  if (mode === "none") return { kind: "anonymous", userId: "" };
  if (mode === "clerk") return authenticateClerk(req);
  if (mode === "apiKey") return authenticateApiKey(req);
  // mode === "any"
  const token = bearerToken(req);
  if (!token) throw errors.unauthorized();
  return looksLikeJwt(token) ? authenticateClerk(req) : authenticateApiKey(req);
};

/** Returns the plaintext key ONCE (prefix `ak_live_`, 32 random bytes base64url); only the hash is stored. */
export async function createApiKey(userId: string, name: string): Promise<{ id: string; plaintext: string; prefix: string }> {
  const plaintext = `ak_live_${randomBytes(32).toString("base64url")}`;
  const hashedKey = sha256Hex(plaintext);
  const prefix = plaintext.slice(0, 12);
  const key = await prisma.apiKey.create({ data: { userId, name, prefix, hashedKey } });
  return { id: key.id, plaintext, prefix };
}
