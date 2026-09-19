import { z } from "zod";
import { CancelRunResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { cancelRun } from "@/services/runs";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const Params = z.object({ runId: z.string() });

export const POST = route({ auth: "clerk", params: Params, response: CancelRunResponse }, async (ctx) => cancelRun(ctx.principal.userId, ctx.params.runId));
