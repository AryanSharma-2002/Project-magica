import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { listMessages } from "@/services/messages";
import { createChat, createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("message cursor pagination", () => {
  it("pages 45 messages as 20/20/5 with no duplicates or gaps, and stays stable when a newer message is inserted mid-pagination", async () => {
    const user = await createUser();
    const chat = await createChat(user.id);
    for (let i = 0; i < 45; i++) {
      await prisma.message.create({
        data: { chatId: chat.id, userId: user.id, role: "USER", status: "COMPLETED", content: [{ type: "text", text: `m${i}` }], textContent: `m${i}` },
      });
    }

    const page1 = await listMessages(user.id, chat.id, { limit: 20 });
    expect(page1.items).toHaveLength(20);
    expect(page1.nextCursor).not.toBeNull();

    // A brand-new message lands between fetching page 1 and page 2. Since it's newer than
    // everything already seen, keyset pagination (unlike offset pagination) must not let it
    // shift or duplicate rows in the pages that follow.
    await prisma.message.create({
      data: { chatId: chat.id, userId: user.id, role: "USER", status: "COMPLETED", content: [{ type: "text", text: "inserted-newer" }], textContent: "inserted-newer" },
    });

    const page2 = await listMessages(user.id, chat.id, { limit: 20, cursor: page1.nextCursor ?? undefined });
    expect(page2.items).toHaveLength(20);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listMessages(user.id, chat.id, { limit: 20, cursor: page2.nextCursor ?? undefined });
    expect(page3.items).toHaveLength(5);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items, ...page3.items].map((m) => m.id);
    expect(new Set(allIds).size).toBe(45);
    expect(allIds.some((id) => id === undefined)).toBe(false);
  });
});
