# Agent Chat — Architecture (canonical)

This document is the source of truth for both repositories:

- **agent-chat-backend** (this repo): Next.js 16 route handlers (`/api/v1/*`), Prisma 7 + PostgreSQL, Trigger.dev v4 tasks, the agent engine, skills, credits, public API, Mintlify docs.
- **agent-chat-frontend**: Next.js 16 App Router UI. Consumes `@agent-chat/contracts` (vendored copy, see §10) and never redefines a shape.

Pinned toolchain (do not drift without updating this file): Node 24, pnpm 12.4, TypeScript 5.9, Next 16.3, React 19.3, Zod 4.6, Prisma 7.10 (`prisma-client` generator + `@prisma/adapter-pg`), `@trigger.dev/sdk` 4.6, `@trigger.dev/react-hooks` 4.6, `@clerk/nextjs` 7.9 / `@clerk/backend` 3.18, TanStack Query 5, Zustand 5, Tailwind 4, shadcn, Uppy 6, Vitest 5, Playwright 1.63.

---

## 1. System overview

```
 Browser (frontend, Vercel)                     Backend API (Next.js route handlers, Vercel)
 ┌──────────────────────────────┐   REST/JSON    ┌──────────────────────────────────────────┐
 │ Clerk session                │──────────────▶ │ route(): CORS · traceId · auth · Zod     │
 │ TanStack Query + services    │◀────────────── │ services/* (chats, messages, runs, ...)  │
 │ Zustand (ui/composer/runs)   │                │ Prisma ─────────────────▶ PostgreSQL     │
 │ useRealtimeRun/useRealtimeStream            │ tasks.trigger(agent-turn, idempotencyKey)│
 │ Uppy + Transloadit (tus)     │                └──────────────┬───────────────────────────┘
 └───────────┬──────────────────┘                               │ dispatch
             │ realtime (public token)                          ▼
             │                                   Trigger.dev (durable tasks)
             │                                   ┌──────────────────────────────────────────┐
             └──────────────────────────────────▶│ agent-turn: restore session → LLM loop   │
                metadata + agent-text stream      │   ├─ OpenRouter (openrouter/free) stream │
                                                  │   ├─ load_skill / read_skill_asset       │
                                                  │   ├─ magica-tool child task (idempotent) │
                                                  │   │    POST /v1/nodes/{type}/run → poll  │
                                                  │   └─ wait.forToken (approval waitpoint)  │
                                                  │ persist blocks/usage/credits → Postgres  │
                                                  └──────────────────────────────────────────┘
```

**Key rule:** the REST request starts durable work and returns fast. Realtime is transport only. PostgreSQL is the durable source of truth; every realtime fact is reconstructible from the database.

## 2. Repository layout

### Backend
```
packages/contracts/src/      Zod contracts (THE contract; vendored into the frontend)
prisma/schema.prisma         data model; prisma/migrations/*  (hand-edited SQL for partial index + tsvector)
src/lib/                     env, db, logger, errors, http (route wrapper), auth/, rate-limit, credits, idempotency
src/agent/tools/             types.ts, registry.ts, definitions/*.ts, index.ts (the registry instance)
src/agent/skills/            types.ts, registry.ts, loader-tools.ts
src/agent/llm/               types.ts, openrouter.ts
src/agent/loop/              orchestrator: prompt assembly, agent loop, tool execution, persistence checkpoints
src/agent/providers/magica/  client.ts (run/poll/estimate/catalog), schema-from-catalog.ts
src/trigger/                 streams.ts, agent-turn.task.ts, magica-tool.task.ts, webhook-deliver.task.ts
src/services/                chats, messages, runs, attachments (transloadit), credits, search, webhooks, api-keys
src/app/api/v1/**/route.ts   thin: route(spec, handler) → service call
agent-skills/<name>/SKILL.md 3+ skills with optional assets
docs/                        Mintlify (docs.json, mdx, openapi.json)
test/                        vitest (unit + DB integration against agent_chat_test)
```

### Frontend
```
src/contracts/               VENDORED from backend packages/contracts/src — never edited by hand (pnpm contracts:sync)
src/services/                api-client.ts + one module per resource; the ONLY place fetch() is called
src/queries/                 TanStack Query hooks + query key factory
src/stores/                  Zustand: ui, composer, runs
src/realtime/                useRunRealtime (Trigger hooks + reconciliation + REST fallback)
src/components/shell|sidebar|composer|messages|blocks|tools|waitpoints|artifacts|ui
src/app/(chat)/…             routes: /, /chat/[chatId]; sign-in/up (Clerk)
```

## 3. Contracts (packages/contracts)

- `blocks.ts` — `ContentBlock` discriminated union: `text | thinking | reasoning | tool_use | tool_result | citation | usage | asset | error`. `Message.content` is `ContentBlock[]`, ordered by array position. Every block emitted during a run has a stable **index** (its array position) that realtime and persistence share.
- `entities.ts` — `Chat`, `Message`, `Attachment`, `AgentRun`, `ToolInvocation`, `LedgerEntry`, `SkillDescriptor`.
- `waitpoints.ts` — `WaitpointPrompt`/`WaitpointResolution` discriminated by type (`approval | options | plan | credit`). Adding a waitpoint type = one variant + one renderer.
- `tools.ts` — input/output schemas for `crop_image`, `gpt_image_2`, `merge_videos`, `load_skill`, `read_skill_asset`; `ToolDescriptor`; `CreditModel`.
- `realtime.ts` — `RunMetadata` (Trigger run metadata, ≤256 KB) and `TextChunk` (typed stream `agent-text`).
- `api.ts` — request/response for every route; `AppConfig` (limits/models/tools/skills are backend-owned).
- `errors.ts` — `ErrorCode`, `SafeError`, `ApiErrorEnvelope`, HTTP status map.
- `pagination.ts` — `CursorQuery`, `Page(T)`, `encodeCursor/decodeCursor` (isomorphic, base64url of `createdAt|id`).
- `limits.ts` — `AppLimits` + `DEFAULT_LIMITS`, `ModelInfo` (only `openrouter/free`).

Money is **integer microcredits** (1 credit = 1,000,000 µc) everywhere; DB columns are `BigInt`, contracts use `number` (safe < 2^53).

## 4. Data model (Prisma) — decisions

- `User(clerkUserId unique, creditBalance BigInt)`; balance is a cache of `SUM(CreditLedger.amount)` updated in the same transaction.
- `Chat` soft-deletes (`deletedAt`). Lists page on `(lastMessageAt DESC, id)`; index `(userId, deletedAt, lastMessageAt DESC, id)`.
- `Message` pages newest-first on `(chatId, createdAt DESC, id)`. `textContent` (plain text projection) feeds the generated `searchVector tsvector` + GIN index (raw SQL). Tool activity lives **inside the assistant message** as blocks; a separate `TOOL` role exists for the public API only.
- `AgentRun` ↔ user message (1:1), assistant message (1:1, created as a `PENDING` placeholder at send time). `idempotencyKey` unique (dispatch), `triggerRunId` unique. **One active run per chat** = partial unique index `AgentRun_one_active_per_chat` on `(chatId) WHERE status IN (QUEUED,RUNNING,WAITING,STOPPING)`; the losing concurrent send gets `run_active`.
- `ToolInvocation` unique `(runId, toolCallId)` → parallel tool calls can never duplicate work or charges. Stores sanitized `input`, `output`, `providerRunId` (Magica runId), estimates/charges, `blockIndex`.
- `RunSkill` unique `(runId, skillName, assetPath)` with `contentHash` → dedupe + identical guidance on retry/resume.
- `Waitpoint` unique `triggerTokenId`; `status` is the idempotency gate for completion.
- `CreditLedger` append-only, `idempotencyKey` unique: `reserve:<runId>`, `release:<runId>`, `reserve:<invocationId>`, `charge:<invocationId>`, `release:<invocationId>`, `grant:signup:<userId>`, `refund:<...>`.
- `RateLimitBucket` = DB token bucket (no Redis on the free stack).
- JSONB only for: `Message.content` (ContentBlocks), `ToolInvocation.input/output/error`, `AgentRun.usage/error`, `Waitpoint.prompt/resolution`, `Attachment.meta`. Every JSONB write goes through the matching Zod schema.

Migrations: forward = `prisma migrate deploy`. Rollback notes and compatibility assumptions (PG ≥ 12, `pg_trgm`) are at the bottom of the init migration.

## 5. Turn lifecycle

### 5.1 `POST /api/v1/chats/:chatId/messages` (send)
1. `route()` → auth (Clerk JWT) → Zod `SendMessageRequest` (text ≤ limits, ≤10 attachment ids, `model === "openrouter/free"`, `planMode`).
2. Rate limit (`RateLimitBucket`, e.g. 20 sends/min/user) → `rate_limited` + `Retry-After`.
3. `Idempotency-Key` header (or server-generated) → if an `AgentRun` with that key exists, return it with `deduplicated: true`.
4. Ownership: chat belongs to user, not deleted. Attachments belong to user and are `READY`.
5. Stale-lock recovery: if an active run exists and `heartbeatAt` is older than 5 min, mark it `FAILED` (`stale_run_recovered`), finalize its assistant message, release its reservation. Otherwise if an active run exists → `run_active`.
6. **One transaction**: create user `Message(COMPLETED)` + assistant `Message(PENDING, content: [])` → create `AgentRun(QUEUED)` (the partial unique index is the race arbiter; a unique violation on it maps to `run_active`) → reserve admission (`reserve:<runId>`, `ADMISSION_MICROCREDITS`; `insufficient_credits` rolls the whole transaction back — the ledger row references the run, so the run must exist first) → link attachments to the user message → bump `Chat.lastMessageAt` (+ title from first message). `AgentRun.idempotencyKey` is namespaced `${userId}:${chatId}:${clientKey}` so one user's key can never replay another user's run.
7. `tasks.trigger("agent-turn", { runId }, { idempotencyKey: run.idempotencyKey, tags: [`chat:${chatId}`, `user:${userId}`] })` → store `triggerRunId`.
8. Mint `auth.createPublicToken({ scopes: { read: { runs: [triggerRunId] } }, expirationTime: "1h" })`.
9. Return `SendMessageResponse { chatId, messageId, assistantMessageId, runId, realtime }`.

### 5.2 `agent-turn` task (Trigger.dev, `maxDuration` 3600, `retry.maxAttempts 1` — retries are managed inside)
1. Load run + chat + last N messages (bounded window, e.g. 40 messages / token budget) + attachments + already-loaded `RunSkill`s. Transition `QUEUED → RUNNING`, set `startedAt`, `heartbeatAt`.
2. Assemble prompt: system (persona + policy + **skill index** names/descriptions + tool policy + date), history as `LlmMessage[]`, user attachments as URLs.
3. Loop (≤ `maxTurnsPerRun` = 12):
   - Stream OpenRouter (`openrouter/free`, tools from registry, `parallel_tool_calls: true`). `text_delta`/`thinking_delta` → append to current block and `agentTextStream.append({t,i,d})`. Update metadata (`step`, `thinkingMs`).
   - Provider failures: 429/5xx/empty → bounded retry (3 attempts, exp backoff 1s→8s, jitter), then terminal `provider_unavailable` with a clear message (no paid fallback). Malformed tool arguments → one repair round (tool result with the validation issues), then `malformed_tool_call`.
   - `finish: tool_calls` → for each call in order: create `ToolInvocation` (unique `(runId,toolCallId)`), `tool_use` block (index assigned in call order), estimate cost, check balance (mid-turn exhaustion → stop safely, settle completed work, finalize `FAILED insufficient_credits` preserving partial output), approval policy (§7) → possibly waitpoint. Execute **in parallel** (`Promise.allSettled`, concurrency ≤ 4). `tool_result` blocks are appended in **call order** regardless of completion order. Generated media → `Attachment(GENERATED)` rows + `asset` blocks. Charges settle exactly once per invocation.
   - Checkpoint after every loop step: `UPDATE Message SET content=blocks, status=STREAMING`; `metadata.persistedUpTo`; `heartbeatAt = now()`.
   - Between steps and inside streams: check `cancelRequestedAt` → abort signal → finalize `CANCELLED` with partial content.
4. Terminal: append `usage` block (µc = 0, `model` = routed model), set assistant message `COMPLETED|FAILED|CANCELLED`, run status + `usage` + `routedModel` + `finishedAt`, release unused admission (`release:<runId>`), emit webhooks (`agent.completed|failed`), final `metadata.set`.
5. Any thrown error → catch → finalize `FAILED` with `SafeError`, keep all streamed blocks. `onFailure`/`onCancel` hooks do the same finalization idempotently (status transitions are `WHERE status IN (active)`).

### 5.3 Magica tools — `magica-tool` child task
- Orchestrator: `magicaToolTask.triggerAndWait({ invocationId }, { idempotencyKey: invocationId, idempotencyKeyTTL: "24h" })`. Duplicate dispatch returns the same child run.
- Child: load invocation; if already terminal → return stored result (idempotent). Else `POST {MAGICA_BASE_URL}/v1/nodes/{nodeType}/run` with `Authorization: Bearer` (server-side only), persist `providerRunId` immediately, then poll `GET /v1/nodes/runs/{runId}` with backoff (1s → 5s, cap 10 min), cancellation-aware. Map `401 → provider_error (not retryable, message "Media provider rejected the request")`, `429 → provider_rate_limited (retry ≤3)`, `403 → insufficient provider credits → provider_error`, timeout → `timeout`, `FAILED → provider_error` with the run's `userMessage`. Outputs are normalized (`string | string[]` → contract). `creditUsed` (microcredits) is the settled charge.
- Node contracts: `crop_image` (`image_url` + one complete rectangle: percent / pixel / `crop{}`), `gpt_image_2` (`subModelId` = `gpt-image-2-text` or `gpt-image-2-edit` when `image_urls` present → provider field `uploadedImages`; field options are **resolved from the public catalog** `GET /v1/models/catalog` → `inputFieldOptions` with a 10-min cache, baseline Zod as fallback), `merge_videos` (2–100 ordered `video_urls`, `transition none|fade|dissolve`, order preserved).
- Never log/persist/echo the Magica key. Persist sanitized input, `runId`, status, duration, µc, result URLs, user-safe error.

### 5.4 Waitpoints (human decisions)
1. Orchestrator: `const token = await wait.createToken({ timeout: "10m", idempotencyKey: `wp:${invocationId}` })` → insert `Waitpoint(PENDING, triggerTokenId)` → run status `WAITING`, metadata.waitpoint set → `const r = await wait.forToken<WaitpointResolution>(token)`.
2. `POST /api/v1/waitpoints/:id/complete` (owner only): **atomic** `UPDATE Waitpoint SET status=COMPLETED, resolution=$1, resolvedAt=now() WHERE id=$2 AND status='PENDING' RETURNING *`. If 0 rows → return the current row (idempotent 200; duplicate submissions are no-ops). Then `wait.completeToken(triggerTokenId, resolution)`; a failure of `completeToken` after a successful transition is logged and retried once — the DB transition is the truth.
3. Timeout (`r.ok === false`) → `Waitpoint EXPIRED`, tool invocation `CANCELLED`, run `FAILED` with `waitpoint_expired` and message "Approval timed out. Send a new message to continue." UI clears the overlay.
4. Approval declined → invocation `CANCELLED`, tool_result `cancelled`, loop continues so the model can respond.

### 5.5 Cancellation
`POST /runs/:id/cancel` → `UPDATE AgentRun SET status=STOPPING, cancelRequestedAt=now() WHERE id AND status IN (QUEUED,RUNNING,WAITING)`; if `WAITING`, cancel the waitpoint (transition + `completeToken` with `{type, approved:false}`-equivalent). The task observes `STOPPING` at the next check (≤ 1 s during streaming via AbortSignal) and finalizes `CANCELLED`. No `runs.cancel()` on Trigger — we want the finalization path to run. A `QUEUED` run that never started is finalized directly by the route.

## 6. Realtime & recovery

- Channels: `RunMetadata` via Trigger run metadata under the key **`run`** (`metadata.set("run", state)`, throttled to ≤ 2/s; the frontend reads `run.metadata.run`), and `TextChunk` via `agentTextStream` (`streams.define`, id `agent-text`, written through one long-lived `writer()` session per run). Child tasks may additionally publish `tool:<invocationId>` progress on the parent metadata; readers ignore unknown keys.
- Frontend `useRunRealtime(run)` = `useRealtimeRun(triggerRunId)` + `useRealtimeStream(agentTextStream, triggerRunId)`. Live view builds blocks by `index`: text/thinking from chunks, tool/asset/reasoning from metadata. Ordering is by `index`, always.
- **Reconciliation rule:** while a run is active, the assistant message renders from the live view (stream replayed from index 0 on reload) and the persisted `content` of that message is ignored. On terminal status → invalidate messages/chat/balance queries → render persisted content only. No duplicate terminal bubbles.
- **Reload / navigation:** `GET /chats/:id` returns `activeRunId`; `GET /runs/:id` returns the run + `realtime` token → resubscribe. Persisted partial content (checkpointed every loop step) is shown until the stream connects.
- **Transport failure:** hooks report an error → bounded reconnect (3 tries, 1s/2s/4s) with token refresh (`POST /runs/:id/realtime-token`) → fallback polling `GET /runs/:id` + messages every 2 s until terminal. Free tier: 10 concurrent realtime connections — the fallback path is first-class, not an afterthought.

## 7. Credits

- Signup grant (`grant:signup:<userId>`) on first authenticated request. Balance = `User.creditBalance` (cached ledger sum).
- Send: reserve admission (`ADMISSION_MICROCREDITS`). Terminal: release remainder (`release:<runId>`).
- Per tool: `estimate` (Magica `POST /v1/nodes/estimate-credits`, fallback: catalog `cost`) → `reserve:<invocationId>` → execute → `release:<invocationId>` (+estimate) and `charge:<invocationId>` (−actual `creditUsed`) in one transaction. Idempotency keys make settlement exactly-once under retries.
- OpenRouter usage recorded in `usage` block / `AgentRun.usage` at **0 µc**.
- Approval policy: `requiresApproval: "always" | "above_threshold" (estimate > APPROVAL_THRESHOLD_MICROCREDITS) | "never"`; `planMode` forces a `plan` waitpoint before the first tool executes.
- Insufficient: block before persistence at send (admission) and before each tool (estimate) with `insufficient_credits` and a clear message; mid-turn exhaustion stops safely and preserves partial results.

## 8. Skills

- `agent-skills/<name>/SKILL.md` with YAML frontmatter `name`, `description`, optional `version`; optional assets in the same folder (`.md .txt .json .yaml .csv`, ≤ 64 KiB each).
- Registry scans approved roots at startup: validates frontmatter (Zod), folder name == `name`, size bounds, rejects duplicates, exposes only `SkillDescriptor`s.
- Base prompt receives **names + descriptions only**. Model calls `load_skill{name}` / `read_skill_asset{name,path}` (typed tools, `group: skills`, inline execution, free).
- Security: `path.resolve(dir, rel)` must start with `dir + sep`; reject `..`, absolute paths, symlinks escaping, unsupported extensions, oversized files.
- Durability: each load upserts `RunSkill(runId, skillName, assetPath, contentHash)`; repeated loads return the cached body (dedupe) and on retry/resume the same hashes are restored into the prompt.
- Ship ≥3 skills: `image-generation`, `image-cropping`, `video-merging` (+ optional `media-workflows`). Tests: selective loading, malformed frontmatter, duplicate/unknown skill, traversal, dedupe, durable resume.

## 9. API surface (`/api/v1`, all JSON, all Zod-validated in and out)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | |
| GET | `/config` | any | `AppConfig` — limits, models, tool descriptors, skills |
| GET/POST | `/chats` | clerk | list (cursor, `pinned`, `q`) / create |
| GET/PATCH/DELETE | `/chats/:chatId` | clerk | includes `activeRunId`; PATCH title/pinned; DELETE soft |
| GET | `/chats/:chatId/messages` | clerk | newest-first, `cursor` for older |
| POST | `/chats/:chatId/messages` | clerk | send (§5.1), `Idempotency-Key` |
| GET | `/runs/:runId` | any | `AgentRun` (+ tool invocations, waitpoint, skills) |
| POST | `/runs/:runId/cancel` | clerk | |
| POST | `/runs/:runId/realtime-token` | clerk | refresh public token |
| POST | `/waitpoints/:id/complete` | clerk | idempotent |
| POST | `/attachments/assembly` | clerk | signed Transloadit params (HMAC-SHA384) + pre-created rows |
| POST | `/attachments/uploaded` | clerk | client completion; server reconciles with Assembly status |
| POST | `/attachments/transloadit/notify` | signature | Transloadit `notify_url` → READY/FAILED, result URLs, expiry |
| GET | `/attachments` | clerk | media library picker (cursor, kind, source) |
| GET | `/credits/balance`, `/credits/ledger` | clerk | |
| GET | `/search?q=` | clerk | tsvector on messages + trigram on titles, cursor |
| POST | `/completions` | apiKey | public: message → run (202 + status URL) |
| POST | `/tools/:name/run` | apiKey | public: standalone Magica tool invocation |
| GET/POST/DELETE | `/webhooks` | apiKey/clerk | endpoints; outbound events signed `X-AgentChat-Signature: t=<ts>,v1=<hmac-sha256>` |

Errors: `ApiErrorEnvelope { error: { code, message, retryable, details?, traceId } }`, status from `HTTP_STATUS_BY_CODE`. Unauthorized access to another user's resource → `not_found` (non-leaking).

## 10. Contract sharing between repos

The backend owns `packages/contracts`. The frontend vendors a copy at `src/contracts/` via `pnpm contracts:sync [<backend-path-or-git-url>] [<ref>]`, which copies `packages/contracts/src/*`, and writes `contracts.lock.json { source, ref, sha256 }`. CI (`pnpm contracts:check`) fails if the vendored tree hash differs from the lock. Frontend code imports `@/contracts` only. Rationale: zero install-time coupling (works on Vercel and on a fresh evaluator clone), one command to bump, verifiable.

## 11. Frontend design

- **Services** (`src/services/*.ts`): the only `fetch` callers. `apiFetch({ path, method, query, body, schema, idempotencyKey, signal })` adds the Clerk token, parses the response with the contract schema, and throws `ApiError` (from `ApiErrorEnvelope`).
- **Queries** (`src/queries`): key factory `qk.chats.list(filters)`, `qk.messages(chatId)`, `qk.run(runId)`, `qk.config`, `qk.balance`; infinite queries for chats & messages (messages newest-first pages rendered reversed); mutations with optimistic user message + placeholder assistant bubble; `useSendMessage` stores the `SendMessageResponse` in the runs store.
- **Stores** (Zustand, small): `ui` (sidebar, artifact panel, active overlay), `composer` (draft per chat, attachments in flight, planMode), `runs` (active run per chat: `{runId, triggerRunId, token, expiresAt}` — server-owned truth is `Chat.activeRunId`; the store is a cache).
- **Rendering registries:** `blockRenderers: Record<ContentBlockType, Component>`, `toolCards: Record<ToolName, Component>` (default JSON card), `waitpointRenderers: Record<WaitpointType, Component>`. Adding a tool/waitpoint type touches only the registry.
- **Message list:** `@tanstack/react-virtual`, reverse infinite scroll, pinned composer, scroll-to-bottom when at bottom, `aria-live="polite"` for streaming text, distinct visual states for thinking / active tool / completed tool / failed tool.
- **Composer:** multiline (Enter send, Shift+Enter newline), OpenRouter status pill (from `/config` models), attachments (Uppy Dashboard-less custom UI with Tus + Transloadit plugin using `assemblyOptions` from the backend), media picker (`/attachments`), plan mode toggle, send / stop (cancel) / interrupt states.
- **Accessibility:** focus trap in overlays, Esc closes/stops, keyboard nav in sidebar, screen-reader labels, visible error recovery (retry buttons on failed turns).
- **Fidelity:** design tokens in `globals.css`; the pixel pass against app.magica.com happens once the trial login is available (screenshots side-by-side). Components must not hardcode spacing outside tokens.

## 12. Reliability matrix (brief §11 → mechanism)

| Scenario | Mechanism |
|---|---|
| Model/tool timeout | provider-level timeouts, bounded retries only for idempotent calls, terminal `provider_unavailable`/`timeout` with clear copy; no paid fallback |
| All paths fail | catch-all finalization persists `FAILED` assistant turn with streamed text, tool results, assets |
| Unauthorized access | ownership filters in every query → `not_found` |
| Concurrent send | partial unique index + stale-lock recovery (heartbeat > 5 min) |
| Over-limit message/attachment | Zod at the route, before any write |
| Mid-turn credit exhaustion | estimate check before each tool → stop safely, settle, preserve |
| REST/realtime network error | bounded backoff, token refresh, REST polling fallback, durable reconciliation |
| Unanswered waitpoint | 10-min token timeout → `waitpoint_expired`, overlay cleared, guidance copy |
| Diagnosability | `SafeError` on run + per invocation, `traceId` header, structured logs with chatId/runId/messageId/traceId/processId/waitpointTokenId |

## 13. Scale notes

Stateless API + durable tasks: 1,000 concurrent turns = 1,000 Trigger runs (free tier caps at 20 concurrent runs and 10 realtime connections; paid tiers raise both — no code change). Reads are cursor-paginated with composite indexes; the conversation window sent to the model is bounded; realtime metadata is bounded (≤ 20 assets, ≤ 50 reasoning entries, 256 KB); message content is capped at 2,000 blocks. Registry lookups are O(1) maps; 100 tools/skills only grow the base prompt by their descriptions (skills) and JSON schemas (tools).

## 14. Non-goals (per brief)
No extra tools, no UI redesign, no MongoDB, no paid LLM fallback, no client-side provider keys.
