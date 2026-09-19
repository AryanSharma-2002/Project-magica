# Pre-flight checklist for merge_videos

Before calling the tool, confirm:

- [ ] Every clip the user wants included has a known, ready URL (attachment or prior tool output).
- [ ] The array order matches the user's intended final sequence.
- [ ] The count is between 2 and 100.
- [ ] A transition choice was made deliberately (`none` by default), not left to guesswork if the
      user specified one.
- [ ] No non-video URL (image, audio-only file) is included in `video_urls`.
- [ ] If any clip is still processing/uploading, wait or tell the user rather than passing a URL
      that isn't ready yet — a not-ready input will fail the tool call.

After the call, the single `video_url` in the output is the merged result — pass that forward if
the user chains another step (e.g. "now crop a thumbnail from it" applies to a *frame* of the
video, which is outside this tool's scope; say so rather than guessing).
