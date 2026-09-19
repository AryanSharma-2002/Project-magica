import { z } from "zod";
import { GetRunResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { getRun } from "@/services/runs";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const Params = z.object({ runId: z.string() });

export const GET = route({ auth: "any", params: Params, response: GetRunResponse }, async (ctx) => getRun(ctx.principal.userId, ctx.params.runId));
