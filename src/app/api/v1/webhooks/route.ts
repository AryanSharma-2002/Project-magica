import { CreateWebhookRequest, ListWebhooksResponse, WebhookEndpoint } from "@agent-chat/contracts";
import { route } from "@/lib/http";
import { createEndpoint, listEndpoints } from "@/services/webhooks";
export { OPTIONS } from "@/lib/http";

export const runtime = "nodejs";

export const GET = route({ auth: "any", response: ListWebhooksResponse }, async (ctx) => listEndpoints(ctx.principal.userId));

export const POST = route({ auth: "any", body: CreateWebhookRequest, response: WebhookEndpoint, status: 201 }, async (ctx) =>
  createEndpoint(ctx.principal.userId, ctx.body),
);
