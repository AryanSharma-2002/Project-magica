import { CreateAssemblyRequest, CreateAssemblyResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { createAssembly } from "@/services/attachments";

export { OPTIONS } from "@/lib/http";
export const runtime = "nodejs";

export const POST = route({ auth: "clerk", body: CreateAssemblyRequest, response: CreateAssemblyResponse }, async (ctx) =>
  createAssembly({ userId: ctx.principal.userId, body: ctx.body }),
);
