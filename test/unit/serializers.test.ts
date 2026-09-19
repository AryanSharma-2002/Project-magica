import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { serializeAgentRun, serializeAttachment, serializeMessage } from "@/services/serializers";
import type { AgentRun as DbAgentRun, Attachment as DbAttachment, Message as DbMessage } from "@/generated/prisma/client";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function fakeAttachment(overrides: Partial<DbAttachment> = {}): DbAttachment {
  return {
    id: "att_1",
    userId: "user_1",
    chatId: null,
    messageId: null,
    toolInvocationId: null,
    kind: "IMAGE",
    source: "UPLOAD",
    status: "READY",
    filename: "a.png",
    mimeType: "image/png",
    sizeBytes: 100,
    width: null,
    height: null,
    durationMs: null,
    url: "https://example.com/a.png",
    previewUrl: null,
    storageKey: null,
    assemblyId: null,
    assemblyStatus: null,
    position: 0,
    expiresAt: null,
    meta: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as DbAttachment;
}

function fakeMessage(overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id: "msg_1",
    chatId: "chat_1",
    userId: "user_1",
    role: "ASSISTANT",
    status: "COMPLETED",
    content: [{ type: "text", text: "hi" }],
    textContent: "hi",
    runId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as DbMessage;
}

function fakeAgentRun(overrides: Partial<DbAgentRun> = {}): DbAgentRun {
  return {
    id: "run_1",
    chatId: "chat_1",
    userId: "user_1",
    userMessageId: "msg_user",
    assistantMessageId: "msg_assistant",
    triggerRunId: null,
    status: "QUEUED",
    idempotencyKey: "idem_1",
    requestedModel: "openrouter/free",
    routedModel: null,
    planMode: false,
    currentStep: null,
    usage: null,
    microcreditsReserved: 5_000n,
    microcreditsCharged: 0n,
    error: null,
    cancelRequestedAt: null,
    heartbeatAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as DbAgentRun;
}

describe("serializers", () => {
  it("maps DB UPPER enums to contract lowercase", () => {
    const attachment = serializeAttachment(fakeAttachment({ kind: "VIDEO", source: "GENERATED", status: "PROCESSING" }));
    expect(attachment.kind).toBe("video");
    expect(attachment.source).toBe("generated");
    expect(attachment.status).toBe("processing");

    const message = serializeMessage(fakeMessage({ role: "TOOL", status: "FAILED" }), []);
    expect(message.role).toBe("tool");
    expect(message.status).toBe("failed");
  });

  it("serializes BigInt microcredits as plain numbers", () => {
    const run = serializeAgentRun(fakeAgentRun({ microcreditsReserved: 12_345n, microcreditsCharged: 6_789n }), {
      toolInvocations: [],
      waitpoint: null,
      loadedSkills: [],
    });
    expect(run.microcreditsReserved).toBe(12_345);
    expect(typeof run.microcreditsReserved).toBe("number");
    expect(run.microcreditsCharged).toBe(6_789);
  });

  it("fails loudly (internal, not validation_error) on corrupt JSONB content", () => {
    const corrupt = fakeMessage({ content: { not: "an array of blocks" } as unknown as DbMessage["content"] });
    let caught: unknown;
    try {
      serializeMessage(corrupt, []);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("internal");
  });

  it("fails loudly on a malformed AgentRun.usage payload", () => {
    const corrupt = fakeAgentRun({ usage: { promptTokens: "not-a-number" } as unknown as DbAgentRun["usage"] });
    let caught: unknown;
    try {
      serializeAgentRun(corrupt, { toolInvocations: [], waitpoint: null, loadedSkills: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("internal");
  });
});
