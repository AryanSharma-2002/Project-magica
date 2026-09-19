import { AppError } from "@/lib/errors";
import type { CreditPort } from "@/agent/loop/ports";

export class FakeCredits implements CreditPort {
  balanceValue: number;
  reserved: Array<{ invocationId: string; microcredits: number }> = [];
  settled: Array<{ invocationId: string; estimated: number; charged: number }> = [];
  released: Array<{ invocationId: string; estimated: number }> = [];

  constructor(balance: number) {
    this.balanceValue = balance;
  }

  async balance(_userId: string): Promise<number> {
    return this.balanceValue;
  }

  async reserveInvocation(args: { userId: string; runId: string; invocationId: string; microcredits: number }): Promise<void> {
    if (this.balanceValue < args.microcredits) {
      throw new AppError("insufficient_credits", "You do not have enough credits for this action.", {
        details: { required: args.microcredits, available: this.balanceValue },
      });
    }
    this.balanceValue -= args.microcredits;
    this.reserved.push({ invocationId: args.invocationId, microcredits: args.microcredits });
  }

  async settleInvocation(args: { userId: string; runId: string; invocationId: string; estimated: number; charged: number }): Promise<void> {
    this.balanceValue += args.estimated - args.charged;
    this.settled.push({ invocationId: args.invocationId, estimated: args.estimated, charged: args.charged });
  }

  async releaseInvocation(args: { userId: string; runId: string; invocationId: string; estimated: number }): Promise<void> {
    this.balanceValue += args.estimated;
    this.released.push({ invocationId: args.invocationId, estimated: args.estimated });
  }
}
