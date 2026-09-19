# Delivery plan

Evaluation weights: architecture 25 · fidelity 20 · reliability 20 · code quality 15 · completeness 10 · polish 10.

## Phase 0 — Spine (done, human/lead-authored)
- Toolchain pinned and compiling in both repos (Next 16, Prisma 7, Trigger v4, Zod 4).
- `packages/contracts` (Zod), Prisma schema + init migration with raw-SQL constraints, `route()` wrapper, tool registry core, skill/LLM interfaces, stream definition, ARCHITECTURE.md.

## Phase 1 — Core build (parallel, disjoint ownership)
| Slice | Owns | Must not touch |
|---|---|---|
| B1 backend-core | `src/lib/auth/**`, `src/lib/rate-limit.ts`, `src/lib/credits/**`, `src/services/{chats,messages,runs,credits,search}.ts`, `src/app/api/v1/{config,chats,runs,waitpoints,credits,search}/**` | contracts, schema, agent/**, trigger/** |
| B2 agent-engine | `src/agent/skills/**` (impl), `src/agent/llm/openrouter.ts`, `src/agent/loop/**`, `agent-skills/**`, prompt assembly | contracts, schema, trigger/**, services/** |
| B3 magica-durable | `src/agent/providers/magica/**`, `src/agent/tools/definitions/**`, `src/agent/tools/index.ts`, `src/trigger/{agent-turn,magica-tool}.task.ts`, `src/services/attachments.ts` + attachment routes | contracts, schema, loop internals (calls B2's exported `runAgentTurn`) |
| F1 frontend-shell | app routes, Clerk, shell/sidebar, services, queries, stores, realtime hook, message list + block renderers | contracts (vendored, read-only) |
| F2 frontend-composer | composer, Uppy uploads, media picker, waitpoint overlays, tool cards, artifact panel | services/api-client (read-only) |

Definition of done per slice: `pnpm typecheck && pnpm lint && pnpm test` green; tests listed in ARCHITECTURE.md §8/§12 for the slice; no edits to spine files.

## Phase 2 — Integration & hardening
End-to-end against real Clerk/Trigger/OpenRouter/Magica/Transloadit dev credentials; acceptance conversations (one per tool + chained); failure fixtures (401/429/timeout/failed run/duplicate dispatch/reconnect); Playwright smoke; public API + webhooks + Mintlify docs (`docs/`).

## Phase 3 — Fidelity & polish
Side-by-side with app.magica.com (trial login required): tokens, spacing, empty/loading states, copy, tool-card hierarchy, overlays, keyboard behavior. README (setup, architecture, trade-offs, improvements), demo video, Vercel + Trigger deploys, working credentials.

## Blockers to clear before Phase 2
GitHub auth for repo creation; service credentials (Clerk, Trigger.dev, OpenRouter, Magica trial key, Transloadit, Postgres host); Galaxy/Magica trial login for the fidelity pass.
