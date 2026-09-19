import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getChat } from "@/services/chats";
import { listMessages } from "@/services/messages";
import { completeWaitpoint, getRun } from "@/services/runs";
import { createChat, createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

async function makeRunWithWaitpoint(userId: string, chatId: string) {
  const userMsg = await prisma.message.create({ data: { chatId, userId, role: "USER", status: "COMPLETED", content: [], textContent: "" } });
  const assistantMsg = await prisma.message.create({ data: { chatId, userId, role: "ASSISTANT", status: "PENDING", content: [] } });
  const run = await prisma.agentRun.create({
    data: {
      chatId,
      userId,
      userMessageId: userMsg.id,
      assistantMessageId: assistantMsg.id,
      idempotencyKey: `run-${crypto.randomUUID()}`,
      requestedModel: "openrouter/free",
      status: "WAITING",
    },
  });
  const waitpoint = await prisma.waitpoint.create({
    data: {
      runId: run.id,
      type: "APPROVAL",
      triggerTokenId: `wpt_${crypto.randomUUID()}`,
      prompt: { type: "approval", title: "Proceed?", toolName: "gpt_image_2", toolCallId: "call_1", input: {}, microcreditsEstimated: 1000 },
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  return { run, waitpoint };
}

describe("ownership isolation", () => {
  it("user B cannot read user A's chat, run, or message list", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const chat = await createChat(userA.id);
    const { run } = await makeRunWithWaitpoint(userA.id, chat.id);

    await expect(getChat(userB.id, chat.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getRun(userB.id, run.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(listMessages(userB.id, chat.id, { limit: 30 })).rejects.toMatchObject({ code: "not_found" });

    // Sanity: the owner can.
    await expect(getChat(userA.id, chat.id)).resolves.toMatchObject({ id: chat.id });
  });

  it("user B cannot complete user A's waitpoint", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const chat = await createChat(userA.id);
    const { waitpoint } = await makeRunWithWaitpoint(userA.id, chat.id);

    const err = await completeWaitpoint(userB.id, waitpoint.id, { type: "approval", approved: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("not_found");

    const stillPending = await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } });
    expect(stillPending.status).toBe("PENDING");
  });
});
