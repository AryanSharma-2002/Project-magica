# GPT Image 2 size presets

| Preset | Pixels | Aspect ratio | Typical use |
|---|---|---|---|
| `Auto` | model-chosen | model-chosen | default; let the model pick a sensible size |
| `1024x1024` | 1,048,576 | 1:1 | avatars, icons, square social posts |
| `1536x1024` | 1,572,864 | 3:2 | landscape photo, blog header |
| `1024x1536` | 1,572,864 | 2:3 | portrait poster, mobile wallpaper |
| `2048x2048` | 4,194,304 | 1:1 | high-res square print |
| `2048x1152` | 2,359,296 | 16:9 | widescreen banner, presentation slide |
| `2160x3840` | 8,294,400 | 9:16 | vertical video thumbnail, story/reel cover |
| `3840x2160` | 8,294,400 | 16:9 | 4K widescreen banner |

## Custom size checklist

Only reach for `Custom` when no preset above fits. Before submitting:

1. Round both `width` and `height` to the nearest multiple of 16.
2. Check `max(width, height) / min(width, height) <= 3`.
3. Check `width * height` is between 655,360 and 8,294,400.
4. If the requested ratio is more extreme than 3:1, tell the user you're generating the closest
   supported ratio instead of silently cropping later — cropping to a different ratio is a
   separate step (see the `image-cropping` skill).
