import { DEFAULT_LIMITS, type AppLimits } from "@agent-chat/contracts";
import type { RunDeps } from "@/agent/loop/ports";
import { FakeCredits } from "./credits";
import { FakeDurable, type DurableHandler } from "./durable";
import { noopLoggerForTests } from "./logger";
import { FakeRealtime } from "./realtime";
import { makeFakeSkillRegistry } from "./skills";
import { FakeStore, type FakeStoreOptions } from "./store";
import { buildTestRegistry } from "./tools";
import { FakeWaitpoints, type WaitpointScriptEntry } from "./waitpoints";
import type { AnyToolDefinition } from "@/agent/tools/types";
import type { LlmProvider } from "@/agent/llm/types";
import type { SkillRegistry } from "@/agent/skills/types";

export type TestHarnessOptions = {
  store: FakeStoreOptions;
  llm: LlmProvider;
  tools?: AnyToolDefinition[];
  skills?: SkillRegistry;
  balance?: number;
  waitpointScript?: WaitpointScriptEntry[];
  durableHandler?: DurableHandler;
  now?: () => Date;
  signal?: AbortSignal;
  limits?: Partial<AppLimits>;
  /** Use a pre-built FakeStore (e.g. with a method overridden) instead of constructing one from `store`. */
  storeOverride?: FakeStore;
};

export function buildTestHarness(opts: TestHarnessOptions) {
  const store = opts.storeOverride ?? new FakeStore(opts.store);
  const credits = new FakeCredits(opts.balance ?? 1_000_000_000);
  const realtime = new FakeRealtime();
  const waitpoints = new FakeWaitpoints(opts.waitpointScript ?? []);
  const durable = new FakeDurable(
    opts.durableHandler ??
      (async () => {
        throw new Error("no durable handler configured for this test");
      }),
  );
  const tools = buildTestRegistry(opts.tools ?? []);
  const skills = opts.skills ?? makeFakeSkillRegistry();

  const deps: RunDeps = {
    llm: opts.llm,
    tools,
    skills,
    store,
    credits,
    realtime,
    durable,
    waitpoints,
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
    signal: opts.signal ?? new AbortController().signal,
    log: noopLoggerForTests(),
    ...(opts.now ? { now: opts.now } : {}),
  };

  return { deps, store, credits, realtime, waitpoints, durable, tools };
}
