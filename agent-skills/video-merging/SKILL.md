---
name: video-merging
description: How to order clips, choose a transition, and validate inputs before calling merge_videos.
version: "1.0.0"
---

# Video merging

Use this skill before calling `merge_videos`.

## Ordering

`video_urls` is an ordered array — the output preserves that order exactly. Before calling the
tool, restate the intended order back to yourself from the user's request ("intro, then product
shot, then outro") and make sure the array matches it. If the user reorders clips mid-conversation
("actually put the outro first"), rebuild the whole array — don't try to patch indices.

## Transitions

- `"none"`: hard cut between clips. Use by default, or when the user wants a fast-paced edit.
- `"fade"`: each clip fades to black/from black at the join. Use for calmer, deliberate pacing
  (intros, outros, mood pieces).
- `"dissolve"`: cross-dissolve directly from one clip into the next (no black frame). Use when the
  user wants a smoother, more cinematic join between visually related clips.

One transition setting applies to every join in the sequence — you cannot mix transitions between
different pairs of clips in a single call.

## Clip count

`video_urls` must contain between 2 and 100 entries. If the user gives only one clip, there is
nothing to merge — clarify or use it as-is rather than calling the tool. If they give more than
100, ask which clips to drop or whether to merge in batches (merge the first 100, then merge that
result with the remainder).

## Checking inputs are ready

Every URL must point to a clip the user actually has — either an attachment already marked ready,
or the output of an earlier tool call in this same turn (e.g. a `gpt_image_2` or prior
`merge_videos` result used as a "clip" is not valid; only video URLs belong here). Never invent or
guess a URL. See `checklist.md` for the full pre-flight list.
