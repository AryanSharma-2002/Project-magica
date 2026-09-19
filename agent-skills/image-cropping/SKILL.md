---
name: image-cropping
description: How to choose and compute crop rectangles for the crop_image tool — percent vs. pixel crops, aspect-ratio math, and centered crops.
version: "1.0.0"
---

# Image cropping

Use this skill before calling `crop_image`. The tool accepts exactly **one** complete rectangle
mode — never mix modes, and never send a partial rectangle.

## Choosing a mode

- **Percent** (`x_percent`, `y_percent`, `width_percent`, `height_percent`, each 0-100): use when
  you don't know the source image's pixel dimensions, or the user described the crop relatively
  ("crop the left third", "just the top half"). All four fields are required together.
- **Pixel** (`x_px`, `y_px`, `width_px`, `height_px`): use when you know the exact source
  dimensions (e.g. from an attachment's metadata) and the user gave (or you computed) exact pixel
  coordinates. `width_px`/`height_px` are required; `x_px`/`y_px` are optional and default to a
  centered crop when omitted.
- **`crop{}` object** (`{ x, y, width, height }`, all percent 0-100): equivalent to the percent
  mode but as a single nested object — some callers find this clearer for "crop a region defined
  as a rectangle" requests.

Never populate fields from more than one mode in the same call — the contract rejects that.

## Aspect-ratio math

To crop to a target aspect ratio `targetW:targetH` from an image of size `W x H`:

1. Compute the current ratio `W/H` vs. the target ratio `targetW/targetH`.
2. If `W/H > targetW/targetH`, the image is relatively too wide — keep full height, crop width:
   `newW = H * (targetW/targetH)`, then center: `x = (W - newW) / 2`, `y = 0`.
3. Otherwise the image is relatively too tall — keep full width, crop height:
   `newH = W * (targetH/targetW)`, then center: `x = 0`, `y = (H - newH) / 2`.
4. Convert to percent (`x/W*100`, etc.) if you don't have exact pixels, or use the pixel fields
   directly if you do. See `aspect-ratios.md` for common ratio pairs and their formulas.

## Centered crops

"Center crop to WxH" (fixed output size, not a ratio) with a known source size:
`x_px = round((W - width_px) / 2)`, `y_px = round((H - height_px) / 2)` — or simply omit `x_px`/
`y_px` and let the tool center it for you.

## Bounds checking

Percent crops must satisfy `x_percent + width_percent <= 100` and
`y_percent + height_percent <= 100` (same for `crop{}`). If your computed rectangle would exceed
the image bounds, clamp the origin first (`x = min(x, 100 - width)`), not the width — shrinking
the crop changes what the user asked for.

## Chaining

If the crop is a step in a larger request (generate then crop, or crop then merge into a video),
pass the *actual* URL the previous tool returned as `image_url` — never a URL you remember or
guess.
