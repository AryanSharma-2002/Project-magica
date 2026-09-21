import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@trigger.dev/sdk", () => {
  let counter = 0;
  return {
    tasks: { trigger: vi.fn(async () => ({ id: `trg_${++counter}_${crypto.randomUUID()}` })) },
    auth: { createPublicToken: vi.fn(async () => "test-public-token") },
    wait: { completeToken: vi.fn(async () => ({ success: true })) },
  };
});

import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { createCompletion } from "@/services/public";
import { createChat, createUser, resetDb } from "../helpers/db";
import type { PublicCompletionRequest } from "@agent-chat/contracts";

function req(overrides: Partial<PublicCompletionRequest> = {}): PublicCompletionRequest {
  return { message: "hello from the public api", attachmentUrls: [], planMode: false, ...overrides };
}

beforeEach(async () => {
  await resetDb();
});

describe("createCompletion", () => {
  it("no chatId: creates a new chat titled from the first 60 characters of the message", async () => {
    const user = await createUser();
    const longMessage = "x".repeat(100);

    const res = await createCompletion(user.id, req({ message: longMessage }), "idem-new-chat");

    expect(res.statusUrl).toBe(`${getEnv().PUBLIC_API_BASE_URL}/api/v1/runs/${res.runId}`);
    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: res.chatId } });
    expect(chat.title).toBe(longMessage.slice(0, 60));
    expect(chat.userId).toBe(user.id);

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: res.runId } });
    expect(run.chatId).toBe(res.chatId);
  });

  it("attachmentUrls become READY library attachments with kinds inferred from extension", async () => {
    const user = await createUser();
    const urls = [
      "https://cdn.example.com/pics/photo.PNG",
      "https://cdn.example.com/clips/clip.mp4",
      "https://cdn.example.com/audio/track.mp3",
      "https://cdn.example.com/files/report.pdf",
    ];

    const res = await createCompletion(user.id, req({ message: "look at these", attachmentUrls: urls }), "idem-attach");

    const userMessage = await prisma.message.findUniqueOrThrow({ where: { id: res.messageId } });
    const attachments = await prisma.attachment.findMany({ where: { messageId: userMessage.id }, orderBy: { position: "asc" } });
    expect(attachments).toHaveLength(4);
    expect(attachments.map((a) => a.kind)).toEqual(["IMAGE", "VIDEO", "AUDIO", "FILE"]);
    for (const a of attachments) {
      expect(a.source).toBe("LIBRARY");
      expect(a.status).toBe("READY");
      expect(a.sizeBytes).toBe(0);
    }
    expect(attachments[0]?.url).toBe(urls[0]);
    expect(attachments[0]?.previewUrl).toBe(urls[0]);
    expect(attachments[3]?.filename).toBe("report.pdf");
    expect(attachments[3]?.mimeType).toBe("application/octet-stream");
  });

  it("no chatId + Idempotency-Key dedupe: a repeat returns the SAME run and does not create a second chat", async () => {
    const user = await createUser();

    const first = await createCompletion(user.id, req({ message: "first call" }), "shared-raw-key");
    const chatCountAfterFirst = await prisma.chat.count({ where: { userId: user.id } });
    expect(chatCountAfterFirst).toBe(1);

    const second = await createCompletion(user.id, req({ message: "first call" }), "shared-raw-key");

    expect(second.runId).toBe(first.runId);
    expect(second.chatId).toBe(first.chatId);
    expect(second.messageId).toBe(first.messageId);
    expect(second.assistantMessageId).toBe(first.assistantMessageId);

    const chatCountAfterSecond = await prisma.chat.count({ where: { userId: user.id } });
    expect(chatCountAfterSecond).toBe(1);
    const runCount = await prisma.agentRun.count({ where: { userId: user.id } });
    expect(runCount).toBe(1);
  });

  it("a foreign chatId (not owned by the user) is not_found", async () => {
    const owner = await createUser();
    const other = await createUser();
    const chat = await createChat(owner.id);

    await expect(createCompletion(other.id, req({ chatId: chat.id }), "idem-foreign")).rejects.toMatchObject({ code: "not_found" });
  });

  it("an explicit chatId continues that chat rather than creating a new one", async () => {
    const user = await createUser();
    const chat = await createChat(user.id, { title: "existing chat" });

    const res = await createCompletion(user.id, req({ chatId: chat.id, message: "continue here" }), "idem-continue");

    expect(res.chatId).toBe(chat.id);
    const chatAfter = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
    expect(chatAfter.title).toBe("existing chat");
  });

  it("explicit chatId + repeat Idempotency-Key: returns the same run and does not leave orphan attachment rows", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);
    const urls = ["https://cdn.example.com/pics/photo.png"];

    const first = await createCompletion(user.id, req({ chatId: chat.id, message: "with an attachment", attachmentUrls: urls }), "chat-idem-key");
    const attachmentsAfterFirst = await prisma.attachment.count({ where: { userId: user.id } });
    expect(attachmentsAfterFirst).toBe(1);

    const second = await createCompletion(user.id, req({ chatId: chat.id, message: "with an attachment", attachmentUrls: urls }), "chat-idem-key");
    expect(second.runId).toBe(first.runId);

    // The retry must not create a second (orphan) attachment row.
    const attachmentsAfterSecond = await prisma.attachment.count({ where: { userId: user.id } });
    expect(attachmentsAfterSecond).toBe(1);
  });
});
