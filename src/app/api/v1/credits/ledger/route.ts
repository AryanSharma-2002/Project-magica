import { CursorQuery, ListLedgerResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { listLedger } from "@/lib/credits";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route({ auth: "clerk", query: CursorQuery, response: ListLedgerResponse }, async (ctx) =>
  listLedger(ctx.principal.userId, ctx.query.cursor, ctx.query.limit),
);
