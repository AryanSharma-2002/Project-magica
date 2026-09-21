import { z } from "zod";
import { route } from "@/lib/http";
import { deleteEndpoint } from "@/services/webhooks";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const Params = z.object({ endpointId: z.string() });

export const DELETE = route({ auth: "any", params: Params, response: z.undefined(), status: 204 }, async (ctx) => {
  await deleteEndpoint(ctx.principal.userId, ctx.params.endpointId);
  return undefined;
});
