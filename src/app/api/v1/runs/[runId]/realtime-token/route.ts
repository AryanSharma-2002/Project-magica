import { z } from "zod";
import { RealtimeTokenResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { realtimeToken } from "@/services/runs";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const Params = z.object({ runId: z.string() });

export const POST = route({ auth: "clerk", params: Params, response: RealtimeTokenResponse }, async (ctx) =>
  realtimeToken(ctx.principal.userId, ctx.params.runId),
);
