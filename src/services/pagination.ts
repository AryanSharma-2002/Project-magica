import { decodeCursor, encodeCursor } from "@agent-chat/contracts";
import { errors } from "@/lib/errors";

/**
 * Cursor pagination helpers around `encodeCursor`/`decodeCursor` (isomorphic, base64url of
 * `createdAt|id`). Every list query uses keyset pagination on `(createdAt, id)` — no offset,
 * no unbounded scans — and always fetches `limit + 1` rows to compute `nextCursor`.
 */

export type KeysetCursor = { createdAt: Date; id: string };

/** Decodes and validates a client-supplied cursor. Throws `validation_error` on garbage input. */
export function parseCursor(cursor: string | undefined): KeysetCursor | null {
  if (!cursor) return null;
  const decoded = decodeCursor(cursor);
  if (!decoded) throw errors.validation("Invalid cursor");
  return decoded;
}

/** Splits `rows` (fetched with `take: limit + 1`) into a page + `nextCursor`. */
export function paginate<T extends { createdAt: Date; id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? encodeCursor(lastItem.createdAt, lastItem.id) : null;
  return { items, nextCursor };
}

/**
 * Prisma `where` fragment for keyset pagination on `(createdAt, id)`.
 * `"desc"` = newest-first (strictly older than cursor); `"asc"` = oldest-first (strictly newer than cursor).
 * Generic over the caller's Prisma `WhereInput` type (e.g. `Prisma.MessageWhereInput`); the shape is
 * always the same two-branch OR, so a single deliberate cast here keeps every call site type-safe.
 */
export function keysetWhere<W extends object>(cursor: KeysetCursor | null, direction: "asc" | "desc"): Partial<W> {
  if (!cursor) return {} as Partial<W>;
  const clause =
    direction === "desc"
      ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
      : { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] };
  return clause as unknown as Partial<W>;
}

/** Matching `orderBy` for `keysetWhere`, generic over the caller's Prisma `OrderByWithRelationInput` type. */
export function keysetOrderBy<O extends object>(direction: "asc" | "desc"): O[] {
  return [{ createdAt: direction }, { id: direction }] as unknown as O[];
}
