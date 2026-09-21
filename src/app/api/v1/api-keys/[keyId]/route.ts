import { z } from "zod";
import { route } from "@/lib/http";
import { revokeKey } from "@/services/api-keys";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

const Params = z.object({ keyId: z.string() });

// clerk only: an API key must never be able to mint or revoke keys.
export const DELETE = route({ auth: "clerk", params: Params, response: z.undefined(), status: 204 }, async (ctx) => {
  await revokeKey(ctx.principal.userId, ctx.params.keyId);
  return undefined;
});
