import { z } from "zod";
import { CompleteWaitpointRequest, CompleteWaitpointResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { completeWaitpoint } from "@/services/runs";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const Params = z.object({ waitpointId: z.string() });

export const POST = route({ auth: "clerk", params: Params, body: CompleteWaitpointRequest, response: CompleteWaitpointResponse }, async (ctx) =>
  completeWaitpoint(ctx.principal.userId, ctx.params.waitpointId, ctx.body.resolution),
);
