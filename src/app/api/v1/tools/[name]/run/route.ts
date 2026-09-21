import { z } from "zod";
import { PublicToolRunRequest, PublicToolRunResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { startToolRun } from "@/services/public";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const Params = z.object({ name: z.string() });

export const POST = route({ auth: "apiKey", params: Params, body: PublicToolRunRequest, response: PublicToolRunResponse, status: 202 }, async (ctx) =>
  startToolRun(ctx.principal.userId, ctx.params.name, ctx.body),
);
