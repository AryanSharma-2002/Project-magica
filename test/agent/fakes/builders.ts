import type { Attachment, ContentBlock, Message } from "@agent-chat/contracts";
import type { RunRecord } from "@/agent/loop/ports";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: nextId("att"),
    kind: "image",
    source: "upload",
    status: "ready",
    filename: "file.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    url: "https://example.com/a.png",
    previewUrl: null,
    width: 100,
    height: 100,
    durationMs: null,
    position: 0,
    assemblyId: null,
    expiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: nextId("msg"),
    chatId: "chat_1",
    role: "user",
    status: "completed",
    content: [],
    runId: null,
    attachments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function userMessage(text: string, overrides: Partial<Message> = {}): Message {
  const block: ContentBlock = { type: "text", text };
  return makeMessage({ role: "user", content: [block], ...overrides });
}

export function assistantMessage(content: ContentBlock[], overrides: Partial<Message> = {}): Message {
  return makeMessage({ role: "assistant", content, ...overrides });
}

export function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: nextId("run"),
    chatId: "chat_1",
    userId: "user_1",
    userMessageId: nextId("msg"),
    assistantMessageId: nextId("msg"),
    status: "running",
    planMode: false,
    requestedModel: "openrouter/free",
    microcreditsReserved: 0,
    cancelRequestedAt: null,
    ...overrides,
  };
}
