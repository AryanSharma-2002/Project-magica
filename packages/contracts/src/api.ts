import { z } from "zod";
import { Id, IsoDate, JsonValue, Microcredits } from "./primitives";
import { AgentRun, Attachment, Chat, LedgerEntry, Message, SkillDescriptor } from "./entities";
import { CursorQuery, Page } from "./pagination";
import { RealtimeAccess } from "./realtime";
import { WaitpointResolution, Waitpoint } from "./waitpoints";
import { AppLimits, ModelInfo, OPENROUTER_FREE_MODEL } from "./limits";
import { ToolDescriptor } from "./tools";
import { AttachmentKind, WebhookEventType } from "./enums";

export const API_PREFIX = "/api/v1" as const;
export const IDEMPOTENCY_HEADER = "idempotency-key" as const;

// ---- config ----
export const AppConfig = z.object({ limits: AppLimits, models: z.array(ModelInfo), tools: z.array(ToolDescriptor), skills: z.array(SkillDescriptor) });
export type AppConfig = z.infer<typeof AppConfig>;

// ---- chats ----
export const ListChatsQuery = CursorQuery.extend({ pinned: z.stringbool().optional(), q: z.string().max(200).optional() });
export const ListChatsResponse = Page(Chat);
export type ListChatsResponse = z.infer<typeof ListChatsResponse>;
export const CreateChatRequest = z.object({ title: z.string().min(1).max(200).optional() });
export const UpdateChatRequest = z.object({ title: z.string().min(1).max(200).optional(), pinned: z.boolean().optional() }).refine((v) => v.title !== undefined || v.pinned !== undefined, "Nothing to update");
export type ListChatsQuery = z.infer<typeof ListChatsQuery>;
export type CreateChatRequest = z.infer<typeof CreateChatRequest>;
export type UpdateChatRequest = z.infer<typeof UpdateChatRequest>;

// ---- messages ----
export const ListMessagesQuery = CursorQuery;
export const ListMessagesResponse = Page(Message);
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;

export const SendMessageRequest = z.object({
  text: z.string().max(20_000),
  attachmentIds: z.array(Id).max(10).default([]),
  model: z.literal(OPENROUTER_FREE_MODEL).default(OPENROUTER_FREE_MODEL),
  planMode: z.boolean().default(false),
}).refine((v) => v.text.trim().length > 0 || v.attachmentIds.length > 0, "Message must contain text or attachments");
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendMessageResponse = z.object({
  chatId: Id,
  messageId: Id,
  assistantMessageId: Id,
  runId: Id,
  realtime: RealtimeAccess,
  /** true when the Idempotency-Key matched an existing dispatch */
  deduplicated: z.boolean(),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

// ---- runs ----
export const GetRunResponse = AgentRun;
export const CancelRunResponse = AgentRun;
export const RealtimeTokenResponse = RealtimeAccess;

// ---- waitpoints ----
export const CompleteWaitpointRequest = z.object({ resolution: WaitpointResolution });
export const CompleteWaitpointResponse = Waitpoint;
export type CompleteWaitpointRequest = z.infer<typeof CompleteWaitpointRequest>;

// ---- attachments ----
export const FileMeta = z.object({
  clientId: z.string().min(1).max(64),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive(),
  position: z.number().int().nonnegative(),
});
export const CreateAssemblyRequest = z.object({ chatId: Id.optional(), files: z.array(FileMeta).min(1).max(10) });
export const CreateAssemblyResponse = z.object({
  /** Pass straight to Uppy Transloadit plugin: { params, signature }. params is the exact signed JSON string. */
  assemblyOptions: z.object({ params: z.string(), signature: z.string() }),
  expiresAt: IsoDate,
  /** Attachment rows pre-created in `uploading` state, keyed by clientId. */
  attachments: z.array(Attachment.extend({ clientId: z.string() })),
});
export type CreateAssemblyRequest = z.infer<typeof CreateAssemblyRequest>;
export type CreateAssemblyResponse = z.infer<typeof CreateAssemblyResponse>;

export const AttachmentUploadedRequest = z.object({
  assemblyId: z.string().min(1).max(128),
  /** Uppy result per file (tus upload URL / transloadit result). Server re-validates against the Assembly. */
  files: z.array(z.object({ attachmentId: Id, uploadUrl: z.string().url().optional() })).min(1).max(10),
});
export type AttachmentUploadedRequest = z.infer<typeof AttachmentUploadedRequest>;

export const ListAttachmentsQuery = CursorQuery.extend({ kind: AttachmentKind.optional(), source: z.enum(["upload", "library", "generated"]).optional() });
export const ListAttachmentsResponse = Page(Attachment);
export type ListAttachmentsQuery = z.infer<typeof ListAttachmentsQuery>;
export type ListAttachmentsResponse = z.infer<typeof ListAttachmentsResponse>;

// ---- credits ----
export const BalanceResponse = z.object({ microcredits: Microcredits, updatedAt: IsoDate });
export type BalanceResponse = z.infer<typeof BalanceResponse>;
export const ListLedgerResponse = Page(LedgerEntry);
export type ListLedgerResponse = z.infer<typeof ListLedgerResponse>;

// ---- search ----
export const SearchQuery = CursorQuery.extend({ q: z.string().min(1).max(200) });
export const SearchHit = z.object({ chatId: Id, chatTitle: z.string(), messageId: Id.nullable(), snippet: z.string().max(500), createdAt: IsoDate });
export const SearchResponse = Page(SearchHit);
export type SearchHit = z.infer<typeof SearchHit>;
export type SearchQuery = z.infer<typeof SearchQuery>;
export type SearchResponse = z.infer<typeof SearchResponse>;

// ---- public API (bonus) ----
export const PublicCompletionRequest = z.object({
  chatId: Id.optional(),
  message: z.string().min(1).max(20_000),
  attachmentUrls: z.array(z.string().url()).max(10).default([]),
  planMode: z.boolean().default(false),
});
export const PublicCompletionResponse = z.object({ chatId: Id, runId: Id, messageId: Id, assistantMessageId: Id, statusUrl: z.string() });
export const PublicToolRunRequest = z.object({ input: JsonValue });
export const PublicToolRunResponse = z.object({ invocationId: Id, status: z.string(), statusUrl: z.string() });

export const CreateWebhookRequest = z.object({ url: z.string().url().max(2048), events: z.array(WebhookEventType).min(1) });
export const WebhookEndpoint = z.object({ id: Id, url: z.string(), events: z.array(WebhookEventType), active: z.boolean(), createdAt: IsoDate, secret: z.string().optional() });
export const WebhookEvent = z.object({
  id: Id,
  type: WebhookEventType,
  createdAt: IsoDate,
  data: z.object({ runId: Id, chatId: Id, status: z.string(), toolInvocationId: Id.optional(), toolName: z.string().optional() }),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;
export type PublicCompletionRequest = z.infer<typeof PublicCompletionRequest>;
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequest>;
