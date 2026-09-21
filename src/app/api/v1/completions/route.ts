import { PublicCompletionRequest, PublicCompletionResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { createCompletion } from "@/services/public";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route({ auth: "apiKey", body: PublicCompletionRequest, response: PublicCompletionResponse, status: 202 }, async (ctx) =>
  createCompletion(ctx.principal.userId, ctx.body, ctx.idempotencyKey),
);
