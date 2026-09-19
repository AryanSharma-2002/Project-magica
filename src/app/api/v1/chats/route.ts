import { Chat, CreateChatRequest, ListChatsQuery, ListChatsResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { assertChatMutationRateLimit } from "@/lib/rate-limit";
import { createChat, listChats } from "@/services/chats";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route({ auth: "clerk", query: ListChatsQuery, response: ListChatsResponse }, async (ctx) => listChats(ctx.principal.userId, ctx.query));

export const POST = route({ auth: "clerk", body: CreateChatRequest, response: Chat }, async (ctx) => {
  await assertChatMutationRateLimit(ctx.principal.userId);
  return createChat(ctx.principal.userId, ctx.body);
});
