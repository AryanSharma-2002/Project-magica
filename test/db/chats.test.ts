import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { listChats } from "@/services/chats";
import { createChat, createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("listChats", () => {
  it("orders by COALESCE(lastMessageAt, createdAt) DESC, paginates, and populates activeRunId", async () => {
    const user = await createUser();

    // No lastMessageAt, so its sort key is its own createdAt: back-dated so it's genuinely the
    // oldest of the three (a freshly-created chat's createdAt would otherwise be "now", i.e.
    // newer than the other two chats' deliberately-past lastMessageAt values).
    const chatOld = await prisma.chat.create({ data: { userId: user.id, title: "Oldest (no lastMessageAt)", createdAt: new Date(Date.now() - 3_600_000) } });

    const chatMidRaw = await createChat(user.id, { title: "Mid" });
    const chatMid = await prisma.chat.update({ where: { id: chatMidRaw.id }, data: { lastMessageAt: new Date(Date.now() - 60_000) } });

    const chatNewRaw = await createChat(user.id, { title: "Newest" });
    const chatNew = await prisma.chat.update({ where: { id: chatNewRaw.id }, data: { lastMessageAt: new Date() } });

    const userMsg = await prisma.message.create({ data: { chatId: chatNew.id, userId: user.id, role: "USER", status: "COMPLETED", content: [], textContent: "" } });
    const assistantMsg = await prisma.message.create({ data: { chatId: chatNew.id, userId: user.id, role: "ASSISTANT", status: "PENDING", content: [] } });
    const activeRun = await prisma.agentRun.create({
      data: {
        chatId: chatNew.id,
        userId: user.id,
        userMessageId: userMsg.id,
        assistantMessageId: assistantMsg.id,
        idempotencyKey: `k-${crypto.randomUUID()}`,
        requestedModel: "openrouter/free",
        status: "RUNNING",
      },
    });

    const page1 = await listChats(user.id, { limit: 2 });
    expect(page1.items.map((c) => c.id)).toEqual([chatNew.id, chatMid.id]);
    expect(page1.items[0]?.activeRunId).toBe(activeRun.id);
    expect(page1.items[1]?.activeRunId).toBeNull();
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listChats(user.id, { limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.items.map((c) => c.id)).toEqual([chatOld.id]);
    expect(page2.nextCursor).toBeNull();
  });
});
