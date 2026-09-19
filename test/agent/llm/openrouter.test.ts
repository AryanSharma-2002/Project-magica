import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "@/agent/llm/openrouter";
import type { LlmEvent, LlmRequest } from "@/agent/llm/types";

function sseResponse(lines: string[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(stream, { status: init.status ?? 200, ...(init.headers ? { headers: init.headers } : {}) });
}

function baseReq(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "openrouter/free",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

describe("OpenRouterProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function provider() {
    return new OpenRouterProvider({ apiKey: "sk-test", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free" });
  }

  it("rejects a non-free model before making any request", async () => {
    const p = provider();
    await expect(collect(p.stream(baseReq({ model: "openai/gpt-4o" })))).rejects.toMatchObject({ code: "validation_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses text deltas, captures the routed model, and emits usage", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        `data: {"model":"upstage/solar-pro-3:free","choices":[{"delta":{"content":"Hel"}}]}\n\n`,
        `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n`,
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
        `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n`,
        `data: [DONE]\n\n`,
      ]),
    );
    const events = await collect(provider().stream(baseReq()));
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta)).toEqual(["Hel", "lo"]);
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ model: "upstage/solar-pro-3:free", promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ reason: "stop", model: "upstage/solar-pro-3:free" });
  });

  it("accumulates tool_call deltas across chunks by index and emits tool_call_delta events", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"crop_image","arguments":"{\\"a\\":"}}]}}]}\n\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
        `data: [DONE]\n\n`,
      ]),
    );
    const events = await collect(provider().stream(baseReq()));
    const deltas = events.filter((e) => e.type === "tool_call_delta");
    expect(deltas).toEqual([
      { type: "tool_call_delta", index: 0, id: "call_1", name: "crop_image", argumentsDelta: '{"a":' },
      { type: "tool_call_delta", index: 0, argumentsDelta: "1}" },
    ]);
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({
      reason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "crop_image", arguments: '{"a":1}' }],
    });
  });

  it("treats accumulated tool calls as finish reason tool_calls even if the provider reports stop", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"crop_image","arguments":"{}"}}]},"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ]),
    );
    const events = await collect(provider().stream(baseReq()));
    expect(events.find((e) => e.type === "finish")).toMatchObject({ reason: "tool_calls" });
  });

  it("maps reasoning deltas to thinking_delta (string form and reasoning_details form)", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        `data: {"choices":[{"delta":{"reasoning":"step one"}}]}\n\n`,
        `data: {"choices":[{"delta":{"reasoning_details":[{"type":"text","text":"step two"}]}}]}\n\n`,
        `data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ]),
    );
    const events = await collect(provider().stream(baseReq()));
    expect(events.filter((e) => e.type === "thinking_delta").map((e) => (e as { delta: string }).delta)).toEqual(["step one", "step two"]);
  });

  it("ignores keep-alive comment lines", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        `: OPENROUTER PROCESSING\n\n`,
        `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n`,
        `: OPENROUTER PROCESSING\n\n`,
        `data: [DONE]\n\n`,
      ]),
    );
    const events = await collect(provider().stream(baseReq()));
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(1);
  });

  it("maps 429 to provider_rate_limited with retryAfterSeconds", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "7" } }));
    await expect(collect(provider().stream(baseReq()))).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryable: true,
      details: { retryAfterSeconds: 7 },
    });
  });

  it("maps 402/403 to a non-retryable provider_error", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(collect(provider().stream(baseReq()))).rejects.toMatchObject({ code: "provider_error", retryable: false });
  });

  it("maps 5xx to retryable provider_unavailable", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(collect(provider().stream(baseReq()))).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
  });

  it("maps a stream with no text and no tool calls to empty_response", async () => {
    fetchMock.mockResolvedValue(sseResponse([`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`, `data: [DONE]\n\n`]));
    await expect(collect(provider().stream(baseReq()))).rejects.toMatchObject({ code: "empty_response", retryable: true });
  });

  it("maps an in-stream error object to a non-retryable provider_error", async () => {
    fetchMock.mockResolvedValue(sseResponse([`data: {"error":{"message":"boom"}}\n\n`]));
    await expect(collect(provider().stream(baseReq()))).rejects.toMatchObject({ code: "provider_error", retryable: false });
  });

  it("maps caller abort mid-stream to cancelled", async () => {
    const encoder = new TextEncoder();
    const callerController = new AbortController();
    fetchMock.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"partial"}}]}\n\n`));
          init.signal.addEventListener("abort", () => {
            controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        },
      });
      return new Response(stream, { status: 200 });
    });

    const events: LlmEvent[] = [];
    const runPromise = (async () => {
      for await (const e of provider().stream(baseReq({ signal: callerController.signal }))) events.push(e);
    })();

    await new Promise((r) => setTimeout(r, 20));
    callerController.abort();

    await expect(runPromise).rejects.toMatchObject({ code: "cancelled" });
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
  });
});
