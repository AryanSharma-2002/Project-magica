import { z } from "zod";
import { HttpsUrl } from "@agent-chat/contracts";

/**
 * Catalog field shape from GET /v1/models/catalog (public, no auth). See ARCHITECTURE.md §5.3
 * and the task brief for the field vocabulary. Kept intentionally permissive (`type`/`dataType`
 * are `string`, not enums) because the live catalog can add field kinds; unrecognized kinds fall
 * back to `z.unknown()` rather than throwing, so a resolveInputSchema() call never hard-fails on
 * a catalog addition.
 */
export type CatalogFieldOption = { value: string | number; label: string } | string | number;

export type CatalogField = {
  zodExpectedName: string;
  type: string;
  dataType: string;
  required?: boolean;
  default?: unknown;
  options?: CatalogFieldOption[];
  min?: number;
  max?: number;
  step?: number;
  /** Verified live: this is the option VALUE that unlocks customFields (e.g. "Custom"), not a boolean flag. */
  customValue?: string | boolean;
  customFields?: CatalogField[];
  maxImages?: number;
  maxItems?: number;
};

function optionValue(o: CatalogFieldOption): string | number {
  return typeof o === "object" && o !== null ? o.value : o;
}

function isAllNumbers(values: Array<string | number>): values is number[] {
  return values.every((v) => typeof v === "number");
}

/** Base (non-optional, no default applied) Zod type for a single catalog field, ignoring nesting. */
function baseFieldSchema(field: CatalogField): z.ZodTypeAny {
  switch (field.type) {
    case "textarea":
    case "text":
      return z.string();

    case "select": {
      const values = (field.options ?? []).map(optionValue);
      if (values.length === 0) return z.string();
      if (field.dataType === "number" || isAllNumbers(values)) {
        const nums = values.map((v) => Number(v));
        return z.literal(nums as [number, ...number[]]);
      }
      const strs = values.map((v) => String(v));
      return z.enum(strs as [string, ...string[]]);
    }

    case "composite-select": {
      // Preset options (e.g. "1024x1024" | ... | "Custom"); customFields are flattened by the
      // caller (catalogFieldsToZod) as sibling top-level fields, mirroring GptImage2Input's
      // flat size + width/height shape. `customValue` names WHICH option value unlocks the
      // custom fields (e.g. "Custom") - that value is already one of `options`, so the enum does
      // not need widening to an arbitrary string (verified live: doing so would let a bogus
      // `size` value like "banana" pass validation and reach the provider as a 400).
      const values = (field.options ?? []).map((o) => String(optionValue(o)));
      return values.length === 0 ? z.unknown() : z.enum(values as [string, ...string[]]);
    }

    case "slider":
    case "number": {
      let n = z.number();
      if (field.min !== undefined) n = n.min(field.min);
      if (field.max !== undefined) n = n.max(field.max);
      if (field.step !== undefined && field.step > 0) n = n.multipleOf(field.step);
      return n;
    }

    case "image":
    case "video":
    case "audio": {
      const isArray = field.dataType === "string[]";
      if (isArray) {
        let arr = z.array(HttpsUrl);
        const limit = field.maxItems ?? field.maxImages;
        if (limit !== undefined) arr = arr.max(limit);
        // `.min(1)` only for REQUIRED arrays. An optional media array can carry a catalog `default: []`
        // (verified live: gpt-image-2-edit's `uploadedImages`), and once one parse materializes that
        // `[]` the value must re-parse cleanly - the magica-tool child task re-validates the parent's
        // parsed input. Callers treat an empty optional array as "absent" (gpt_image_2 subModelIdFor).
        if (field.required) arr = arr.min(1);
        return arr;
      }
      return HttpsUrl;
    }

    default:
      return z.unknown();
  }
}

/**
 * Applies required/default/optional per `mode`. `required: true` always wins over a UI `default`
 * (verified live: crop_image's `image_url` and gpt-image-2's `prompt` both carry `required: true`
 * together with a `default: ""` - that default is a form-UI initial value, not a signal that the
 * field may be omitted at execution time).
 */
function applyModifiers(schema: z.ZodTypeAny, field: CatalogField, mode: "input" | "output"): z.ZodTypeAny {
  if (field.required) return schema;
  if (mode === "input" && field.default !== undefined) {
    return schema.default(field.default as never);
  }
  return schema.optional();
}

export type CatalogSchemaMode = { mode: "input" | "output" };

/**
 * Converts `inputFieldOptions` (or `outputFieldOptions`) from the Magica catalog into a flat Zod
 * object. `mode: "input"` (default) applies catalog defaults via `.default()` so the resulting
 * schema is usable directly as a tool's live input schema (matches ToolRegistry's `io: "input"`
 * JSON-schema conversion, which keeps defaulted fields optional for the LLM). `mode: "output"`
 * skips defaulting (only `required` matters) - for validating `outputFieldOptions`-shaped data.
 *
 * `composite-select` fields (e.g. gpt-image-2's `size`) get their `customFields` (e.g. width/
 * height) flattened onto the *same* returned object, matching GptImage2Input's flat shape.
 */
export function catalogFieldsToZod(fields: CatalogField[], opts: CatalogSchemaMode = { mode: "input" }): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    shape[field.zodExpectedName] = applyModifiers(baseFieldSchema(field), field, opts.mode);
    if (field.type === "composite-select" && field.customFields) {
      for (const cf of field.customFields) {
        // customFields are always optional numbers per the task brief, regardless of `required`.
        shape[cf.zodExpectedName] = applyModifiers(baseFieldSchema({ ...cf, type: cf.type || "number" }), { ...cf, required: false }, opts.mode);
      }
    }
  }
  return z.object(shape);
}
