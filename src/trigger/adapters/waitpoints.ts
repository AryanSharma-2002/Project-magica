import { wait } from "@trigger.dev/sdk";
import { WaitpointResolution, type WaitpointType as ContractWaitpointType } from "@agent-chat/contracts";
import { isUniqueViolation, Prisma, prisma } from "@/lib/db";
import { WaitpointType as PrismaWaitpointType } from "@/generated/prisma/enums";
import type { RealtimeEmitter, WaitpointAsk, WaitpointPort } from "@/agent/loop/ports";

/** Shared with the routes slice: the shape `wait.completeToken`/expiry resolves the token with. */
export type WaitpointTokenOutput = { resolution: WaitpointResolution } | { cancelled: true };

function toPrismaType(type: ContractWaitpointType): PrismaWaitpointType {
  return type.toUpperCase() as PrismaWaitpointType;
}

export type WaitpointPortDeps = { realtime: RealtimeEmitter };

/**
 * WaitpointPort over `wait.createToken`/`wait.forToken` (ARCHITECTURE.md §5.4).
 *
 * Idempotency key: NOT suffixed with a timestamp. `wp:${runId}:${toolInvocationId ?? type}` is
 * stable across retries of the *same* ask (a retried/resumed task attempt asking for the same
 * approval must rejoin the existing waitpoint token, not mint a new one every attempt - a
 * `Date.now()` suffix would defeat that and orphan the original token). `idempotencyKeyTTL: "24h"`
 * bounds how long a stale key can be reused after the fact.
 */
export function createWaitpointPort(deps: WaitpointPortDeps): WaitpointPort {
  return {
    async ask(args: WaitpointAsk) {
      const idempotencyKey = `wp:${args.runId}:${args.toolInvocationId ?? args.type}`;
      const token = await wait.createToken({
        timeout: `${args.timeoutSeconds}s`,
        idempotencyKey,
        idempotencyKeyTTL: "24h",
        tags: [`run:${args.runId}`],
      });

      const expiresAt = new Date(Date.now() + args.timeoutSeconds * 1000);
      let row = await prisma.waitpoint.findUnique({ where: { triggerTokenId: token.id } });
      if (!row) {
        try {
          row = await prisma.waitpoint.create({
            data: {
              runId: args.runId,
              toolInvocationId: args.toolInvocationId,
              type: toPrismaType(args.type),
              status: "PENDING",
              triggerTokenId: token.id,
              prompt: args.prompt as unknown as Prisma.InputJsonValue,
              expiresAt,
            },
          });
        } catch (err) {
          // `isCached` tokens (a retried attempt reusing the same idempotency key) can race a
          // concurrent create for the same triggerTokenId; fall back to reading the row that won.
          if (isUniqueViolation(err, "triggerTokenId")) {
            row = await prisma.waitpoint.findUniqueOrThrow({ where: { triggerTokenId: token.id } });
          } else {
            throw err;
          }
        }
      }

      deps.realtime.metadata({
        waitpoint: { id: row.id, type: args.type, status: "pending", expiresAt: row.expiresAt.toISOString() },
      });

      const result = await wait.forToken<WaitpointTokenOutput>(token);

      if (!result.ok) {
        await prisma.waitpoint.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "EXPIRED" } });
        return { waitpointId: row.id, outcome: { kind: "expired" as const } };
      }
      if ("cancelled" in result.output) {
        return { waitpointId: row.id, outcome: { kind: "cancelled" as const } };
      }
      const resolution = WaitpointResolution.parse(result.output.resolution);
      return { waitpointId: row.id, outcome: { kind: "resolved" as const, resolution } };
    },
  };
}
