import { prisma, Prisma } from "@/lib/db";
import { errors } from "@/lib/errors";

/**
 * DB token bucket on `RateLimitBucket`, refilled continuously and consumed atomically in ONE
 * raw SQL statement (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`). The row lock Postgres
 * takes to evaluate the `ON CONFLICT DO UPDATE` SET expressions makes the refill+consume
 * read-modify-write race-free under concurrent requests for the same key.
 *
 * Stored `tokens` is allowed to go negative: a request that finds fewer than 1 token available
 * still writes `refilled - 1` (a negative number) instead of clamping to 0. This makes "was this
 * request allowed?" derivable purely from the sign of the returned value (`tokens >= 0`), with no
 * second column needed to disambiguate "denied, refilled to 0" from "allowed, spent down to 0".
 * The next refill treats a negative balance as 0 (`GREATEST(tokens, 0)`) so it doesn't have to dig
 * out of an arbitrarily deep hole.
 */

export type RateLimitArgs = { key: string; limit: number; windowSeconds: number };

const DEFAULT_POLICIES = {
  send: { limit: 20, windowSeconds: 60 },
  chatMutation: { limit: 60, windowSeconds: 60 },
} as const;

export async function assertRateLimit({ key, limit, windowSeconds }: RateLimitArgs): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ tokens: number }>>(Prisma.sql`
    INSERT INTO "RateLimitBucket" AS b (key, tokens, "updatedAt")
    VALUES (${key}, ${limit - 1}, timezone('utc', now()))
    ON CONFLICT (key) DO UPDATE SET
      tokens = FLOOR(
        LEAST(
          ${limit}::float8,
          GREATEST(b.tokens, 0)::float8 + GREATEST(EXTRACT(EPOCH FROM (timezone('utc', now()) - b."updatedAt")), 0) * ${limit}::float8 / ${windowSeconds}::float8
        ) - 1
      )::int,
      "updatedAt" = timezone('utc', now())
    RETURNING tokens
  `);
  const row = rows[0];
  const tokens = row ? row.tokens : -1;
  if (tokens < 0) {
    const retryAfterSeconds = Math.max(1, Math.ceil((-tokens * windowSeconds) / limit));
    throw errors.rateLimited(retryAfterSeconds);
  }
}

export async function assertSendRateLimit(userId: string): Promise<void> {
  await assertRateLimit({ key: `send:${userId}`, ...DEFAULT_POLICIES.send });
}

export async function assertChatMutationRateLimit(userId: string): Promise<void> {
  await assertRateLimit({ key: `chat-mutation:${userId}`, ...DEFAULT_POLICIES.chatMutation });
}
