import { BalanceResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { balance } from "@/lib/credits";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route({ auth: "clerk", response: BalanceResponse }, async (ctx) => ({
  microcredits: await balance(ctx.principal.userId),
  updatedAt: new Date().toISOString(),
}));
