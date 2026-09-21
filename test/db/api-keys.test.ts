import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { authenticator } from "@/lib/auth/index";
import { createKey, listKeys, revokeKey } from "@/services/api-keys";
import { createUser, resetDb } from "../helpers/db";

beforeEach(async () => {
  await resetDb();
});

function bearerRequest(token: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/completions", { headers: { authorization: `Bearer ${token}` } });
}

describe("api-keys service", () => {
  it("create returns the plaintext key once and stores only its hash", async () => {
    const user = await createUser();

    const created = await createKey(user.id, "CI key");
    expect(created.key).toBeTruthy();
    expect(created.key?.startsWith("ak_live_")).toBe(true);
    expect(created.prefix).toBe(created.key?.slice(0, 12));
    expect(created.revokedAt).toBeNull();

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.hashedKey).not.toBe(created.key);
    expect(row.hashedKey).toHaveLength(64); // sha256 hex
    expect((row as unknown as { key?: string }).key).toBeUndefined();
  });

  it("list hides plaintext and includes revoked keys", async () => {
    const user = await createUser();
    const a = await createKey(user.id, "key a");
    const b = await createKey(user.id, "key b");
    await revokeKey(user.id, b.id);

    const list = await listKeys(user.id);
    expect(list.items).toHaveLength(2);
    for (const item of list.items) {
      expect(item.key).toBeUndefined();
    }
    const revoked = list.items.find((i) => i.id === b.id);
    expect(revoked?.revokedAt).not.toBeNull();
    const active = list.items.find((i) => i.id === a.id);
    expect(active?.revokedAt).toBeNull();
  });

  it("revoke is idempotent", async () => {
    const user = await createUser();
    const key = await createKey(user.id, "key");

    await revokeKey(user.id, key.id);
    const first = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(first.revokedAt).not.toBeNull();

    await revokeKey(user.id, key.id); // second call: no-op, does not throw
    const second = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(second.revokedAt?.getTime()).toBe(first.revokedAt?.getTime());
  });

  it("cross-user revoke is not_found and leaves the key untouched", async () => {
    const owner = await createUser();
    const other = await createUser();
    const key = await createKey(owner.id, "owner's key");

    await expect(revokeKey(other.id, key.id)).rejects.toMatchObject({ code: "not_found" });

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.revokedAt).toBeNull();
  });

  it("a revoked key fails apiKey authentication with unauthorized", async () => {
    const user = await createUser();
    const key = await createKey(user.id, "key");
    const plaintext = key.key!;

    // Works before revocation.
    const principal = await authenticator(bearerRequest(plaintext), "apiKey");
    expect(principal).toMatchObject({ kind: "apiKey", userId: user.id });

    await revokeKey(user.id, key.id);

    await expect(authenticator(bearerRequest(plaintext), "apiKey")).rejects.toMatchObject({ code: "unauthorized" });
  });
});
