import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_METADATA_VERSION, RunMetadata, type LiveToolState } from "@agent-chat/contracts";

vi.mock("@trigger.dev/sdk", () => {
  const metadataCalls: Array<[string, unknown]> = [];
  const streamWrites: unknown[] = [];
  return {
    __metadataCalls: metadataCalls,
    __streamWrites: streamWrites,
    metadata: {
      set: (key: string, value: unknown) => {
        metadataCalls.push([key, value]);
      },
      flush: vi.fn().mockResolvedValue(undefined),
      parent: { set: vi.fn() },
    },
    streams: {
      define: () => ({
        id: "agent-text",
        writer: (opts: { execute: (helpers: { write: (v: unknown) => void; merge: (s: unknown) => void }) => Promise<void> | void }) => {
          let resolveDone!: () => void;
          const done = new Promise<void>((resolve) => {
            resolveDone = resolve;
          });
          Promise.resolve(opts.execute({ write: (v) => streamWrites.push(v), merge: () => {} })).then(() => resolveDone());
          return { stream: null, waitUntilComplete: () => done.then(() => ({})) };
        },
        append: vi.fn(),
      }),
    },
    task: vi.fn((opts: unknown) => opts),
    tasks: { onFailure: vi.fn(), onCancel: vi.fn() },
    wait: { createToken: vi.fn(), completeToken: vi.fn(), forToken: vi.fn() },
  };
});

const { mergeMetadata, createRealtimeEmitter } = await import("@/trigger/adapters/realtime");
const sdkMock = (await import("@trigger.dev/sdk")) as unknown as { __metadataCalls: Array<[string, unknown]>; __streamWrites: unknown[] };

function baseMetadata(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return RunMetadata.parse({
    v: RUN_METADATA_VERSION,
    runId: "run_1",
    chatId: "chat_1",
    assistantMessageId: "msg_1",
    status: "running",
    step: null,
    progress: null,
    thinkingStartedAt: null,
    thinkingMs: null,
    routedModel: null,
    tools: {},
    waitpoint: null,
    assets: [],
    reasoning: [],
    error: null,
    persistedUpTo: -1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function liveTool(overrides: Partial<LiveToolState> = {}): LiveToolState {
  return { invocationId: "inv_1", toolName: "crop_image", status: "running", index: 0, startedAt: null, finishedAt: null, providerRunId: null, error: null, ...overrides };
}

describe("mergeMetadata", () => {
  it("merges tools by key without disturbing other keys", () => {
    const current = baseMetadata({ tools: { call_a: liveTool({ invocationId: "a" }) } });
    const merged = mergeMetadata(current, { tools: { call_b: liveTool({ invocationId: "b" }) } });
    expect(Object.keys(merged.tools).sort()).toEqual(["call_a", "call_b"]);
    expect(merged.tools.call_a?.invocationId).toBe("a");
  });

  it("a full LiveToolState for an existing key replaces that key's entry wholesale", () => {
    const current = baseMetadata({ tools: { call_a: liveTool({ status: "running" }) } });
    const merged = mergeMetadata(current, { tools: { call_a: liveTool({ status: "completed", providerRunId: "prov_1" }) } });
    expect(merged.tools.call_a).toMatchObject({ status: "completed", providerRunId: "prov_1" });
  });

  it("replaces (not appends) assets/reasoning arrays and bounds them to 20 / 50", () => {
    const current = baseMetadata();
    const assets = Array.from({ length: 25 }, (_, i) => ({ type: "asset" as const, kind: "image" as const, url: `https://x/${i}.png`, index: i }));
    const merged = mergeMetadata(current, { assets });
    expect(merged.assets).toHaveLength(20);
    // Keeps the LAST 20 (most recent), per RunMetadata's own doc comment.
    expect(merged.assets[0]?.index).toBe(5);
    expect(merged.assets[19]?.index).toBe(24);

    const reasoning = Array.from({ length: 60 }, (_, i) => ({ index: i, text: `step ${i}` }));
    const merged2 = mergeMetadata(current, { reasoning });
    expect(merged2.reasoning).toHaveLength(50);
    expect(merged2.reasoning[0]?.index).toBe(10);
  });

  it("bumps updatedAt and always produces schema-valid RunMetadata", () => {
    const current = baseMetadata();
    const now = () => new Date("2026-06-01T00:00:00.000Z");
    const merged = mergeMetadata(current, { step: "Thinking", progress: 0.5 }, now);
    expect(merged.updatedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(RunMetadata.safeParse(merged).success).toBe(true);
  });

  it("leaves fields untouched when not present in the patch", () => {
    const current = baseMetadata({ step: "Generating image", routedModel: "upstage/solar-pro-3:free" });
    const merged = mergeMetadata(current, { progress: 0.2 });
    expect(merged.step).toBe("Generating image");
    expect(merged.routedModel).toBe("upstage/solar-pro-3:free");
  });
});

describe("createRealtimeEmitter throttling", () => {
  afterEach(() => {
    sdkMock.__metadataCalls.length = 0;
    sdkMock.__streamWrites.length = 0;
  });

  it("writes the very first metadata() call immediately (never throttles the initial snapshot)", () => {
    const emitter = createRealtimeEmitter(baseMetadata(), { minIntervalMs: 200 });
    emitter.metadata({ step: "Thinking" });
    expect(sdkMock.__metadataCalls).toHaveLength(1);
    expect(sdkMock.__metadataCalls[0]?.[0]).toBe("run");
  });

  it("throttles rapid calls to <= 2 writes/s with a guaranteed trailing write reflecting the latest patch", async () => {
    const emitter = createRealtimeEmitter(baseMetadata(), { minIntervalMs: 60 });
    emitter.metadata({ step: "Step 1" });
    emitter.metadata({ step: "Step 2" });
    emitter.metadata({ step: "Step 3" });
    // Only the first (immediate) write has happened synchronously.
    expect(sdkMock.__metadataCalls).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(sdkMock.__metadataCalls).toHaveLength(2);
    const trailing = sdkMock.__metadataCalls[1]?.[1] as RunMetadata;
    expect(trailing.step).toBe("Step 3"); // trailing write carries the latest state, not an intermediate one
  });

  it("flush() writes immediately, closes the text stream, and calls metadata.flush()", async () => {
    const emitter = createRealtimeEmitter(baseMetadata());
    emitter.text({ t: "text", i: 0, d: "hello " });
    emitter.text({ t: "text", i: 0, d: "world" });
    await emitter.flush();
    expect(sdkMock.__streamWrites).toEqual([
      { t: "text", i: 0, d: "hello " },
      { t: "text", i: 0, d: "world" },
    ]);
  });
});
