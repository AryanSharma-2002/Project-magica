import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { type ApiErrorEnvelope } from "@agent-chat/contracts";
import { AppError } from "./errors";
import { getEnv } from "./env";
import { logger, type Logger } from "./logger";
import { authenticate, type AuthMode, type Principal } from "./auth";

/**
 * Every route handler is built with `route()`. It owns: CORS, traceId, auth, Zod parsing of
 * params/query/body, Zod validation of the response, and the error envelope.
 * Handlers never touch NextResponse directly.
 */

export type RouteContext<P, Q, B> = {
  req: NextRequest;
  params: P;
  query: Q;
  body: B;
  principal: Principal;
  traceId: string;
  log: Logger;
  idempotencyKey: string | null;
};

export type RouteSpec<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType, R extends z.ZodType> = {
  auth: AuthMode;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  status?: number;
};

type Params = Record<string, string | string[]>;
type Handler<P, Q, B, R> = (ctx: RouteContext<P, Q, B>) => Promise<R>;

export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": getEnv().FRONTEND_ORIGIN,
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,idempotency-key,x-trace-id",
    "access-control-expose-headers": "x-trace-id",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function newTraceId(): string {
  return crypto.randomUUID();
}

export function errorResponse(err: unknown, traceId: string, log?: Logger): NextResponse<ApiErrorEnvelope> {
  const app = AppError.from(err);
  if (app.status >= 500) (log ?? logger({ traceId })).error({ err: app.cause ?? app, code: app.code }, app.message);
  else (log ?? logger({ traceId })).warn({ code: app.code }, app.message);
  const body: ApiErrorEnvelope = { error: { ...app.toSafe(), traceId } };
  const headers: Record<string, string> = { ...corsHeaders(), "x-trace-id": traceId };
  const retryAfter = app.details?.retryAfterSeconds;
  if (typeof retryAfter === "number") headers["retry-after"] = String(retryAfter);
  return NextResponse.json(body, { status: app.status, headers });
}

export function route<P extends z.ZodType = z.ZodType<Params>, Q extends z.ZodType = z.ZodType<Record<string, never>>, B extends z.ZodType = z.ZodType<undefined>, R extends z.ZodType = z.ZodType>(
  spec: RouteSpec<P, Q, B, R>,
  handler: Handler<z.output<P>, z.output<Q>, z.output<B>, z.input<R>>,
) {
  return async (req: NextRequest, ctx: { params: Promise<Params> }): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? newTraceId();
    let log = logger({ traceId });
    try {
      const principal = await authenticate(req, spec.auth);
      log = logger({ traceId, userId: principal.userId });

      const rawParams = await ctx.params;
      const params = (spec.params ? spec.params.parse(rawParams) : rawParams) as z.output<P>;
      const query = (spec.query ? spec.query.parse(Object.fromEntries(req.nextUrl.searchParams)) : {}) as z.output<Q>;
      let body = undefined as z.output<B>;
      if (spec.body) {
        const text = await req.text();
        let json: unknown = undefined;
        if (text.length > 0) {
          try {
            json = JSON.parse(text);
          } catch {
            throw new AppError("validation_error", "Body must be valid JSON");
          }
        }
        body = spec.body.parse(json) as z.output<B>;
      }
      const idempotencyKey = req.headers.get("idempotency-key");
      const result = await handler({ req, params, query, body, principal, traceId, log, idempotencyKey });
      const validated = spec.response.parse(result);
      return NextResponse.json(validated, { status: spec.status ?? 200, headers: { ...corsHeaders(), "x-trace-id": traceId } });
    } catch (err) {
      return errorResponse(err, traceId, log);
    }
  };
}

/** 204 helper for deletes. */
export function noContent(traceId: string): Response {
  return new Response(null, { status: 204, headers: { ...corsHeaders(), "x-trace-id": traceId } });
}
