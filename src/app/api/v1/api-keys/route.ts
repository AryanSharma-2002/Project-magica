import { ApiKey, CreateApiKeyRequest, ListApiKeysResponse } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { createKey, listKeys } from "@/services/api-keys";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

// clerk only: an API key must never be able to mint or revoke keys.
export const GET = route({ auth: "clerk", response: ListApiKeysResponse }, async (ctx) => listKeys(ctx.principal.userId));

export const POST = route({ auth: "clerk", body: CreateApiKeyRequest, response: ApiKey, status: 201 }, async (ctx) =>
  createKey(ctx.principal.userId, ctx.body.name),
);
