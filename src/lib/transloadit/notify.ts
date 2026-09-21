/**
 * Parsing helpers for the Assembly Status JSON that Transloadit posts to `notify_url`
 * (https://transloadit.com/docs/topics/assembly-notifications/). The full shape is large and
 * partly undocumented in the notify context (some fields are stripped via `notification_payload`
 * template options); this only types the subset we actually read, and is permissive about
 * everything else. Never trust this data for anything beyond what it is used for here (it comes
 * from an unauthenticated request whose signature has already been checked by the caller).
 */

export type TransloaditResultFile = {
  id?: string;
  name?: string;
  basename?: string;
  original_name?: string;
  ext?: string;
  size?: number;
  mime?: string;
  url?: string;
  ssl_url?: string;
  meta?: { width?: number; height?: number; duration?: number };
};

export type TransloaditAssemblyStatus = {
  ok?: string;
  error?: string;
  message?: string;
  assembly_id: string;
  fields?: Record<string, unknown>;
  results?: Record<string, TransloaditResultFile[]>;
  /** Files received by `/upload/handle` (the `:original` step). Verified live 2026-09-21: a completed
   * Assembly whose only step is `:original` reports `results: {}` and lists the files HERE, so this
   * is the primary source for the no-storage-step configuration. */
  uploads?: TransloaditResultFile[];
};

export class MalformedAssemblyStatusError extends Error {
  constructor() {
    super("Malformed Transloadit assembly status payload");
    this.name = "MalformedAssemblyStatusError";
  }
}

/** Parses the (already signature-verified) raw `transloadit` field string into a status object. */
export function parseAssemblyStatus(raw: string): TransloaditAssemblyStatus {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new MalformedAssemblyStatusError();
  }
  if (!json || typeof json !== "object" || typeof (json as Record<string, unknown>).assembly_id !== "string") {
    throw new MalformedAssemblyStatusError();
  }
  return json as TransloaditAssemblyStatus;
}

/**
 * `store` results when a storage step ran; otherwise the `/upload/handle` files. Transloadit reports
 * those under `uploads` (and, depending on the plan/step naming, sometimes ALSO as
 * `results[":original"]`), so both are consulted.
 */
export function pickResultFiles(assembly: TransloaditAssemblyStatus): TransloaditResultFile[] {
  const results = assembly.results ?? {};
  const original = results[":original"];
  if (results.store && results.store.length > 0) return results.store;
  if (original && original.length > 0) return original;
  return assembly.uploads ?? [];
}

export function assemblyFailed(assembly: TransloaditAssemblyStatus): boolean {
  return Boolean(assembly.error);
}

/**
 * Pairs pre-created Attachment rows (in position order) with result files, matched by
 * original filename first, falling back to sequential order for anything left unmatched.
 * Duplicate filenames within one assembly are resolved positionally.
 */
export function matchAttachmentsToResults<T extends { position: number; filename: string }>(
  attachments: readonly T[],
  results: readonly TransloaditResultFile[],
): Array<{ attachment: T; result: TransloaditResultFile | undefined }> {
  const remaining = [...results];
  const sorted = [...attachments].sort((a, b) => a.position - b.position);
  return sorted.map((attachment) => {
    const idx = remaining.findIndex((r) => (r.original_name ?? r.name ?? r.basename) === attachment.filename);
    if (idx >= 0) {
      const [result] = remaining.splice(idx, 1);
      return { attachment, result };
    }
    const result = remaining.shift();
    return { attachment, result };
  });
}
