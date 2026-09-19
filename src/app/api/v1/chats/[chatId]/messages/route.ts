import { z } from "zod";
import { ListMessagesQuery, ListMessagesResponse, SendMessageRequest, SendMessageResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { listMessages } from "@/services/messages";
import { sendMessage } from "@/services/send";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const Params = z.object({ chatId: z.string() });

export const GET = route({ auth: "clerk", params: Params, query: ListMessagesQuery, response: ListMessagesResponse }, async (ctx) =>
  listMessages(ctx.principal.userId, ctx.params.chatId, ctx.query),
);

export const POST = route({ auth: "clerk", params: Params, body: SendMessageRequest, response: SendMessageResponse }, async (ctx) =>
  sendMessage(ctx.principal.userId, ctx.params.chatId, ctx.body, ctx.idempotencyKey),
);
