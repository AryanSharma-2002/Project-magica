import type { Attachment, Message } from "@agent-chat/contracts";
import { blocksToPlainText } from "@agent-chat/contracts";
import { missingToolResultContent, toolResultToLlmContent } from "@/agent/loop/blocks";
import type { LlmContentPart, LlmMessage, LlmToolCall } from "@/agent/llm/types";

export type HistoryBoundOptions = { maxMessages?: number; maxChars?: number };

const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MAX_CHARS = 24_000;

type ReadyImageAttachment = Attachment & { url: string };

function pickReadyImages(list: ReadonlyArray<Attachment>): ReadyImageAttachment[] {
  return list.filter((a): a is ReadyImageAttachment => a.kind === "image" && a.status === "ready" && a.url !== null);
}

/** One source Message's worth of LlmMessages, kept/dropped atomically so a tool_use/tool_result
 * pair (always produced by the same source assistant Message) is never split by the history bound. */
type Group = { role: "user" | "assistant"; llmMessages: LlmMessage[]; chars: number };

function estimateChars(m: LlmMessage): number {
  if (m.role === "system") return m.content.length;
  if (m.role === "tool") return m.content.length;
  if (m.role === "user") {
    if (typeof m.content === "string") return m.content.length;
    return m.content.reduce((sum, part: LlmContentPart) => sum + (part.type === "text" ? part.text.length : part.url.length), 0);
  }
  // assistant
  let n = m.content?.length ?? 0;
  for (const tc of m.toolCalls ?? []) n += tc.name.length + tc.arguments.length;
  return n;
}

function buildUserGroup(message: Message, isCurrent: boolean, currentAttachments: ReadonlyArray<Attachment>): Group {
  const text = blocksToPlainText(message.content);
  const ownImages = pickReadyImages(message.attachments);
  const images = ownImages.length > 0 ? ownImages : isCurrent ? pickReadyImages(currentAttachments) : [];

  let content: LlmMessage["content"];
  if (images.length > 0) {
    const parts: LlmContentPart[] = [];
    if (text.length > 0) parts.push({ type: "text", text });
    for (const img of images) parts.push({ type: "image_url", url: img.url });
    content = parts;
  } else {
    content = text;
  }

  const llm: LlmMessage = { role: "user", content };
  return { role: "user", llmMessages: [llm], chars: estimateChars(llm) };
}

function buildAssistantGroup(message: Message): Group {
  const textParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  const resultContentByCallId = new Map<string, string>();

  for (const block of message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({ id: block.toolCallId, name: block.toolName, arguments: JSON.stringify(block.input) });
    } else if (block.type === "tool_result") {
      resultContentByCallId.set(block.toolCallId, toolResultToLlmContent(block));
    }
    // thinking / reasoning / usage / asset / citation / error blocks carry no information the
    // model needs replayed into a future turn's messages; they are intentionally skipped here.
  }

  const assistantMsg: LlmMessage = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("\n") : null,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  const toolMessages: LlmMessage[] = toolCalls.map((tc) => ({
    role: "tool",
    toolCallId: tc.id,
    content: resultContentByCallId.get(tc.id) ?? missingToolResultContent(),
  }));

  const llmMessages = [assistantMsg, ...toolMessages];
  return { role: "assistant", llmMessages, chars: llmMessages.reduce((sum, m) => sum + estimateChars(m), 0) };
}

/**
 * Converts persisted conversation history into LlmMessage[] for the next provider request.
 * Bounded to the last `maxMessages` source Messages AND ~`maxChars` characters (oldest dropped
 * first); a tool_use/tool_result pair is always produced by, and kept/dropped with, the same
 * source assistant Message, so the bound never splits one. `attachments` are the READY attachments
 * of the CURRENT (last) user message; used only when that message's own `.attachments` is empty.
 */
export function historyToLlmMessages(history: Message[], attachments: ReadonlyArray<Attachment>, opts: HistoryBoundOptions = {}): LlmMessage[] {
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const lastIndex = history.length - 1;

  const groups: Group[] = [];
  history.forEach((message, i) => {
    if (message.role === "user") groups.push(buildUserGroup(message, i === lastIndex, attachments));
    else if (message.role === "assistant") groups.push(buildAssistantGroup(message));
    // "system"/"tool" role Messages are not part of chat history (TOOL role is public-API-only per
    // ARCHITECTURE.md); ignore defensively rather than throw.
  });

  let windowed = groups.slice(Math.max(0, groups.length - maxMessages));

  let totalChars = windowed.reduce((sum, g) => sum + g.chars, 0);
  while (windowed.length > 1 && totalChars > maxChars) {
    const dropped = windowed[0];
    if (!dropped) break;
    windowed = windowed.slice(1);
    totalChars -= dropped.chars;
  }

  // OpenAI-shape chat needs the first non-system message to be a user turn.
  while (windowed.length > 1 && windowed[0]?.role === "assistant") {
    windowed = windowed.slice(1);
  }

  return windowed.flatMap((g) => g.llmMessages);
}
