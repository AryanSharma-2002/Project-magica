---
name: image-generation
description: Prompting and parameter rules for generating or editing images with GPT Image 2 (the gpt_image_2 tool) — sizes, quality, background, custom dimensions, and when to use edit mode.
version: "1.0.0"
---

# Image generation (GPT Image 2)

Use this skill before calling `gpt_image_2` whenever the user asks to create a new image or
transform an existing one.

## Mode: text vs. edit

- No `image_urls` provided -> text-to-image mode. Write a self-contained prompt: subject,
  composition, lighting, style/medium, mood. Do not assume the model remembers earlier turns —
  restate everything that matters.
- One or more `image_urls` provided -> edit mode. The prompt should describe the *change*
  relative to the input image(s) ("replace the background with a snowy forest, keep the subject
  unchanged"), not a from-scratch description. Only pass URLs that came from an attachment or a
  prior tool output — never invent a URL.

## Size

- Default to `"Auto"` unless the user states an aspect ratio or exact dimensions.
- Use one of the fixed presets (see `size-presets.md`) whenever the request maps cleanly onto one
  (square avatar, portrait poster, widescreen banner, ...).
- Use `"Custom"` with explicit `width`/`height` only when the user needs a size the presets don't
  cover. Custom size constraints (enforced by the contract, but plan around them so you don't
  retry blindly):
  - `width` and `height` must each be between 1024 and 3840 pixels.
  - Both must be multiples of 16.
  - The long side divided by the short side must be <= 3:1 (no extreme panoramas).
  - Total pixel count must land between roughly 655,360 and 8,294,400.
  - Pick numbers already divisible by 16 up front (e.g. round a requested 1000x2200 to
    1008x2192) instead of submitting and hoping validation rounds it for you.

## Quality and background

- `quality`: `"High"` for anything final/customer-facing, `"Medium"` for drafts/iteration,
  `"Low"` only when the user explicitly wants speed over fidelity.
- `background`: `"Transparent"` only for assets meant to be composited elsewhere (logos, stickers,
  cutouts) and only with `output_format` `"PNG"` or `"WebP"` (JPEG has no alpha channel). Otherwise
  leave `"Auto"`.

## Multiple variations

- `n` > 1 generates independent variations of the same prompt. Use it when the user wants options
  to choose from; keep `n: 1` when they described one specific outcome.

## Output format

- `"PNG"` for anything that might need transparency or further editing/cropping.
- `"JPEG"` for photographic results where file size matters and there is no transparency.
- `"WebP"` when the user asks for web-optimized output.

## After generating

If the user's next request is a crop or a merge into a video, chain directly into the
`image-cropping` or `video-merging` skill and reuse the URL(s) `gpt_image_2` returned — never
re-describe the image from memory.
