# Working in agent-chat-backend

1. Read `ARCHITECTURE.md` first. It is canonical; if code and doc disagree, fix the code or update the doc in the same change.
2. Spine files are read-only unless your task says otherwise: `packages/contracts/**`, `prisma/schema.prisma`, `prisma/migrations/**`, `src/lib/{env,db,logger,errors,http,auth}.ts`, `src/agent/tools/{types,registry}.ts`, `src/agent/skills/types.ts`, `src/agent/llm/types.ts`, `src/agent/loop/ports.ts`, `src/trigger/streams.ts`, `trigger.config.ts`, `next.config.ts`, `tsconfig.json`.
3. Next.js 16 differs from your training data (async `params`, `proxy.ts`, Turbopack). Read `node_modules/next/dist/docs/` before writing route code.
4. Every route = `route(spec, handler)` from `src/lib/http.ts`. Every JSONB write goes through a contract schema. Every error is an `AppError`.
5. Money is integer microcredits; DB `BigInt`, contracts `number` (use `mc()` from `src/lib/db.ts`).
6. Definition of done: `pnpm typecheck && pnpm lint && pnpm test` green, tests for your slice present, no edits outside your ownership.
