import { z } from "zod";
import { Chat, UpdateChatRequest } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { assertChatMutationRateLimit } from "@/lib/rate-limit";
import { deleteChat, getChat, updateChat } from "@/services/chats";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const Params = z.object({ chatId: z.string() });

export const GET = route({ auth: "clerk", params: Params, response: Chat }, async (ctx) => getChat(ctx.principal.userId, ctx.params.chatId));

export const PATCH = route({ auth: "clerk", params: Params, body: UpdateChatRequest, response: Chat }, async (ctx) => {
  await assertChatMutationRateLimit(ctx.principal.userId);
  return updateChat(ctx.principal.userId, ctx.params.chatId, ctx.body);
});

export const DELETE = route({ auth: "clerk", params: Params, response: z.undefined(), status: 204 }, async (ctx) => {
  await assertChatMutationRateLimit(ctx.principal.userId);
  await deleteChat(ctx.principal.userId, ctx.params.chatId);
  return undefined;
});
