import { beforeEach, describe, expect, it } from "vitest";
import { createKey, MAX_ACTIVE_API_KEYS_PER_USER, revokeKey } from "@/services/api-keys";
import { createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

describe("API key cap", () => {
  it(`allows ${MAX_ACTIVE_API_KEYS_PER_USER} active keys, rejects the next, and frees a slot on revoke`, async () => {
    const user = await createUser();
    const keys = [];
    for (let i = 0; i < MAX_ACTIVE_API_KEYS_PER_USER; i++) keys.push(await createKey(user.id, `key ${i}`));
    await expect(createKey(user.id, "one too many")).rejects.toMatchObject({ code: "validation_error", details: { reason: "too_many_api_keys" } });
    await revokeKey(user.id, keys[0]!.id);
    await expect(createKey(user.id, "after revoke")).resolves.toMatchObject({ name: "after revoke" });
  });
});
