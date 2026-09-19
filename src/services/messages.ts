import type { z } from "zod";
import { ListMessagesResponse, type ListMessagesQuery } from "@agent-chat/contracts";
import { prisma, Prisma } from "@/lib/db";
import { errors } from "@/lib/errors";
import { serializeMessage } from "@/services/serializers";
import { keysetOrderBy, keysetWhere, paginate, parseCursor } from "@/services/pagination";

/** `ListMessagesResponse` (from `Page(Message)`) has no paired `export type`; derive it here. */
type ListMessagesPage = z.infer<typeof ListMessagesResponse>;

/** Newest-first keyset page of a chat's messages; `nextCursor` (if present) points to older messages. */
export async function listMessages(userId: string, chatId: string, query: ListMessagesQuery): Promise<ListMessagesPage> {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, userId, deletedAt: null } });
  if (!chat) throw errors.notFound("Chat");

  const decoded = parseCursor(query.cursor);
  const rows = await prisma.message.findMany({
    where: { chatId, ...keysetWhere<Prisma.MessageWhereInput>(decoded, "desc") },
    orderBy: keysetOrderBy<Prisma.MessageOrderByWithRelationInput>("desc"),
    take: query.limit + 1,
    include: { attachments: { orderBy: { position: "asc" } } },
  });

  const page = paginate(rows, query.limit);
  return { items: page.items.map((m) => serializeMessage(m, m.attachments)), nextCursor: page.nextCursor };
}
