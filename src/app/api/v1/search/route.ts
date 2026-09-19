import { SearchQuery, SearchResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { search } from "@/services/search";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route({ auth: "clerk", query: SearchQuery, response: SearchResponse }, async (ctx) => search(ctx.principal.userId, ctx.query));
