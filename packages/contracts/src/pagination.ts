import { z } from "zod";

export const PAGE_LIMIT_DEFAULT = 30;
export const PAGE_LIMIT_MAX = 100;

/** Opaque cursor: base64url("<createdAt ISO>|<id>"). Stable under concurrent inserts. */
export const Cursor = z.string().min(1).max(256);

export const CursorQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

export function Page<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: Cursor.nullable() });
}
export type Page<T> = { items: T[]; nextCursor: string | null };

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Isomorphic (browser + Node) so the frontend can build cursors for optimistic pages. */
export function encodeCursor(createdAt: Date | string, id: string): string {
  const iso = typeof createdAt === "string" ? createdAt : createdAt.toISOString();
  return toBase64Url(`${iso}|${id}`);
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = fromBase64Url(cursor);
    const sep = raw.lastIndexOf("|");
    if (sep <= 0) return null;
    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
