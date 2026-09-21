/**
 * Generates docs/openapi.json from the Zod contracts (single source of truth).
 * Run: pnpm docs:openapi
 */
import { writeFileSync } from "node:fs";
import { z } from "zod";
import * as c from "../packages/contracts/src/index";

type Op = {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  summary: string;
  description?: string;
  tag: string;
  auth: "clerk" | "apiKey" | "any" | "none";
  params?: string[];
  query?: z.ZodType;
  body?: z.ZodType;
  response?: z.ZodType;
  status?: number;
  idempotent?: boolean;
};

const ops: Op[] = [
  { method: "get", path: "/health", summary: "Health check", tag: "System", auth: "none", response: z.object({ ok: z.literal(true), service: z.string(), time: z.string() }) },
  { method: "get", path: "/config", summary: "Product configuration", description: "Backend-owned limits, models, tool descriptors and skills. Frontends must read limits from here.", tag: "System", auth: "any", response: c.AppConfig },
  { method: "get", path: "/chats", summary: "List chats", description: "Cursor-paginated, newest activity first. Pinned chats can be filtered.", tag: "Chats", auth: "clerk", query: c.ListChatsQuery, response: c.ListChatsResponse },
  { method: "post", path: "/chats", summary: "Create chat", tag: "Chats", auth: "clerk", body: c.CreateChatRequest, response: c.Chat, status: 201 },
  { method: "get", path: "/chats/{chatId}", summary: "Get chat", description: "Includes `activeRunId` for reload recovery.", tag: "Chats", auth: "clerk", params: ["chatId"], response: c.Chat },
  { method: "patch", path: "/chats/{chatId}", summary: "Rename or pin chat", tag: "Chats", auth: "clerk", params: ["chatId"], body: c.UpdateChatRequest, response: c.Chat },
  { method: "delete", path: "/chats/{chatId}", summary: "Delete chat", description: "Soft delete; cancels an active run.", tag: "Chats", auth: "clerk", params: ["chatId"], status: 204 },
  { method: "get", path: "/chats/{chatId}/messages", summary: "List messages", description: "Newest first. Use `nextCursor` to load older messages.", tag: "Messages", auth: "clerk", params: ["chatId"], query: c.ListMessagesQuery, response: c.ListMessagesResponse },
  { method: "post", path: "/chats/{chatId}/messages", summary: "Send message (start agent run)", description: "Validates, reserves admission credits, persists the user turn and dispatches ONE durable run. Returns quickly with realtime access. Send an `Idempotency-Key` header to make retries safe.", tag: "Messages", auth: "clerk", params: ["chatId"], body: c.SendMessageRequest, response: c.SendMessageResponse, status: 202, idempotent: true },
  { method: "get", path: "/runs/{runId}", summary: "Get run", description: "Durable run state: status, tool invocations, waitpoint, usage, credits, safe error.", tag: "Runs", auth: "any", params: ["runId"], response: c.GetRunResponse },
  { method: "post", path: "/runs/{runId}/cancel", summary: "Cancel run", description: "Cooperative: the run finalizes as `cancelled` with partial output preserved.", tag: "Runs", auth: "clerk", params: ["runId"], response: c.CancelRunResponse },
  { method: "post", path: "/runs/{runId}/realtime-token", summary: "Refresh realtime token", tag: "Runs", auth: "clerk", params: ["runId"], response: c.RealtimeTokenResponse },
  { method: "post", path: "/waitpoints/{waitpointId}/complete", summary: "Complete waitpoint", description: "Idempotent. Resolves a human decision (approval, options, plan, credit). Duplicate submissions return the same result.", tag: "Waitpoints", auth: "clerk", params: ["waitpointId"], body: c.CompleteWaitpointRequest, response: c.CompleteWaitpointResponse },
  { method: "post", path: "/attachments/assembly", summary: "Create signed upload assembly", description: "Returns signed Transloadit Assembly params for Uppy. Secrets never leave the server.", tag: "Attachments", auth: "clerk", body: c.CreateAssemblyRequest, response: c.CreateAssemblyResponse, status: 201 },
  { method: "post", path: "/attachments/uploaded", summary: "Mark uploads complete", tag: "Attachments", auth: "clerk", body: c.AttachmentUploadedRequest, response: z.object({ ok: z.literal(true) }) },
  { method: "get", path: "/attachments", summary: "List media library", tag: "Attachments", auth: "clerk", query: c.ListAttachmentsQuery, response: c.ListAttachmentsResponse },
  { method: "get", path: "/credits/balance", summary: "Credit balance", tag: "Credits", auth: "clerk", response: c.BalanceResponse },
  { method: "get", path: "/credits/ledger", summary: "Credit ledger", tag: "Credits", auth: "clerk", query: c.CursorQuery, response: c.ListLedgerResponse },
  { method: "get", path: "/search", summary: "Search chats and messages", tag: "Search", auth: "clerk", query: c.SearchQuery, response: c.SearchResponse },
  // ---- public API ----
  { method: "get", path: "/api-keys", summary: "List API keys", description: "Plaintext keys are never returned here; revoked keys carry `revokedAt`.", tag: "API keys", auth: "clerk", response: c.ListApiKeysResponse },
  { method: "post", path: "/api-keys", summary: "Create API key", description: "Returns the plaintext `key` ONCE. Only its SHA-256 is stored. Requires a Clerk session: a key cannot mint keys.", tag: "API keys", auth: "clerk", body: c.CreateApiKeyRequest, response: c.ApiKey, status: 201 },
  { method: "delete", path: "/api-keys/{keyId}", summary: "Revoke API key", description: "Idempotent. Requests with a revoked key fail with 401.", tag: "API keys", auth: "clerk", params: ["keyId"], status: 204 },
  { method: "post", path: "/completions", summary: "Start an agent turn (public API)", description: "Creates a chat (unless `chatId` is given), attaches any `attachmentUrls` as ready library attachments, persists the user turn and dispatches ONE durable run. Poll `statusUrl` or subscribe to webhooks. Send an `Idempotency-Key` header to make retries safe.", tag: "Public API", auth: "apiKey", body: c.PublicCompletionRequest, response: c.PublicCompletionResponse, status: 202, idempotent: true },
  { method: "post", path: "/tools/{name}/run", summary: "Run a media tool directly (public API)", description: "Standalone Magica tool invocation without a conversation: `crop_image`, `gpt_image_2` or `merge_videos`. The estimate is reserved up front and settled to the actual charge; no approval waitpoint applies.", tag: "Public API", auth: "apiKey", params: ["name"], body: c.PublicToolRunRequest, response: c.PublicToolRunResponse, status: 202 },
  { method: "get", path: "/tools/runs/{invocationId}", summary: "Get a standalone tool run", tag: "Public API", auth: "any", params: ["invocationId"], response: c.ToolInvocation },
  { method: "get", path: "/webhooks", summary: "List webhook endpoints", description: "Secrets are never returned here.", tag: "Webhooks", auth: "any", response: c.ListWebhooksResponse },
  { method: "post", path: "/webhooks", summary: "Create webhook endpoint", description: "Returns the signing `secret` ONCE. URLs must be https and public (no loopback/private/link-local targets).", tag: "Webhooks", auth: "any", body: c.CreateWebhookRequest, response: c.WebhookEndpoint, status: 201 },
  { method: "delete", path: "/webhooks/{endpointId}", summary: "Delete webhook endpoint", tag: "Webhooks", auth: "any", params: ["endpointId"], status: 204 },
];

function schema(s: z.ZodType, io: "input" | "output") {
  const json = z.toJSONSchema(s, { target: "openapi-3.0", io, unrepresentable: "any" }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

function queryParams(q: z.ZodType) {
  const json = schema(q, "input") as { properties?: Record<string, unknown>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, sch]) => ({ name, in: "query", required: json.required?.includes(name) ?? false, schema: sch }));
}

const errorResponse = { description: "Error", content: { "application/json": { schema: schema(c.ApiErrorEnvelope, "output") } } };
const security = (auth: Op["auth"]) => (auth === "none" ? [] : auth === "clerk" ? [{ clerkSession: [] }] : auth === "apiKey" ? [{ apiKey: [] }] : [{ clerkSession: [] }, { apiKey: [] }]);

const paths: Record<string, Record<string, unknown>> = {};
for (const op of ops) {
  const parameters = [
    ...(op.params ?? []).map((p) => ({ name: p, in: "path", required: true, schema: { type: "string" } })),
    ...(op.query ? queryParams(op.query) : []),
    ...(op.idempotent ? [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" }, description: "Makes retries safe; the same key returns the original result." }] : []),
  ];
  const responses: Record<string, unknown> = {
    [String(op.status ?? 200)]: op.response ? { description: "Success", content: { "application/json": { schema: schema(op.response, "output") } } } : { description: "No content" },
    "400": errorResponse,
    "401": errorResponse,
    "404": errorResponse,
    "409": errorResponse,
    "429": errorResponse,
  };
  const pathItem = (paths[op.path] ??= {});
  pathItem[op.method] = {
    summary: op.summary,
    description: op.description,
    tags: [op.tag],
    operationId: `${op.method}${op.path.replace(/[{}]/g, "").split("/").filter(Boolean).map((s) => s[0]!.toUpperCase() + s.slice(1)).join("")}`,
    security: security(op.auth),
    parameters,
    ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(op.body, "input") } } } } : {}),
    responses,
  };
}

const doc = {
  openapi: "3.0.3",
  info: {
    title: "Agent Chat API",
    version: "1.0.0",
    description: "Versioned REST API for agent conversations, durable runs, human waitpoints, attachments, credits and Magica tool execution. All shapes are generated from the Zod contracts in packages/contracts.",
  },
  // OPENAPI_BASE_URL (e.g. the Vercel deployment) becomes the default server so the hosted Mintlify
  // reference can call the live API; localhost stays the fallback for local docs.
  servers: [{ url: "{baseUrl}/api/v1", variables: { baseUrl: { default: process.env.OPENAPI_BASE_URL ?? "http://localhost:3001" } } }],
  tags: [...new Set(ops.map((o) => o.tag))].map((name) => ({ name })),
  components: {
    securitySchemes: {
      clerkSession: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Clerk session token (first-party web app)." },
      apiKey: { type: "http", scheme: "bearer", description: "API key `ak_live_…` (public API)." },
    },
    schemas: {
      ContentBlock: schema(c.ContentBlock, "output"),
      SafeError: schema(c.SafeError, "output"),
      WebhookEvent: schema(c.WebhookEvent, "output"),
      RunMetadata: schema(c.RunMetadata, "output"),
      TextChunk: schema(c.TextChunk, "output"),
    },
  },
  paths,
};

writeFileSync(new URL("../docs/openapi.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n");
console.log(`openapi.json: ${ops.length} operations`);
