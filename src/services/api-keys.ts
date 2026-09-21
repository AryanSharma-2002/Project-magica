import type { ApiKey, ListApiKeysResponse } from "@agent-chat/contracts";
import { prisma } from "@/lib/db";
import { errors } from "@/lib/errors";
import { createApiKey } from "@/lib/auth/index";
import type { ApiKey as DbApiKey } from "@/generated/prisma/client";

/**
 * API-key management (Clerk-session only — an API key must never be able to mint or revoke keys;
 * enforced at the route layer with `auth: "clerk"`). `createApiKey` (src/lib/auth/index.ts) does
 * the actual generation/hashing; this module is persistence + serialization only.
 */

function serialize(row: DbApiKey, plaintext?: string): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    // exactOptionalPropertyTypes: omit the key entirely rather than `key: undefined`.
    ...(plaintext !== undefined ? { key: plaintext } : {}),
  };
}

/** Returns the plaintext key ONCE; only its SHA-256 hash is ever persisted. */
export async function createKey(userId: string, name: string): Promise<ApiKey> {
  const { id, plaintext } = await createApiKey(userId, name);
  const row = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
  return serialize(row, plaintext);
}

/** Includes revoked keys; never returns plaintext. */
export async function listKeys(userId: string): Promise<ListApiKeysResponse> {
  const rows = await prisma.apiKey.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return { items: rows.map((row) => serialize(row)) };
}

/** Idempotent: revoking an already-revoked key is a no-op. Another user's key -> not_found (non-leaking). */
export async function revokeKey(userId: string, keyId: string): Promise<void> {
  const row = await prisma.apiKey.findUnique({ where: { id: keyId } });
  if (!row || row.userId !== userId) throw errors.notFound("API key");
  if (row.revokedAt) return;
  await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
}
