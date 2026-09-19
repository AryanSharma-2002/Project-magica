import { AppError } from "@/lib/errors";
import type { LlmEvent, LlmProvider, LlmRequest } from "@/agent/llm/types";

export type LlmScriptEntry = LlmEvent[] | ((req: LlmRequest) => AsyncIterable<LlmEvent>) | AppError;

/** Streams a scripted sequence of events per call (one script entry consumed per `.stream()` call;
 * the last entry repeats if there are more calls than entries). Can throw a scripted AppError, or
 * delegate fully to a generator function for cases that need to react to `req.signal` (cancellation). */
export class ScriptedLlm implements LlmProvider {
  readonly id = "openrouter" as const;
  calls: LlmRequest[] = [];

  constructor(private readonly script: LlmScriptEntry[]) {}

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.calls.push(req);
    const index = this.calls.length - 1;
    const entry = this.script[Math.min(index, this.script.length - 1)];
    if (entry === undefined) throw new Error("ScriptedLlm: no script entry configured");
    if (entry instanceof AppError) throw entry;
    if (typeof entry === "function") {
      yield* entry(req);
      return;
    }
    for (const event of entry) yield event;
  }
}

/** A script entry that yields `initialEvents` then hangs until `req.signal` aborts, at which point
 * it throws AppError("cancelled", ...) the way a real provider would when its request is aborted. */
export function hangUntilAborted(initialEvents: LlmEvent[] = []): LlmScriptEntry {
  return async function* (req: LlmRequest) {
    for (const e of initialEvents) yield e;
    await new Promise<void>((_resolve, reject) => {
      if (req.signal.aborted) {
        reject(new AppError("cancelled", "The operation was cancelled"));
        return;
      }
      req.signal.addEventListener("abort", () => reject(new AppError("cancelled", "The operation was cancelled")), { once: true });
    });
  };
}

export function textTurn(text: string, opts: { usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string } = {}): LlmEvent[] {
  const model = opts.model ?? "test/model";
  const usage = opts.usage ?? { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
  return [
    { type: "text_delta", delta: text },
    { type: "usage", model, ...usage },
    { type: "finish", reason: "stop", model, toolCalls: [] },
  ];
}

export function toolCallTurn(
  calls: Array<{ id: string; name: string; args: unknown }>,
  opts: { text?: string; model?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } } = {},
): LlmEvent[] {
  const model = opts.model ?? "test/model";
  const usage = opts.usage ?? { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
  const events: LlmEvent[] = [];
  if (opts.text) events.push({ type: "text_delta", delta: opts.text });
  events.push({ type: "usage", model, ...usage });
  events.push({
    type: "finish",
    reason: "tool_calls",
    model,
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
  });
  return events;
}
