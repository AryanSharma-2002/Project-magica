import type { RunMetadata, TextChunk } from "@agent-chat/contracts";
import type { RealtimeEmitter } from "@/agent/loop/ports";

export class FakeRealtime implements RealtimeEmitter {
  chunks: TextChunk[] = [];
  metadataPatches: Array<Partial<Omit<RunMetadata, "v" | "runId" | "chatId" | "assistantMessageId">>> = [];
  flushCount = 0;

  text(chunk: TextChunk): void {
    this.chunks.push(chunk);
  }

  metadata(patch: Partial<Omit<RunMetadata, "v" | "runId" | "chatId" | "assistantMessageId">>): void {
    this.metadataPatches.push(patch);
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  textFor(index: number): string {
    return this.chunks
      .filter((c) => c.i === index)
      .map((c) => c.d)
      .join("");
  }
}
