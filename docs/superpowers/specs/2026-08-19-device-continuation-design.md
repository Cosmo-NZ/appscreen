# Device Continuation Across Adjacent Slides

**Date:** 2026-08-19
**Status:** Approved design, not yet implemented

## Problem

App Store screenshot sets often use a device that bleeds off one slide and appears
to continue onto the next, so a pair of slides reads as one continuous scene.

`appscreen` cannot express this. A slide renders exactly one device
(`drawScreenshotToContext`, [app.js:7208](../../../app.js)), positioned in
percentages of that slide's own canvas. Two adjacent slides are unrelated
compositions that happen to sit next to each other in the DOM.

A general panorama feature — one wide composition sliced across N slides — was
considered and rejected as too large. This spec covers a narrower mechanism that
produces the same visual result for the common two-slide case.

## Goal

A slide can render its neighbour's device, translated by exactly one canvas
width, so the two halves join at the shared edge.

## Non-goals

- Continuous backgrounds across slides. Gradients and image backgrounds still
  restart per slide. Acceptable: the target designs use solid backgrounds.
- Spans longer than two slides. A device may continue onto one adjacent slide,
  not across three or more.
- Multiple independent devices per slide. The only extra device a slide can
  render is a neighbour's continuation.
- Any affordance marking the bleeding device as owned by the neighbour. Editing
  it means switching slides. The preview carousel already shows both slides, so
  the feedback loop is short. Revisit after the feature sees use.

## Data model

Two booleans per screenshot, both defaulting to `false`:

```js
continueFromPrev: false,  // render slide N-1's device, entering from the left
continueFromNext: false   // render slide N+1's device, entering from the right
```

They are top-level screenshot properties, siblings of `background`, `screenshot`,
`text`, `elements` and `popouts`. They must be added to the persisted field list
in `saveState` ([app.js:1489](../../../app.js)).

No `formatVersion` bump. An absent field reads as `false`, so existing projects
load unchanged.

### The continuation is derived, never stored

At render time a slide reads its neighbour's `screenshot` settings and image
directly and draws that device translated by one canvas width. Nothing is copied
into the current slide.

Consequences, all of which are wanted:

- No drift between a continuation and its source, and no sync logic.
- The reference is **positional**, not by id. Reordering or deleting slides
  re-derives against whatever is adjacent afterwards, with no bookkeeping. A flag
  left pointing at a new neighbour renders that new neighbour.
- No migration surface beyond the two booleans.

### What is drawn

Only the neighbour's device: its image, corner radius, shadow, frame, rotation,
perspective and — in 3D mode — model, rotation and frame colour.

Explicitly **not** the neighbour's popouts, elements, text or background. This is
a device bleeding across a seam, not a mirror of the whole slide.

### Z-order

Continuation devices draw in the same band as the slide's own device: after
`behind-screenshot` elements, before `above-screenshot` elements. The slide's own
device paints last and wins any overlap.

### Why device position range is not a problem

The continuation never round-trips through the `settings.x` percentage. It
computes the neighbour's pixel geometry from the neighbour's own settings against
the shared `dims`, then translates by `±dims.width`.

This matters because the existing percent-to-pixel mapping is scale-coupled:

```js
moveX = max(dims.width - imgWidth, dims.width * 0.15)
x_px  = (dims.width - imgWidth) / 2 + (settings.x / 100 - 0.5) * moveX
```

Expressing a full-slide offset through that mapping would need `settings.x`
values well beyond the `-80..180` slider range at normal scales. Deriving in
pixels sidesteps it. **No slider range changes are required.**

## Work breakdown

Two commits, in order.

### Commit 1 — collapse the forked draw path

Prerequisite refactor, no behaviour change.

The renderer has two parallel families. `updateCanvas`
([app.js:6823](../../../app.js)) uses `drawBackground` / `drawScreenshot` /
`drawText` / `drawNoise` / `drawDeviceFrame`, which take an implicit `ctx` and an
implicit current screenshot. `renderScreenshotToCanvas`
([app.js:7068](../../../app.js)) uses the `*ToContext` family, which takes both
explicitly. Adding continuation to both means writing it twice.

Change `updateCanvas` to delegate:

```js
renderScreenshotToCanvas(state.selectedIndex, canvas, ctx, dims, scale)
```

Then delete the singleton family:

| Function | Line |
|---|---|
| `drawBackground` | [app.js:7716](../../../app.js) |
| `drawScreenshot` | [app.js:7786](../../../app.js) |
| `drawDeviceFrame` | [app.js:7884](../../../app.js) |
| `drawText` | [app.js:7900](../../../app.js) |
| `drawNoise` | [app.js:8034](../../../app.js) |

`renderThreeJSToCanvas` ([three-renderer.js:737](../../../three-renderer.js)) has
`updateCanvas` as its only caller and is deleted with them.

`roundRect` ([app.js:8050](../../../app.js)) **survives**. It is currently called
only from the deleted functions, but the drift reconciliation below moves the
surviving `drawScreenshotToContext` and `drawDeviceFrameToContext` onto it.

Three regression risks to handle explicitly:

1. **Empty state.** `updateCanvas` currently paints the default background with
   zero screenshots, because `getBackground()` falls back to
   `state.defaults.background`. `renderScreenshotToCanvas` returns early when
   there is no screenshot at the index. The delegation needs an explicit branch
   that preserves today's empty-state preview.
2. **3D entry point.** The main canvas currently renders through
   `renderThreeJSToCanvas` (live `phonePivot`); previews render through
   `renderThreeJSForScreenshot(index)` (cached models, per-index texture and
   frame colour). Delegation routes everything through the latter. Verify the
   selected-index case (`useCurrentModel` branch) is unchanged.
3. **Drift between the twins.** The two families are *not* pixel-equivalent, so
   they must be reconciled **before** the delegation, not after:

   | Drift | Singleton (main canvas, export) | `*ToContext` (side previews) |
   |---|---|---|
   | Noise amplitude | `intensity/100 * 50` | `intensity/100 * 255` |
   | Shadow alpha | `hexToRgba(color, o/100)` | `color + round(o/100*255).toString(16)` |
   | Corner geometry | `roundRect()` helper (quadratic curves) | native `ctx.roundRect` (arcs) |

   Reconcile **toward the singleton**: it is what users currently see on the main
   canvas and in exports, and it is what the baseline captures.

   The noise row is a live bug, not just drift — side previews render noise 5.1×
   stronger than the export. Reconciling fixes it. Popouts and elements have no
   singleton twin and are left alone.

### Commit 2 — continuation

#### Shared

A new `drawContinuationDevices(context, dims, index)`, called from
`renderScreenshotToCanvas` between the `behind-screenshot` elements and the
slide's own device. It resolves each enabled neighbour, skips it when the
neighbour is missing or has no image for the current language, and dispatches to
the 2D or 3D path according to the **neighbour's** `use3D` setting.

Image lookup goes through `getScreenshotImage(neighbour)` so the continuation
follows the current language.

#### 2D

Add an `offsetX` parameter to `drawScreenshotToContext`, defaulting to `0`, applied
as a translation before the existing geometry.

Signs, derived by placing the current slide at the origin. Slide N-1 occupies
`[-W, 0]` in the current slide's coordinates and slide N+1 occupies `[W, 2W]`, so
a neighbour's device at local pixel `x` lands at `x ∓ W`:

| Flag | Source slide | `offsetX` | Result |
|---|---|---|---|
| `continueFromPrev` | N-1 | `-dims.width` | Previous slide's device, which bleeds off *its* right edge, enters from the left. |
| `continueFromNext` | N+1 | `+dims.width` | Next slide's device, which bleeds off *its* left edge, enters from the right. |

#### 3D

Add a tile index `k` to `renderThreeJSForScreenshot`
([three-renderer.js:813](../../../three-renderer.js)), where `k = -1` is the tile
one canvas-width left of the source, `k = 0` is the source itself, and `k = +1` is
one canvas-width right.

Translating the phone sideways would be wrong — a shifted object is viewed at a
different angle, so the halves would not match at the seam. Offset the camera's
frustum instead:

```js
camera.aspect = 3 * W / H;
camera.setViewOffset(3 * W, H, (1 + k) * W, 0, W, H);
// render
camera.clearViewOffset();
// restore aspect
```

A triple-wide frustum centred on the source tile spans `[-W, 2W]` in source-canvas
coordinates, so tile index `1 + k` selects the wanted region for
`k ∈ {-1, 0, +1}`. `setViewOffset` exists in Three.js r128.

`k` is relative to the **source** slide, so it is the mirror of the 2D `offsetX`:

| Flag | Source slide | `k` |
|---|---|---|
| `continueFromPrev` | N-1 | `+1` (tile one width right of the source) |
| `continueFromNext` | N+1 | `-1` (tile one width left of the source) |

`k = 0` must reproduce the current render exactly. See Verification.

#### UI

A new control group in the Device tab, following the existing `.toggle-row`
pattern used by Noise and Shadow, without collapsible bodies since neither toggle
has sub-options:

- *Continue from previous slide* — disabled when `selectedIndex === 0`
- *Continue from next slide* — disabled on the last slide

Disabled styling follows the Add Popout precedent (`disabled` plus
`opacity: 0.4`). `syncUIWithState` ([app.js:2150](../../../app.js)) sets both the
active and disabled states, alongside the existing 3D block.

The toggles live in the Device tab rather than the left sidebar: a continuation is
arguably a property of the relationship between two slides, but everything the
user adjusts to make it look right — scale, position, rotation — is in the Device
tab, and splitting those across sidebars would be worse.

#### Preview gap

The carousel spaces slides with a hardcoded 10px gap
([app.js:6881](../../../app.js)), and `slideToScreenshot`
([app.js:6969](../../../app.js)) derives its animation distance from the same
constant. Left alone, a continuation renders exactly in the export but shows a
10px seam in the editor — exactly where the user is trying to judge alignment.

The gap becomes a computed value: `0` between a pair of slides joined by a
continuation, `10` otherwise. `slideToScreenshot` reads the same computed value
so the slide animation stays in step.

#### Interaction with existing per-slide operations

- `transferStyle` ([app.js:6596](../../../app.js)) and `applyStyleToAll`
  ([app.js:6656](../../../app.js)) must **not** copy the flags. They copy
  background, device settings, text and elements; a continuation is a positional
  relationship, not style.
- `duplicateScreenshot` ([app.js:2038](../../../app.js)) **must** carry the flags
  into the clone — they are per-slide state. Add them to the clone literal.

## Edge cases

| Case | Behaviour |
|---|---|
| First or last slide | Corresponding toggle disabled; render path also guards the index defensively. |
| Neighbour is a blank screen | `getScreenshotImage` returns null, nothing drawn. No special case. |
| Neighbour has no image for the current language | Same as above; falls back through `getScreenshotImage`'s existing chain. |
| Current slide 2D, neighbour 3D (or the reverse) | Continuation renders in the neighbour's mode. It is the neighbour's device. |
| Slide reordered or deleted | Flags are positional; the continuation re-derives against the new neighbour. |
| Output size changed | `dims` is read at render time; everything re-derives. |
| Neighbour's device is centred, not bleeding | Continuation renders entirely off-canvas and nothing appears. No warning — deliberate. |
| Export | `exportAllForLanguage` sets `selectedIndex` and calls `updateCanvas` per slide, so continuations flow through with no export-specific work. |

## Verification

This repository has no test framework — no test script in `package.json`, no test
directory. Verification is scripted checks driven through the browser, plus manual
review.

**Commit 1 — the safety argument for deleting ~400 lines.** Capture
`canvas.toDataURL()` for a representative matrix of slides before the change, then
assert byte-identical output after:

- 2D and 3D devices
- gradient, solid and image backgrounds
- noise on and off
- text positioned top and bottom, headline and subheadline
- elements at all three layers
- popouts present
- blank screen
- empty project (no screenshots)

**Commit 2:**

- *3D tile math.* `renderThreeJSForScreenshot` with `k = 0` must be pixel-identical
  to the pre-change render. This validates `setViewOffset` independently of the
  feature.
- *Seam correctness.* Render slides N and N+1 to offscreen canvases, stitch them
  side by side, and compare the pixel columns either side of the join. A correct
  continuation is continuous there; an off-by-one in the translation shows
  immediately.
- *Flag propagation.* Duplicate a slide with a continuation and confirm the flags
  carry; transfer style onto a slide and confirm they do not.

## Decisions taken

| Decision | Chosen | Rejected |
|---|---|---|
| Feature shape | Narrow continuation referencing a neighbour | General N-devices-per-slide; general plus a continuation helper |
| Direction | Either neighbour | Previous only; next only |
| 3D support | In scope for v1 | 2D-only first cut |
| Refactor sequencing | Draw-path dedup as its own commit first | Folded into the feature commit |
| Preview gap | Collapse to 0 for linked pairs | Leave the 10px gap |
| Misconfiguration guardrail | None; render and let it be empty | Inline hint when nothing will be visible |
