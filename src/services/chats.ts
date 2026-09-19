import type { z } from "zod";
import { ListChatsResponse, encodeCursor, type Chat, type CreateChatRequest, type ListChatsQuery, type UpdateChatRequest } from "@agent-chat/contracts";
import { prisma, Prisma } from "@/lib/db";
import { errors } from "@/lib/errors";
import { serializeChat } from "@/services/serializers";
import { parseCursor } from "@/services/pagination";
import type { Chat as DbChat, RunStatus as RunStatusDb } from "@/generated/prisma/client";

/** `ListChatsResponse` (from `Page(Chat)`) has no paired `export type`; derive it here. */
type ListChatsPage = z.infer<typeof ListChatsResponse>;

/** Prisma RunStatus values considered "active" for an AgentRun (mirrors ACTIVE_RUN_STATUSES). */
const ACTIVE_RUN_DB: RunStatusDb[] = ["QUEUED", "RUNNING", "WAITING", "STOPPING"];

async function activeRunIdsByChat(chatIds: string[]): Promise<Map<string, string>> {
  if (chatIds.length === 0) return new Map();
  const runs = await prisma.agentRun.findMany({
    where: { chatId: { in: chatIds }, status: { in: ACTIVE_RUN_DB } },
    select: { id: true, chatId: true },
  });
  return new Map(runs.map((r) => [r.chatId, r.id]));
}

function sortKey(row: DbChat): Date {
  return row.lastMessageAt ?? row.createdAt;
}

/**
 * Chats page on `COALESCE(lastMessageAt, createdAt) DESC, id DESC` — a single total order that
 * "newest activity first" and "id" keyset pagination both need. Prisma can't order by an
 * expression, so the list query is raw SQL; everything else is the ORM.
 */
export async function listChats(userId: string, query: ListChatsQuery): Promise<ListChatsPage> {
  const decoded = parseCursor(query.cursor);
  const conditions = [Prisma.sql`"userId" = ${userId}`, Prisma.sql`"deletedAt" IS NULL`];
  if (query.pinned !== undefined) conditions.push(Prisma.sql`"pinned" = ${query.pinned}`);
  if (query.q) conditions.push(Prisma.sql`"title" ILIKE ${`%${query.q}%`}`);
  if (decoded) conditions.push(Prisma.sql`(COALESCE("lastMessageAt", "createdAt"), "id") < (${decoded.createdAt}, ${decoded.id})`);

  const rows = await prisma.$queryRaw<DbChat[]>(Prisma.sql`
    SELECT * FROM "Chat"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY COALESCE("lastMessageAt", "createdAt") DESC, "id" DESC
    LIMIT ${query.limit + 1}
  `);

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(sortKey(last), last.id) : null;

  const activeByChatId = await activeRunIdsByChat(items.map((c) => c.id));
  return { items: items.map((c) => serializeChat(c, activeByChatId.get(c.id) ?? null)), nextCursor };
}

export async function createChat(userId: string, req: CreateChatRequest): Promise<Chat> {
  const chat = await prisma.chat.create({ data: { userId, ...(req.title !== undefined ? { title: req.title } : {}) } });
  return serializeChat(chat, null);
}

async function requireOwnedChat(userId: string, chatId: string): Promise<DbChat> {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId, deletedAt: null } });
  if (!chat) throw errors.notFound("Chat");
  return chat;
}

export async function getChat(userId: string, chatId: string): Promise<Chat> {
  const chat = await requireOwnedChat(userId, chatId);
  const activeRun = await prisma.agentRun.findFirst({ where: { chatId, status: { in: ACTIVE_RUN_DB } } });
  return serializeChat(chat, activeRun?.id ?? null);
}

export async function updateChat(userId: string, chatId: string, req: UpdateChatRequest): Promise<Chat> {
  await requireOwnedChat(userId, chatId);
  const updated = await prisma.chat.update({
    where: { id: chatId },
    data: {
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.pinned !== undefined ? { pinned: req.pinned } : {}),
    },
  });
  const activeRun = await prisma.agentRun.findFirst({ where: { chatId, status: { in: ACTIVE_RUN_DB } } });
  return serializeChat(updated, activeRun?.id ?? null);
}

/** Soft delete; an active run on the chat is asked to stop (STOPPING) rather than deleted. */
export async function deleteChat(userId: string, chatId: string): Promise<void> {
  await requireOwnedChat(userId, chatId);
  await prisma.$transaction(async (tx) => {
    await tx.chat.update({ where: { id: chatId }, data: { deletedAt: new Date() } });
    await tx.agentRun.updateMany({
      where: { chatId, status: { in: ["QUEUED", "RUNNING", "WAITING"] } },
      data: { status: "STOPPING", cancelRequestedAt: new Date() },
    });
  });
}
