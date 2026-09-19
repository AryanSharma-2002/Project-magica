import type { ProviderToolSpec } from "@/agent/tools/registry";
import { AppError, isAbortError } from "@/lib/errors";
import type { LlmContentPart, LlmEvent, LlmMessage, LlmProvider, LlmRequest, LlmToolCall } from "./types";

export type OpenRouterProviderOptions = {
  apiKey: string;
  baseUrl: string;
  /** The only model id this provider will ever request. Any other `req.model` is rejected. */
  model: string;
  referer?: string;
  title?: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(v: unknown): v is JsonRecord {
  return typeof v === "object" && v !== null;
}

function toOpenAiContentPart(part: LlmContentPart): JsonRecord {
  if (part.type === "text") return { type: "text", text: part.text };
  return { type: "image_url", image_url: { url: part.url } };
}

function toOpenAiMessage(message: LlmMessage): JsonRecord {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return {
        role: "user",
        content: typeof message.content === "string" ? message.content : message.content.map(toOpenAiContentPart),
      };
    case "assistant": {
      const out: JsonRecord = { role: "assistant", content: message.content };
      if (message.toolCalls && message.toolCalls.length > 0) {
        out.tool_calls = message.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return out;
    }
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

function toOpenAiTool(spec: ProviderToolSpec): JsonRecord {
  return { type: "function", function: { name: spec.name, description: spec.description, parameters: spec.parameters } };
}

function safeProviderErrorMessage(err: unknown): string {
  if (isRecord(err) && typeof err.message === "string" && err.message.trim().length > 0) {
    return err.message.slice(0, 500);
  }
  return "The model provider returned an error.";
}

function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function extractReasoningDelta(delta: JsonRecord): string {
  if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return delta.reasoning;
  if (Array.isArray(delta.reasoning_details)) {
    return delta.reasoning_details
      .map((d) => (isRecord(d) && typeof d.text === "string" ? d.text : ""))
      .join("");
  }
  return "";
}

function mapFinishReason(raw: unknown): "stop" | "tool_calls" | "length" | "content_filter" | "error" {
  if (raw === "tool_calls" || raw === "length" || raw === "content_filter" || raw === "error") return raw;
  return "stop";
}

/** Accumulator for one in-progress tool call, keyed by its stream index. */
type ToolCallAccumulator = { id?: string; name?: string; arguments: string };

/**
 * OpenRouter chat-completions streaming adapter. Implements LlmProvider over the OpenAI-compatible
 * `/chat/completions` endpoint with `stream: true`. See src/agent/llm/types.ts for the contract
 * this must uphold (error mapping, exactly-one `finish`, never falling back to another model).
 */
export class OpenRouterProvider implements LlmProvider {
  readonly id = "openrouter" as const;

  constructor(private readonly opts: OpenRouterProviderOptions) {}

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    if (req.model !== this.opts.model) {
      throw new AppError("validation_error", `Unsupported model: ${req.model}`, {
        details: { requested: req.model, allowed: this.opts.model },
      });
    }

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener("abort", onCallerAbort);

    try {
      const body: JsonRecord = {
        model: this.opts.model,
        messages: req.messages.map(toOpenAiMessage),
        stream: true,
        usage: { include: true },
      };
      if (req.tools.length > 0) body.tools = req.tools.map(toOpenAiTool);
      if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice;
      if (req.parallelToolCalls !== undefined) body.parallel_tool_calls = req.parallelToolCalls;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

      const headers: Record<string, string> = {
        authorization: `Bearer ${this.opts.apiKey}`,
        "content-type": "application/json",
      };
      if (this.opts.referer) headers["HTTP-Referer"] = this.opts.referer;
      if (this.opts.title) headers["X-Title"] = this.opts.title;

      let response: Response;
      try {
        response = await fetch(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (req.signal.aborted) throw new AppError("cancelled", "The operation was cancelled", { cause: err });
        throw new AppError("provider_unavailable", "The model provider is temporarily unavailable.", { retryable: true, cause: err });
      }

      if (!response.ok) {
        const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        if (response.status === 429) {
          throw new AppError("provider_rate_limited", "The model provider is rate limiting requests.", {
            retryable: true,
            ...(retryAfterSeconds !== undefined ? { details: { retryAfterSeconds } } : {}),
          });
        }
        if (response.status === 402 || response.status === 403) {
          throw new AppError("provider_error", "The free model route is unavailable right now", { retryable: false });
        }
        if (response.status >= 500) {
          throw new AppError("provider_unavailable", "The model provider is temporarily unavailable.", { retryable: true });
        }
        throw new AppError("provider_error", "The model provider rejected the request.", {
          retryable: false,
          details: { status: response.status },
        });
      }

      if (!response.body) {
        throw new AppError("provider_unavailable", "The model provider returned no response body.", { retryable: true });
      }

      try {
        yield* parseSseStream(response.body);
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (isAbortError(err) || req.signal.aborted) {
          throw new AppError("cancelled", "The operation was cancelled", { cause: err });
        }
        throw new AppError("provider_unavailable", "The model provider connection failed.", { retryable: true, cause: err });
      }
    } finally {
      req.signal.removeEventListener("abort", onCallerAbort);
    }
  }
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<LlmEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawText = false;
  let sawToolCalls = false;
  let routedModel: string | null = null;
  let rawFinishReason: unknown;
  const toolCallsByIndex = new Map<number, ToolCallAccumulator>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0) continue;
        if (line.startsWith(":")) continue; // keep-alive comment, e.g. ": OPENROUTER PROCESSING"
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (!isRecord(json)) continue;

        if (json.error !== undefined) {
          throw new AppError("provider_error", safeProviderErrorMessage(json.error), { retryable: false });
        }
        if (typeof json.model === "string" && routedModel === null) routedModel = json.model;

        const choices = Array.isArray(json.choices) ? json.choices : [];
        const choice = choices[0];
        if (isRecord(choice)) {
          const delta = isRecord(choice.delta) ? choice.delta : {};

          if (typeof delta.content === "string" && delta.content.length > 0) {
            sawText = true;
            yield { type: "text_delta", delta: delta.content };
          }

          const reasoningDelta = extractReasoningDelta(delta);
          if (reasoningDelta.length > 0) {
            yield { type: "thinking_delta", delta: reasoningDelta };
          }

          if (Array.isArray(delta.tool_calls)) {
            delta.tool_calls.forEach((raw, i) => {
              if (!isRecord(raw)) return;
              const index = typeof raw.index === "number" ? raw.index : i;
              const entry = toolCallsByIndex.get(index) ?? { arguments: "" };
              if (typeof raw.id === "string") entry.id = raw.id;
              const fn = isRecord(raw.function) ? raw.function : undefined;
              if (fn && typeof fn.name === "string") entry.name = fn.name;
              if (fn && typeof fn.arguments === "string") entry.arguments += fn.arguments;
              toolCallsByIndex.set(index, entry);
              sawToolCalls = true;
            });
          }

          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            rawFinishReason = choice.finish_reason;
          }
        }

        if (isRecord(json.usage)) {
          const usage = json.usage;
          yield {
            type: "usage",
            model: routedModel ?? "unknown",
            promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
            completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
            totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
          };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawText && !sawToolCalls) {
    throw new AppError("empty_response", "The model returned an empty response.", { retryable: true });
  }

  const toolCalls: LlmToolCall[] = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, acc]) => ({ id: acc.id ?? `call_${index}`, name: acc.name ?? "", arguments: acc.arguments }));

  yield {
    type: "finish",
    reason: sawToolCalls ? "tool_calls" : mapFinishReason(rawFinishReason),
    model: routedModel,
    toolCalls,
  };
}
