import { metadata } from "@trigger.dev/sdk";
import { RunMetadata, type TextChunk } from "@agent-chat/contracts";

/** `@trigger.dev/core`'s DeserializedJson isn't resolvable as a direct import here (it's only a
 * transitive dependency, and package.json is out of scope for this slice to edit) - derive the
 * exact parameter type from the already-imported `metadata.set` instead of adding the package. */
type MetadataValue = Parameters<typeof metadata.set>[1];
import type { RealtimeEmitter } from "@/agent/loop/ports";
import { agentTextStream } from "@/trigger/streams";

/**
 * RealtimeEmitter over Trigger.dev run metadata + the agent-text stream (ARCHITECTURE.md §6).
 *
 * TEXT STREAM CHOICE (verified against node_modules/@trigger.dev/sdk/dist/esm/v3/streams.js):
 * a stream defined with `streams.define<T>()` exposes `.append(value)` typed to accept `T`
 * directly (not just BodyInit) - but its *implementation* is sugar: every call opens a brand-new
 * single-write `streams.writer()` session (`{ execute: ({write}) => write(value) }`) and awaits
 * that session's `waitUntilComplete()` before resolving. That is one realtime-stream HTTP
 * round-trip per call. At LLM token-delta rates (tens of chunks/sec) that is both slow (each
 * `text()` call would block on a network round trip) and wasteful. Instead this emitter opens a
 * SINGLE long-lived `agentTextStream.writer()` session for the run's lifetime, backed by a small
 * pull queue; `text()` just enqueues (synchronous, no await, no per-token HTTP call) and the
 * writer's `execute` loop drains the queue as fast as the transport allows. `flush()` closes the
 * queue and awaits the session's `waitUntilComplete()` so no buffered chunk is lost when the task
 * ends.
 */

const DEFAULT_MIN_INTERVAL_MS = 500; // <= 2 writes/s

function boundArray<T>(arr: readonly T[], max: number): T[] {
  return arr.length > max ? arr.slice(arr.length - max) : [...arr];
}

/** Pure metadata-merge semantics, exported for unit tests. */
export function mergeMetadata(
  current: RunMetadata,
  patch: Partial<Omit<RunMetadata, "v" | "runId" | "chatId" | "assistantMessageId">>,
  now: () => Date = () => new Date(),
): RunMetadata {
  // `tools` is keyed by toolCallId; each incoming entry is a *full* LiveToolState (the ports.ts
  // type does not allow partial per-field updates), so merging "by key" means the incoming
  // key/value pairs replace matching current entries and add new ones - existing keys not
  // mentioned in the patch are left untouched.
  const tools = patch.tools ? { ...current.tools, ...patch.tools } : current.tools;
  const assets = patch.assets !== undefined ? boundArray(patch.assets, 20) : current.assets;
  const reasoning = patch.reasoning !== undefined ? boundArray(patch.reasoning, 50) : current.reasoning;

  const merged: RunMetadata = {
    ...current,
    ...patch,
    tools,
    assets,
    reasoning,
    updatedAt: now().toISOString(),
  };
  return RunMetadata.parse(merged);
}

function createChunkQueue() {
  const queue: TextChunk[] = [];
  let resolveNext: (() => void) | null = null;
  let closed = false;
  return {
    push(chunk: TextChunk) {
      queue.push(chunk);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    },
    close() {
      closed = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    },
    async next(): Promise<TextChunk | undefined> {
      for (;;) {
        const item = queue.shift();
        if (item !== undefined) return item;
        if (closed) return undefined;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    },
  };
}

export type RealtimeEmitterOptions = { now?: () => Date; minIntervalMs?: number };

/** `RealtimeEmitter` implementation. `init` is the full initial RunMetadata for the run. */
export function createRealtimeEmitter(init: RunMetadata, opts: RealtimeEmitterOptions = {}): RealtimeEmitter {
  const now = opts.now ?? (() => new Date());
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  let state = RunMetadata.parse(init);
  let lastWriteAt = -Infinity;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingWrite = false;

  const queue = createChunkQueue();
  let streamStarted = false;
  let streamComplete: Promise<unknown> = Promise.resolve();
  function ensureStreamStarted(): void {
    if (streamStarted) return;
    streamStarted = true;
    const { waitUntilComplete } = agentTextStream.writer({
      execute: async ({ write }) => {
        for (;;) {
          const chunk = await queue.next();
          if (chunk === undefined) return;
          write(chunk);
        }
      },
    });
    streamComplete = waitUntilComplete();
  }

  function writeNow(): void {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
    pendingWrite = false;
    lastWriteAt = now().getTime();
    metadata.set("run", state as unknown as MetadataValue);
  }

  function scheduleWrite(): void {
    const elapsed = now().getTime() - lastWriteAt;
    if (elapsed >= minIntervalMs) {
      writeNow();
      return;
    }
    if (pendingWrite) return; // a trailing write is already scheduled
    pendingWrite = true;
    pendingTimer = setTimeout(writeNow, minIntervalMs - elapsed);
  }

  return {
    text(chunk) {
      ensureStreamStarted();
      queue.push(chunk);
    },
    metadata(patch) {
      state = mergeMetadata(state, patch, now);
      scheduleWrite();
    },
    async flush() {
      writeNow();
      queue.close();
      await streamComplete;
      await metadata.flush();
    },
  };
}
