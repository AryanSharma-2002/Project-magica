import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { search } from "@/services/search";
import { createChat, createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("search", () => {
  it("finds a message by content and a chat by title, scoped to the owner", async () => {
    const owner = await createUser();
    const other = await createUser();

    const chatWithMessage = await createChat(owner.id, { title: "Random chat" });
    await prisma.message.create({
      data: {
        chatId: chatWithMessage.id,
        userId: owner.id,
        role: "USER",
        status: "COMPLETED",
        content: [{ type: "text", text: "Please crop the photograph of the mountains" }],
        textContent: "Please crop the photograph of the mountains",
      },
    });

    const chatByTitle = await createChat(owner.id, { title: "Mountains vacation planning" });

    // Same content/title but owned by a different user: must never surface for `owner`'s search.
    const otherChat = await createChat(other.id, { title: "Mountains vacation planning" });
    await prisma.message.create({
      data: {
        chatId: otherChat.id,
        userId: other.id,
        role: "USER",
        status: "COMPLETED",
        content: [{ type: "text", text: "Please crop the photograph of the mountains" }],
        textContent: "Please crop the photograph of the mountains",
      },
    });

    const results = await search(owner.id, { q: "mountains", limit: 30 });
    const chatIds = results.items.map((h) => h.chatId);

    expect(chatIds).toContain(chatWithMessage.id);
    expect(chatIds).toContain(chatByTitle.id);
    expect(chatIds).not.toContain(otherChat.id);

    const messageHit = results.items.find((h) => h.chatId === chatWithMessage.id);
    expect(messageHit?.messageId).not.toBeNull();
    expect(messageHit?.snippet.length).toBeGreaterThan(0);

    const chatHit = results.items.find((h) => h.chatId === chatByTitle.id);
    expect(chatHit?.messageId).toBeNull();
  });
});
