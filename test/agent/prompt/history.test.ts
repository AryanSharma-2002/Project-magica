import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@agent-chat/contracts";
import { historyToLlmMessages } from "@/agent/prompt/history";
import { assistantMessage, makeAttachment, userMessage } from "../fakes/builders";

describe("historyToLlmMessages", () => {
  it("converts a plain user text message", () => {
    const out = historyToLlmMessages([userMessage("hello there")], []);
    expect(out).toEqual([{ role: "user", content: "hello there" }]);
  });

  it("attaches READY image attachments of the message as image_url parts", () => {
    const img = makeAttachment({ kind: "image", status: "ready", url: "https://example.com/x.png" });
    const msg = userMessage("look at this", { attachments: [img] });
    const out = historyToLlmMessages([msg], []);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image_url", url: "https://example.com/x.png" }] },
    ]);
  });

  it("ignores non-ready or non-image attachments on the message", () => {
    const notReady = makeAttachment({ kind: "image", status: "uploading" });
    const video = makeAttachment({ kind: "video", status: "ready", url: "https://example.com/v.mp4" });
    const msg = userMessage("hi", { attachments: [notReady, video] });
    const out = historyToLlmMessages([msg], []);
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });

  it("falls back to the passed-in attachments for the current (last) message only", () => {
    const older = userMessage("older message"); // no own attachments
    const current = userMessage("current message"); // no own attachments either
    const currentAttachment = makeAttachment({ url: "https://example.com/current.png" });
    const out = historyToLlmMessages([older, current], [currentAttachment]);
    expect(out[0]).toEqual({ role: "user", content: "older message" });
    expect(out[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "current message" }, { type: "image_url", url: "https://example.com/current.png" }],
    });
  });

  it("converts assistant text + tool_use into an assistant message with toolCalls, followed by a tool message", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "Let me crop that." },
      { type: "tool_use", toolCallId: "call_1", invocationId: "inv_1", toolName: "crop_image", input: { image_url: "https://x/a.png" } },
      { type: "tool_result", toolCallId: "call_1", invocationId: "inv_1", toolName: "crop_image", status: "completed", output: { image_url: "https://x/b.png" } },
    ];
    const out = historyToLlmMessages([assistantMessage(blocks)], []);
    expect(out).toEqual([
      {
        role: "assistant",
        content: "Let me crop that.",
        toolCalls: [{ id: "call_1", name: "crop_image", arguments: JSON.stringify({ image_url: "https://x/a.png" }) }],
      },
      { role: "tool", toolCallId: "call_1", content: JSON.stringify({ image_url: "https://x/b.png" }) },
    ]);
  });

  it("renders a failed tool_result as a {error} tool message", () => {
    const blocks: ContentBlock[] = [
      { type: "tool_use", toolCallId: "call_1", invocationId: "inv_1", toolName: "crop_image", input: {} },
      {
        type: "tool_result",
        toolCallId: "call_1",
        invocationId: "inv_1",
        toolName: "crop_image",
        status: "failed",
        error: { code: "provider_error", message: "boom", retryable: false },
      },
    ];
    const out = historyToLlmMessages([assistantMessage(blocks)], []);
    expect(out[1]).toEqual({ role: "tool", toolCallId: "call_1", content: JSON.stringify({ error: { code: "provider_error", message: "boom", retryable: false } }) });
  });

  it("synthesizes an error tool message for an orphaned tool_use with no recorded tool_result", () => {
    const blocks: ContentBlock[] = [{ type: "tool_use", toolCallId: "call_1", invocationId: "inv_1", toolName: "crop_image", input: {} }];
    const out = historyToLlmMessages([assistantMessage(blocks)], []);
    expect(out).toHaveLength(2);
    const toolMsg = out[1] as { role: "tool"; toolCallId: string; content: string };
    expect(toolMsg.role).toBe("tool");
    expect(JSON.parse(toolMsg.content)).toMatchObject({ error: { code: "internal" } });
  });

  it("skips thinking/reasoning/usage/asset blocks in assistant content", () => {
    const blocks: ContentBlock[] = [
      { type: "thinking", text: "pondering" },
      { type: "reasoning", text: "step" },
      { type: "text", text: "final answer" },
      { type: "usage", model: "m", requestedModel: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, microcredits: 0 },
      { type: "asset", kind: "image", url: "https://x/a.png" },
    ];
    const out = historyToLlmMessages([assistantMessage(blocks)], []);
    expect(out).toEqual([{ role: "assistant", content: "final answer" }]);
  });

  it("bounds to the last N messages, dropping oldest first", () => {
    const messages = [userMessage("m1"), assistantMessage([{ type: "text", text: "a1" }]), userMessage("m2"), assistantMessage([{ type: "text", text: "a2" }])];
    const out = historyToLlmMessages(messages, [], { maxMessages: 2, maxChars: 1_000_000 });
    expect(out).toEqual([{ role: "user", content: "m2" }, { role: "assistant", content: "a2" }]);
  });

  it("bounds by character budget, never dropping the last message even if it alone exceeds the budget", () => {
    const messages = [userMessage("short"), userMessage("y".repeat(500))];
    const out = historyToLlmMessages(messages, [], { maxMessages: 40, maxChars: 100 });
    expect(out).toEqual([{ role: "user", content: "y".repeat(500) }]);
  });

  it("never splits a tool_use/tool_result pair when trimming by character budget", () => {
    const toolBlocks: ContentBlock[] = [
      { type: "tool_use", toolCallId: "call_1", invocationId: "inv_1", toolName: "crop_image", input: {} },
      { type: "tool_result", toolCallId: "call_1", invocationId: "inv_1", toolName: "crop_image", status: "completed", output: { ok: true } },
    ];
    const messages = [userMessage("z".repeat(200)), assistantMessage(toolBlocks), userMessage("current")];
    // Budget too small to fit everything; must still keep the assistant+tool pair together or drop it whole.
    const out = historyToLlmMessages(messages, [], { maxMessages: 40, maxChars: 40 });
    const roles = out.map((m) => m.role);
    // If the assistant message survived, its tool reply must be present immediately after it.
    const assistantIdx = roles.indexOf("assistant");
    if (assistantIdx !== -1) {
      expect(roles[assistantIdx + 1]).toBe("tool");
    }
    // The current (last) user message must always survive.
    expect(out[out.length - 1]).toEqual({ role: "user", content: "current" });
  });

  it("drops a leading assistant-only group so the window starts with a user message", () => {
    const messages = [assistantMessage([{ type: "text", text: "orphan-ish assistant turn" }]), userMessage("current")];
    const out = historyToLlmMessages(messages, [], { maxMessages: 40, maxChars: 1_000_000 });
    expect(out).toEqual([{ role: "user", content: "current" }]);
  });
});
