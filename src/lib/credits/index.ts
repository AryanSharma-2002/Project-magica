import type { LedgerEntry } from "@agent-chat/contracts";
import type { CreditPort } from "@/agent/loop/ports";
import { prisma, mc, Prisma, type Db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { errors } from "@/lib/errors";
import { serializeLedgerEntry } from "@/services/serializers";
import { keysetOrderBy, keysetWhere, paginate, parseCursor } from "@/services/pagination";
import type { CreditLedger, LedgerEntryType } from "@/generated/prisma/client";

/**
 * Credit ledger (backend-core slice). Every write is one transaction that:
 *  (a) locks the user row (`SELECT ... FOR UPDATE`),
 *  (b) inserts a CreditLedger row with a deterministic idempotencyKey — if it already exists the
 *      whole call is a no-op returning the existing state,
 *  (c) updates User.creditBalance,
 *  (d) for reserves, throws `insufficient_credits` when balance < amount.
 * Amount signs: reserve/charge negative, grant/release positive.
 */

type WriteLedgerArgs = {
  userId: string;
  type: LedgerEntryType;
  amount: bigint;
  idempotencyKey: string;
  description: string;
  runId?: string | null;
  toolInvocationId?: string | null;
  /** Reserve-type writes enforce sufficient balance; releases/charges/grants never block. */
  enforceSufficient: boolean;
};

async function writeLedgerEntry(tx: Db, args: WriteLedgerArgs): Promise<CreditLedger> {
  const rows = await tx.$queryRaw<Array<{ id: string; creditBalance: bigint }>>`
    SELECT "id", "creditBalance" FROM "User" WHERE "id" = ${args.userId} FOR UPDATE
  `;
  const user = rows[0];
  if (!user) throw errors.notFound("User");

  const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey: args.idempotencyKey } });
  if (existing) return existing;

  const newBalance = user.creditBalance + args.amount;
  if (args.enforceSufficient && newBalance < 0n) {
    throw errors.insufficientCredits(Number(-args.amount), Number(user.creditBalance));
  }

  const entry = await tx.creditLedger.create({
    data: {
      userId: args.userId,
      type: args.type,
      amount: args.amount,
      balanceAfter: newBalance,
      idempotencyKey: args.idempotencyKey,
      description: args.description,
      runId: args.runId ?? null,
      toolInvocationId: args.toolInvocationId ?? null,
    },
  });
  await tx.user.update({ where: { id: args.userId }, data: { creditBalance: newBalance } });
  return entry;
}

async function runInTx<T>(tx: Db | undefined, fn: (db: Db) => Promise<T>): Promise<T> {
  if (tx) return fn(tx);
  return prisma.$transaction((t) => fn(t));
}

/** Signup grant on first authenticated request. Idempotent on `grant:signup:<userId>`. */
export async function grantSignup(userId: string, tx?: Db): Promise<void> {
  await runInTx(tx, (db) =>
    writeLedgerEntry(db, {
      userId,
      type: "GRANT",
      amount: BigInt(getEnv().SIGNUP_GRANT_MICROCREDITS),
      idempotencyKey: `grant:signup:${userId}`,
      description: "Signup grant",
      enforceSufficient: false,
    }),
  );
}

/** Admission reservation at send time. Idempotent on `reserve:<runId>`. */
export async function reserveAdmission(args: { userId: string; runId: string; microcredits: number }, tx?: Db): Promise<void> {
  await runInTx(tx, (db) =>
    writeLedgerEntry(db, {
      userId: args.userId,
      type: "RESERVE",
      amount: -BigInt(args.microcredits),
      idempotencyKey: `reserve:${args.runId}`,
      description: "Admission reservation",
      runId: args.runId,
      enforceSufficient: true,
    }),
  );
}

/** Releases the full admission reservation back to the user. Idempotent on `release:<runId>`. */
export async function releaseAdmission(args: { userId: string; runId: string; microcredits: number }, tx?: Db): Promise<void> {
  await runInTx(tx, (db) =>
    writeLedgerEntry(db, {
      userId: args.userId,
      type: "RELEASE",
      amount: BigInt(args.microcredits),
      idempotencyKey: `release:${args.runId}`,
      description: "Admission release",
      runId: args.runId,
      enforceSufficient: false,
    }),
  );
}

export async function balance(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { creditBalance: true } });
  if (!user) throw errors.notFound("User");
  return mc(user.creditBalance);
}

export async function listLedger(userId: string, cursor: string | undefined, limit: number): Promise<{ items: LedgerEntry[]; nextCursor: string | null }> {
  const decoded = parseCursor(cursor);
  const rows = await prisma.creditLedger.findMany({
    where: { userId, ...keysetWhere<Prisma.CreditLedgerWhereInput>(decoded, "desc") },
    orderBy: keysetOrderBy<Prisma.CreditLedgerOrderByWithRelationInput>("desc"),
    take: limit + 1,
  });
  const page = paginate(rows, limit);
  return { items: page.items.map(serializeLedgerEntry), nextCursor: page.nextCursor };
}

export function createCreditPort(): CreditPort {
  return {
    balance,
    async reserveInvocation(args: { userId: string; runId: string; invocationId: string; microcredits: number }): Promise<void> {
      await prisma.$transaction((tx) =>
        writeLedgerEntry(tx, {
          userId: args.userId,
          type: "RESERVE",
          amount: -BigInt(args.microcredits),
          idempotencyKey: `reserve:${args.invocationId}`,
          description: "Tool reservation",
          runId: args.runId,
          toolInvocationId: args.invocationId,
          enforceSufficient: true,
        }),
      );
    },
    async settleInvocation(args: { userId: string; runId: string; invocationId: string; estimated: number; charged: number }): Promise<void> {
      await prisma.$transaction(async (tx) => {
        await writeLedgerEntry(tx, {
          userId: args.userId,
          type: "RELEASE",
          amount: BigInt(args.estimated),
          idempotencyKey: `release:${args.invocationId}`,
          description: "Tool estimate release",
          runId: args.runId,
          toolInvocationId: args.invocationId,
          enforceSufficient: false,
        });
        await writeLedgerEntry(tx, {
          userId: args.userId,
          type: "CHARGE",
          amount: -BigInt(args.charged),
          idempotencyKey: `charge:${args.invocationId}`,
          description: "Tool charge",
          runId: args.runId,
          toolInvocationId: args.invocationId,
          enforceSufficient: false,
        });
      });
    },
    async releaseInvocation(args: { userId: string; runId: string; invocationId: string; estimated: number }): Promise<void> {
      await prisma.$transaction((tx) =>
        writeLedgerEntry(tx, {
          userId: args.userId,
          type: "RELEASE",
          amount: BigInt(args.estimated),
          idempotencyKey: `release:${args.invocationId}`,
          description: "Tool release",
          runId: args.runId,
          toolInvocationId: args.invocationId,
          enforceSufficient: false,
        }),
      );
    },
  };
}
