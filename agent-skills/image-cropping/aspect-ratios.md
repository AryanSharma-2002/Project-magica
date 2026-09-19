# Common aspect ratios

| Name | Ratio | Decimal | Typical use |
|---|---|---|---|
| Square | 1:1 | 1.000 | avatar, Instagram post |
| Standard photo | 4:3 | 1.333 | classic photo/print |
| Classic portrait | 3:4 | 0.750 | print portrait |
| Widescreen | 16:9 | 1.778 | video thumbnail, presentation |
| Vertical video | 9:16 | 0.563 | story/reel/short |
| Landscape photo | 3:2 | 1.500 | DSLR photo default |
| Portrait photo | 2:3 | 0.667 | poster |
| Ultra-wide | 21:9 | 2.333 | cinematic banner (near the 3:1 generation limit) |

## Worked example

Source image: 1600x1200 (ratio 1.333). Target: 16:9 (1.778).

1. `W/H = 1.333 < 16/9 = 1.778` -> image is relatively too tall for the target; keep full width,
   crop height.
2. `newH = W * (9/16) = 1600 * 0.5625 = 900`.
3. `y = (1200 - 900) / 2 = 150`, `x = 0`.
4. As pixels: `{ x_px: 0, y_px: 150, width_px: 1600, height_px: 900 }`.
5. As percent: `{ x_percent: 0, y_percent: 12.5, width_percent: 100, height_percent: 75 }`.
