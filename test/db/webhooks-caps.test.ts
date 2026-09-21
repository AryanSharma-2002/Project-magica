import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns", () => ({
  default: { promises: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) } },
}));
vi.mock("@trigger.dev/sdk", () => ({
  tasks: { trigger: vi.fn(async () => ({ id: "trg_1" })) },
}));

import { createEndpoint, MAX_WEBHOOK_ENDPOINTS_PER_USER } from "@/services/webhooks";
import { createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

/** Security review 2026-09-21: every event fans out to every subscribed endpoint, so endpoints per user are capped. */
describe("webhook endpoint cap", () => {
  it(`allows ${MAX_WEBHOOK_ENDPOINTS_PER_USER} endpoints and rejects the next one as validation_error`, async () => {
    const user = await createUser();
    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS_PER_USER; i++) {
      await createEndpoint(user.id, { url: `https://example.com/hook/${i}`, events: ["agent.completed"] });
    }
    await expect(createEndpoint(user.id, { url: "https://example.com/hook/extra", events: ["agent.completed"] })).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "too_many_endpoints", max: MAX_WEBHOOK_ENDPOINTS_PER_USER },
    });
  });

  it("the cap is per user", async () => {
    const a = await createUser({ clerkUserId: "user_a" });
    const b = await createUser({ clerkUserId: "user_b" });
    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS_PER_USER; i++) {
      await createEndpoint(a.id, { url: `https://example.com/a/${i}`, events: ["agent.completed"] });
    }
    await expect(createEndpoint(b.id, { url: "https://example.com/b/0", events: ["agent.completed"] })).resolves.toMatchObject({ url: "https://example.com/b/0" });
  });
});
