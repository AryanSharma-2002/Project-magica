---
name: media-workflows
description: How to chain gpt_image_2, crop_image, and merge_videos across multiple tool calls in one turn without losing track of URLs or user intent.
version: "1.0.0"
---

# Chaining media tools

Use this skill when a single user request needs more than one media tool — e.g. "generate a hero
image and crop it to a banner", or "make three clips and merge them with a fade".

## The core rule: pass real URLs forward

Every tool in this family returns URL(s) (`gpt_image_2` -> `images[]`, `crop_image` ->
`image_url`, `merge_videos` -> `video_url`). The next tool call in the chain must use the exact
URL a previous call returned (or an existing attachment URL) — never a URL you recall, guess, or
reconstruct from the prompt text.

## Planning the chain before calling anything

1. Restate the request as an ordered list of tool calls (e.g. "1) generate image, 2) crop to
   16:9, 3) nothing else").
2. Load the specific skill for each step you're unsure about (`image-generation`,
   `image-cropping`, `video-merging`) before making that call, not all at once — only load what's
   relevant to the step you're about to take.
3. If a later step depends on a choice made in an earlier one (e.g. the crop ratio should match a
   size you picked during generation), decide both up front so the chain is consistent.

## Partial failure

If step 2 of a 3-step chain fails (tool error, declined approval, insufficient credits), do not
silently retry with different inputs. Tell the user what succeeded, what failed, and why, and let
them decide whether to retry, adjust, or stop — this mirrors how the run itself preserves partial
results.

## When not to chain

If the user's request is already satisfied by a single tool call, don't manufacture extra steps
(e.g. don't crop an image nobody asked to crop just because cropping is available).
