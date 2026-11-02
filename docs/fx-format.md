# sa-fx@1 — Sprite Aligner effect recipe format

`sa-fx@1` is a small JSON format for pixel-art skill effects (slashes, hit sparks, lightning, explosions, dust and
similar). A recipe is a list of **layers** drawn on a square canvas, one image per frame. The format is meant to be
read and written by hand, or by an AI from a plain description ("a blue crescent slash with a few sparks, 12 frames").
Sprite Aligner renders recipes in the browser (`js/safx.js`). Nothing else is needed.

## A complete recipe

```json
{
  "format": "sa-fx@1",
  "name": "푸른 베기",
  "size": 64,
  "frames": 12,
  "fps": 24,
  "loop": false,
  "blend": "add",
  "impactFrame": 3,
  "seed": 7,
  "palette": ["#1b2a6b", "#3f7fd1", "#a9dcff", "#f4fbff"],
  "layers": [
    { "type": "slash", "y": 0.55, "radius": 26, "aspect": 0.45, "start": -170, "sweep": 160,
      "thick": [[0, 2], [3, 11, "out"], [11, 1]],
      "head": [[0, 0], [3, 1.05, "out"], [11, 1.35]],
      "tail": [[0, 0.3], [3, 0.8], [11, 0.3]],
      "opacity": [[5, 1], [11, 0, "in"]] },
    { "type": "sparks", "y": 0.55, "w": 40, "h": 14, "count": 8, "start": 3, "life": 5, "speed": 1.2,
      "spread": 360, "shape": "streak", "opacity": [[5, 1], [11, 0]] }
  ]
}
```

## Top level

| Field | Type | Default | Meaning |
|---|---|---|---|
| `format` | `"sa-fx@1"` | required | Format marker. |
| `name` | text | `"effect"` | Display / file name. |
| `category` | text | `"기타"` | Gallery category: 베기, 찌르기, 타격·둔기, 투사체, 폭발, 화염, 전기, 얼음, 독·산, 물, 바람, 땅·바위, 빛·치유, 어둠, 먹·책략, 상태이상, 버프·디버프, 소환·순간이동, 연기·먼지, 기타 (or 삼국지 TD). |
| `tags` | text list | `[]` | Search words, e.g. `["폭발", "광역"]`. |
| `size` | 8–256 | 64 | Canvas width = height, in pixels. |
| `frames` | 1–64 | 12 | Number of frames. |
| `fps` | number | 24 | Frames per second (every frame lasts 1000 / fps ms). |
| `durations` | ms list | — | Per-frame durations; replaces `fps` (length = `frames`). |
| `loop` | bool | false | A looping effect (aura, fire) or a one-shot. |
| `blend` | `add` \| `screen` \| `normal` | `add` | How the game should draw it (`add` = glowing light; use `normal` for dark colours such as ink, smoke, dust). |
| `impactFrame` | frame | 0 | The frame where the hit lands (exported to the game; the hit sound / damage goes here). |
| `seed` | integer | 1 | Base random seed; every layer adds its own `seed`. Same seed = same picture. |
| `palette` | colour list | white-blue | Colours from **dark to bright**. Layers are drawn in these colour bands. |
| `rot` | degrees | 0 | Turns the whole finished effect. |
| `layers` | list | required | Drawn in order: later layers on top. |

## How a layer is coloured

Every layer draws a brightness value per pixel (0 = nothing, 1 = brightest; the middle of a slash or the core of a
spark is bright, edges and tails are dim). The value picks a colour band of the palette: the dimmest visible values get
the first (darkest) colour, the brightest get the last. Pixels below `cutoff` are not drawn. There is no
half-transparency: edges stay pixel-crisp, and `opacity` below 1 fades a layer with an ordered dither pattern.

## Fields every layer has

| Field | Default | Meaning |
|---|---|---|
| `type` | required | One of the layer types below. |
| `x`, `y` | 0.5 | Position as a fraction of the canvas (0 = left / top, 1 = right / bottom). |
| `from`, `to` | 0, last frame | The layer is drawn only on frames `from`..`to`. |
| `opacity` | 1 | 0–1; lower fades the layer out (dithered). |
| `palette` | recipe palette | This layer's own colours (dark → bright). |
| `color` | — | One colour for the whole layer (instead of a palette). |
| `cutoff` | 0.12 | Brightness below this is not drawn. Higher = thinner, sharper shapes. |
| `seed` | 0 | Added to the recipe seed for this layer's randomness. |
| `echo` | — | Afterimages: `{ "copies": 2, "step": 1, "decay": 0.5 }` draws the layer as it was `step`, `2×step`… frames ago, each dimmer by `decay`. |

## Keyframes (animation)

Any number can be animated by giving a list of keys instead of a number: `[frame, value]` or
`[frame, value, easing]`. Between keys the value moves from one to the next; the easing of a key shapes the move
**into** that key. Before the first key the first value holds, after the last key the last value holds.

```json
"radius": [[0, 4], [5, 24, "out"], [11, 28]]
```

Easings: `linear` (default), `in` (slow start), `out` (fast start, slow end: good for hits and explosions),
`inout`, `step` (jumps at the key).

## Layer types

Lengths are in pixels at the recipe's `size` (they scale with the size slider); angles are degrees, 0 = right,
90 = down.

### `slash` — a sweeping arc trail

The head runs along an arc (ellipse) from `start` to `start + sweep`; the trail behind it is thick in the middle
and fades to the tail.

| Field | Default | Meaning |
|---|---|---|
| `radius` | 24 | Arc radius. |
| `aspect` | 0.5 | Vertical squash of the arc (1 = circle, 0.4 = flat swing). |
| `start`, `sweep` | -160, 160 | Where the arc starts, and how far it turns (negative = the other way). |
| `rot` | 0 | Turns the arc (e.g. 90 = a vertical chop). |
| `head` | 1 | Where the head is along the arc: 0 = start, 1 = end, above 1 = past the end (the tail catches up and the trail vanishes). Animate it. |
| `tail` | 0.7 | Trail length, as a fraction of the sweep. |
| `thick` | 8 | Trail thickness. |
| `taper` | 1 | How quickly the thickness falls off toward the ends. |
| `shape` | `crescent` | `crescent` (thin moon), `halfmoon` (fat), `tapered` (thick at the head), `comet` (bright head), `ribbon` (wavy), `segmented` (broken), `jagged` (saw edge), `double` (two lines), `spiral`, `zigzag`, `ring` (full circle). |

### `line` — a straight streak (iai flash, speed lines, thrust)

| Field | Default | Meaning |
|---|---|---|
| `x0`, `y0`, `x1`, `y1` | 0.1, 0.5, 0.9, 0.5 | Start and end (fractions). |
| `head`, `tail` | 1, 1 | Like `slash`: where the head is (0–1+), and the trail length. |
| `thick` | 2 | Thickness at the head. |
| `taper` | 1 | Thinner toward the tail. |
| `count`, `spacing` | 1, 4 | Several parallel lines, `spacing` px apart (speed lines). |
| `jitter` | 0 | Random length / offset per line (px). |

### `ring` — a circle outline (shockwave, impact ring)

| Field | Default | Meaning |
|---|---|---|
| `radius` | 12 | Ring radius (animate it to expand). |
| `thick` | 2 | Line thickness. |
| `aspect` | 1 | Vertical squash (0.4 = a ring on the ground). |
| `gaps` | 0 | Breaks the ring into this many dashes. |
| `spin` | 0 | Turns the dashes (degrees). |

### `sparks` — particles

| Field | Default | Meaning |
|---|---|---|
| `count` | 10 | Number of particles. |
| `w`, `h` | 0, 0 | Size of the area they start in (px around `x`, `y`). |
| `start` | 0 | Frame they appear. |
| `stream` | 0 | 0 = all at once; N = emitted over N frames. |
| `life`, `lifeVar` | 6, 0.3 | Frames each lives (± fraction). |
| `angle`, `spread` | -90, 360 | Direction and spread of the throw (360 = all around). `outward` (bool) = away from the centre instead. |
| `speed`, `speedVar` | 1.5, 0.4 | Pixels per frame (± fraction). |
| `gravity`, `drag` | 0, 0.05 | Pull down per frame (negative rises), and slow-down per frame (0–1). |
| `size` | 1 | Particle size. |
| `shape` | `dot` | `dot`, `square`, `streak` (a line along the motion), `plus`, `diamond`. |
| `stretch` | 3 | Streak length per unit of speed. |
| `fade` | true | Dim over their life. |

### `lightning` — a jagged bolt

| Field | Default | Meaning |
|---|---|---|
| `x0`, `y0`, `x1`, `y1` | 0.5, 0, 0.5, 0.9 | Start and end. |
| `jag` | 0.4 | How far the bolt zigzags. |
| `detail` | 5 | Number of zigzag levels. |
| `branches`, `branchLen` | 2, 0.35 | Side branches and their length (fraction of the bolt). |
| `thick` | 1 | Thickness. |
| `grow` | 1 | How much of the bolt is drawn, from the start (animate 0 → 1 to strike). |
| `flicker` | 2 | New random shape every N frames (0 = never). |

### `glow` — a soft round light

| Field | Default | Meaning |
|---|---|---|
| `radius` | 12 | Size. |
| `aspect` | 1 | Vertical squash. |
| `power` | 1.5 | Higher = smaller bright core, wider dim halo. |
| `strength` | 1 | Brightness at the centre. |

### `flash` — a solid shape (impact star, spark core, burst)

| Field | Default | Meaning |
|---|---|---|
| `shape` | `star` | `circle`, `star`, `diamond`, `cross`, `square`. |
| `size` | 8 | Radius. |
| `points` | 4 | Star points. |
| `inner` | 0.35 | Star inner radius (fraction of `size`). |
| `rot`, `aspect` | 0, 1 | Turn and vertical squash. |
| `falloff` | 0.5 | 0 = flat colour; higher = brighter centre, darker edge. |
| `outline` | 0 | Draw only an outline this thick (0 = filled). |

### `smoke` — puffs of smoke or dust

| Field | Default | Meaning |
|---|---|---|
| `count` | 8 | Number of puffs. |
| `w` | 16 | Width of the area they start in. |
| `start`, `life` | 0, 10 | Frame they appear, and frames they last. |
| `rise` | 0.5 | Upward speed (px per frame; negative sinks). |
| `spread` | 1 | Sideways speed (px per frame, outward from the centre). |
| `sizeFrom`, `sizeTo` | 3, 8 | Puff radius at birth and at the end. |
| `bright` | 0.8 | Brightness (puffs dim as they age). |

### `image` — a picture or a sprite sheet

| Field | Default | Meaning |
|---|---|---|
| `src` | required | A data URL (`data:image/png;base64,…`) or an image URL. |
| `frameWidth` | — | If set, the picture is a row of frames this wide; frame N of the effect shows cell N (cycling). |
| `scale` | 1 | Whole-number pixel scale. |

An image keeps its own colours (`palette`, `color` and `cutoff` do not apply); `opacity` still dithers it.

## Tips for writing recipes

- Start with one main layer and its timing: make the main thing grow fast (`"out"` easing) up to `impactFrame`, then
  thin out or fade over the remaining frames. Typical lengths: 8–14 frames for hits and slashes, 16–24 for
  explosions, 24 with `"loop": true` for auras.
- End one-shot effects with an empty or nearly empty frame (fade `opacity` to 0 by the last frame).
- Use 3–5 palette colours, dark to bright. With `"blend": "add"` dark colours almost disappear in the game, so the
  bright end matters most. Use `"blend": "normal"` for smoke, dust and ink.
- Keep particles few (6–20) at 32–64 px: pixel art reads better with fewer, clearer shapes.
- Unknown fields are ignored; unknown layer types are skipped with a warning.
