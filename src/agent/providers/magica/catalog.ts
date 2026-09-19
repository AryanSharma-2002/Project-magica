import { getEnv } from "@/lib/env";
import { AppError, isAbortError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { CatalogField } from "./schema-from-catalog";

/** GET /v1/models/catalog - public, no auth. */

export type MagicaCatalogSubModel = { subModelId: string; label: string; inputFieldOptions: CatalogField[] };

export type MagicaCatalogModel = {
  nodeType: string;
  defaultSubModelId?: string;
  name: string;
  /** Shape is provider-defined and not fully specified; see estimateFromCatalogCost for the best-effort arithmetic we apply. */
  cost?: unknown;
  inputFieldOptions?: CatalogField[];
  subModels?: MagicaCatalogSubModel[];
  outputFieldOptions?: CatalogField[];
};

export type MagicaCatalog = {
  version: string;
  generatedAt: string;
  models: Record<string, MagicaCatalogModel>;
};

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { catalog: MagicaCatalog; at: number } | undefined;

export async function getCatalog(opts: { signal?: AbortSignal } = {}): Promise<MagicaCatalog> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.catalog;
  try {
    const res = await fetch(`${getEnv().MAGICA_BASE_URL}/v1/models/catalog`, opts.signal ? { signal: opts.signal } : {});
    if (!res.ok) throw new Error(`Magica catalog fetch failed with status ${res.status}`);
    const json = (await res.json()) as MagicaCatalog;
    cache = { catalog: json, at: now };
    return json;
  } catch (err) {
    if (isAbortError(err)) throw new AppError("cancelled", "The operation was cancelled");
    if (cache) {
      logger().warn({ err }, "Magica catalog fetch failed; serving the stale cached catalog");
      return cache.catalog;
    }
    throw new AppError("provider_unavailable", "Could not load the media provider catalog", { retryable: true, cause: err });
  }
}

/** Looks up a model by its catalog key (e.g. "gpt-image-2") first, then by nodeType. */
export function findCatalogModel(catalog: MagicaCatalog, idOrNodeType: string): MagicaCatalogModel | undefined {
  const byKey = catalog.models[idOrNodeType];
  if (byKey) return byKey;
  return Object.values(catalog.models).find((m) => m.nodeType === idOrNodeType);
}

export function __resetMagicaCatalogCacheForTests(): void {
  cache = undefined;
}

export function __setMagicaCatalogForTests(catalog: MagicaCatalog, at = Date.now()): void {
  cache = { catalog, at };
}
