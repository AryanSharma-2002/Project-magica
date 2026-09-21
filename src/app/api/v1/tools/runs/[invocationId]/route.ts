import { z } from "zod";
import { ToolInvocation } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { getToolRun } from "@/services/public";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const Params = z.object({ invocationId: z.string() });

export const GET = route({ auth: "any", params: Params, response: ToolInvocation }, async (ctx) => getToolRun(ctx.principal.userId, ctx.params.invocationId));
