import type { Attachment, ContentBlock, JsonValue, Message, ToolInvocationStatus } from "@agent-chat/contracts";
import type { FinalizeInput, InvocationCreate, InvocationPatch, RunRecord, RunSnapshot, RunStore } from "@/agent/loop/ports";
import type { ToolEffect } from "@/agent/tools/types";

export type FakeInvocationRecord = {
  invocationId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  status: ToolInvocationStatus;
  input: JsonValue;
  output: JsonValue | null;
  microcreditsCharged: number;
  microcreditsEstimated: number;
  providerRunId: string | null;
};

export type FakeStoreOptions = {
  run: RunRecord;
  history?: Message[];
  attachments?: Attachment[];
  loadedSkills?: RunSnapshot["loadedSkills"];
  persistedBlocks?: ContentBlock[];
  markRunningResult?: boolean;
  /** Seed pre-existing invocations, e.g. to simulate a resumed run with a terminal invocation. */
  existingInvocations?: FakeInvocationRecord[];
};

let invocationCounter = 0;

export class FakeStore implements RunStore {
  run: RunRecord;
  history: Message[];
  attachments: Attachment[];
  loadedSkills: RunSnapshot["loadedSkills"];
  persistedBlocks: ContentBlock[];
  markRunningResult: boolean;

  cancelRequested = false;
  status: "running" | "waiting" = "running";
  finalized = false;
  finalizeCalls: Array<{ runId: string; input: FinalizeInput }> = [];
  checkpoints: ContentBlock[][] = [];
  heartbeats: Array<{ currentStep?: string | null | undefined; routedModel?: string | null | undefined }> = [];
  invocationsByKey = new Map<string, FakeInvocationRecord>();
  savedAssets: ContentBlock[] = [];
  recordedSkills: Array<{ runId: string; skillName: string; assetPath: string; contentHash: string }> = [];
  statusHistory: Array<"running" | "waiting"> = [];

  constructor(opts: FakeStoreOptions) {
    this.run = opts.run;
    this.history = opts.history ?? [];
    this.attachments = opts.attachments ?? [];
    this.loadedSkills = opts.loadedSkills ?? [];
    this.persistedBlocks = opts.persistedBlocks ?? [];
    this.markRunningResult = opts.markRunningResult ?? true;
    for (const inv of opts.existingInvocations ?? []) {
      this.invocationsByKey.set(`${inv.runId}:${inv.toolCallId}`, inv);
    }
  }

  async loadSnapshot(_runId: string): Promise<RunSnapshot> {
    return {
      run: this.run,
      history: this.history,
      attachments: this.attachments,
      loadedSkills: this.loadedSkills,
      persistedBlocks: this.persistedBlocks,
    };
  }

  async markRunning(_runId: string): Promise<boolean> {
    return this.markRunningResult;
  }

  async heartbeat(_runId: string, patch?: { currentStep?: string | null; routedModel?: string | null }): Promise<void> {
    this.heartbeats.push(patch ?? {});
  }

  async isCancelRequested(_runId: string): Promise<boolean> {
    return this.cancelRequested;
  }

  async setStatus(_runId: string, status: "running" | "waiting"): Promise<void> {
    this.status = status;
    this.statusHistory.push(status);
  }

  async checkpoint(_runId: string, blocks: ContentBlock[]): Promise<void> {
    this.checkpoints.push([...blocks]);
  }

  async createInvocation(input: InvocationCreate): ReturnType<RunStore["createInvocation"]> {
    const key = `${input.runId}:${input.toolCallId}`;
    const existing = this.invocationsByKey.get(key);
    if (existing) {
      return { invocationId: existing.invocationId, existing: true, status: existing.status, output: existing.output, microcreditsCharged: existing.microcreditsCharged };
    }
    invocationCounter += 1;
    const invocationId = `inv_${invocationCounter}`;
    const record: FakeInvocationRecord = {
      invocationId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      status: "pending",
      input: input.input,
      output: null,
      microcreditsCharged: 0,
      microcreditsEstimated: input.microcreditsEstimated,
      providerRunId: null,
    };
    this.invocationsByKey.set(key, record);
    return { invocationId, existing: false, status: "pending", output: null, microcreditsCharged: 0 };
  }

  async updateInvocation(invocationId: string, patch: InvocationPatch): Promise<void> {
    for (const rec of this.invocationsByKey.values()) {
      if (rec.invocationId !== invocationId) continue;
      if (patch.status !== undefined) rec.status = patch.status;
      if (patch.output !== undefined) rec.output = patch.output;
      if (patch.microcreditsCharged !== undefined) rec.microcreditsCharged = patch.microcreditsCharged;
      if (patch.providerRunId !== undefined) rec.providerRunId = patch.providerRunId;
      return;
    }
  }

  async recordSkill(runId: string, skillName: string, assetPath: string, contentHash: string): Promise<{ deduplicated: boolean }> {
    const deduplicated = this.recordedSkills.some((s) => s.runId === runId && s.skillName === skillName && s.assetPath === assetPath && s.contentHash === contentHash);
    this.recordedSkills.push({ runId, skillName, assetPath, contentHash });
    return { deduplicated };
  }

  async saveGeneratedAssets(args: { runId: string; userId: string; chatId: string; messageId: string; invocationId: string; assets: Array<Extract<ToolEffect, { type: "asset" }>["asset"]> }): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = args.assets.map((a) => ({ type: "asset", attachmentId: "att_generated", ...a }));
    this.savedAssets.push(...blocks);
    return blocks;
  }

  async finalize(runId: string, input: FinalizeInput): Promise<void> {
    this.finalized = true;
    this.finalizeCalls.push({ runId, input });
  }

  getInvocation(toolCallId: string): FakeInvocationRecord | undefined {
    return this.invocationsByKey.get(`${this.run.id}:${toolCallId}`);
  }
}
