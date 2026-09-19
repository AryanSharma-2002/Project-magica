import type { WaitpointResolution } from "@agent-chat/contracts";
import type { WaitpointAsk, WaitpointPort } from "@/agent/loop/ports";

export type WaitpointOutcome = { kind: "resolved"; resolution: WaitpointResolution } | { kind: "expired" } | { kind: "cancelled" };
export type WaitpointScriptEntry = WaitpointOutcome | ((ask: WaitpointAsk, callIndex: number) => WaitpointOutcome);

let waitpointCounter = 0;

export class FakeWaitpoints implements WaitpointPort {
  asks: WaitpointAsk[] = [];

  constructor(private readonly script: WaitpointScriptEntry[]) {}

  async ask(args: WaitpointAsk): ReturnType<WaitpointPort["ask"]> {
    const index = this.asks.length;
    this.asks.push(args);
    const entry = this.script[Math.min(index, this.script.length - 1)];
    if (!entry) throw new Error("FakeWaitpoints: no script entry configured");
    const outcome = typeof entry === "function" ? entry(args, index) : entry;
    waitpointCounter += 1;
    return { waitpointId: `wp_${waitpointCounter}`, outcome };
  }
}

export function approve(): WaitpointOutcome {
  return { kind: "resolved", resolution: { type: "approval", approved: true } };
}
export function decline(): WaitpointOutcome {
  return { kind: "resolved", resolution: { type: "approval", approved: false } };
}
export function approvePlan(): WaitpointOutcome {
  return { kind: "resolved", resolution: { type: "plan", approved: true } };
}
export function declinePlan(): WaitpointOutcome {
  return { kind: "resolved", resolution: { type: "plan", approved: false } };
}
export function expired(): WaitpointOutcome {
  return { kind: "expired" };
}
export function cancelled(): WaitpointOutcome {
  return { kind: "cancelled" };
}
