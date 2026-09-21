# Migrations

Prisma owns the schema (`prisma/schema.prisma`); every change ships as an executable SQL migration in this folder and is applied with `pnpm db:deploy` (`prisma migrate deploy`). Never run `prisma migrate dev` against a shared database: it is interactive and may reset data.

## Forward

1. Edit `schema.prisma`, then `pnpm db:migrate` locally to author the SQL (interactive, local only). Review the generated SQL; hand-write anything Prisma cannot express (raw constraints, generated columns, partial indexes) inside the same migration file.
2. Commit the migration folder together with the schema and the regenerated client usage.
3. Deploy order: `pnpm db:deploy` against the target database **before** the new application version and the new Trigger.dev tasks start. `migrate deploy` is idempotent and safe to run on every deploy.

## Rollback

Prisma has no down migrations. The rollback path is:

- **Application first.** Redeploy the previous application and task versions. Every migration so far is additive or backward compatible (see below), so the previous code runs against the newer schema.
- **Schema, only if required.** Write a new forward migration that reverses the change (drop the column/index/table), review it, and deploy it the same way. Do not delete or edit an applied migration file; `_prisma_migrations` records checksums and a modified file fails `migrate deploy`.
- **Data.** For destructive changes take a snapshot (managed Postgres point-in-time restore, or `pg_dump` before `db:deploy`) and restore from it if the forward migration must be undone with its data.

## Compatibility assumptions

- PostgreSQL 14 or newer. The init migration uses a `GENERATED ALWAYS AS (...) STORED` `tsvector` column with a GIN index for message search, `pg_trgm` for title search, and partial unique indexes (one active run per chat, idempotency keys). Managed providers (Neon, Supabase, RDS) support all of these; `pg_trgm` must be creatable by the migration role.
- Money is stored as `BIGINT` microcredits; the contracts expose `number` (safe below 2^53).
- JSONB columns hold only contract-validated content (message blocks, tool payloads, waitpoint prompts). Their shapes are versioned by the Zod contracts in `packages/contracts`, not by SQL migrations; a contract change that must read old rows adds a parser fallback rather than a data migration.
- `_prisma_migrations` is the source of truth for what is applied; `prisma migrate status` shows drift.

## Migration log

| Migration | Kind | Notes |
|---|---|---|
| `20260919072128_init` | initial | Full schema: users, chats, messages, runs, tool invocations, waitpoints, attachments, skills, credit ledger, rate-limit buckets, API keys, webhook endpoints and deliveries. Includes raw SQL for the generated search column, GIN/trigram indexes and partial unique indexes. |
