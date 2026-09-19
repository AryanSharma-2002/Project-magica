import type { DurableExecutor } from "@/agent/loop/ports";
import type { ToolContext, ToolExecutionResult } from "@/agent/tools/types";

export type DurableHandler = (args: { invocationId: string; toolName: string; input: unknown; ctx: ToolContext }) => Promise<ToolExecutionResult<unknown>>;

export class FakeDurable implements DurableExecutor {
  calls: Array<{ invocationId: string; toolName: string; input: unknown }> = [];

  constructor(private readonly handler: DurableHandler) {}

  async execute(args: { invocationId: string; toolName: string; input: unknown; ctx: ToolContext }): Promise<ToolExecutionResult<unknown>> {
    this.calls.push({ invocationId: args.invocationId, toolName: args.toolName, input: args.input });
    return this.handler(args);
  }
}
