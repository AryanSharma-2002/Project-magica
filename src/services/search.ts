import type { z } from "zod";
import { SearchResponse, encodeCursor, type SearchQuery } from "@agent-chat/contracts";
import { prisma, Prisma } from "@/lib/db";
import { parseCursor } from "@/services/pagination";

type HitRow = { chatId: string; chatTitle: string; messageId: string | null; snippet: string; createdAt: Date; sortId: string };

/** `SearchResponse` (from `Page(SearchHit)`) has no paired `export type`; derive it here. */
type SearchPage = z.infer<typeof SearchResponse>;

/**
 * Unions full-text message hits (`searchVector @@ websearch_to_tsquery`, snippet via `ts_headline`)
 * with chat-title hits (trigram-backed ILIKE), owner-scoped, then keyset-paginates the combined
 * stream on `(createdAt, sortId)` where `sortId = messageId ?? chatId` (SearchHit has no single id
 * of its own to page on).
 */
export async function search(userId: string, query: SearchQuery): Promise<SearchPage> {
  const decoded = parseCursor(query.cursor);
  const cursorClause = decoded
    ? Prisma.sql`AND ("createdAt", "sortId") < (${decoded.createdAt}, ${decoded.id})`
    : Prisma.empty;
  const like = `%${query.q}%`;

  const rows = await prisma.$queryRaw<HitRow[]>(Prisma.sql`
    SELECT * FROM (
      SELECT
        m."chatId" AS "chatId",
        c."title" AS "chatTitle",
        m."id" AS "messageId",
        ts_headline('english', m."textContent", websearch_to_tsquery('english', ${query.q}), 'MaxFragments=1,MaxWords=35,MinWords=15') AS snippet,
        m."createdAt" AS "createdAt",
        m."id" AS "sortId"
      FROM "Message" m
      JOIN "Chat" c ON c."id" = m."chatId"
      WHERE c."userId" = ${userId} AND c."deletedAt" IS NULL
        AND m."searchVector" @@ websearch_to_tsquery('english', ${query.q})
      UNION ALL
      SELECT
        c."id" AS "chatId",
        c."title" AS "chatTitle",
        NULL::text AS "messageId",
        c."title" AS snippet,
        c."createdAt" AS "createdAt",
        c."id" AS "sortId"
      FROM "Chat" c
      WHERE c."userId" = ${userId} AND c."deletedAt" IS NULL AND c."title" ILIKE ${like}
    ) AS hits
    WHERE true ${cursorClause}
    ORDER BY "createdAt" DESC, "sortId" DESC
    LIMIT ${query.limit + 1}
  `);

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.sortId) : null;

  return {
    items: items.map((r) => ({
      chatId: r.chatId,
      chatTitle: r.chatTitle,
      messageId: r.messageId,
      snippet: r.snippet.slice(0, 500),
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
  };
}
