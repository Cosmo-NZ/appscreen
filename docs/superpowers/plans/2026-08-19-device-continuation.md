# Device Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a slide render its neighbour's device translated by exactly one canvas width, so a device bleeding off one slide appears to continue onto the adjacent slide.

**Architecture:** Two booleans per screenshot (`continueFromPrev`, `continueFromNext`) drive a purely derived render — the neighbour's device geometry is computed from the neighbour's own settings and translated, with nothing copied into the current slide. A prerequisite refactor collapses the renderer's two parallel draw families into one so the feature is written once.

**Tech Stack:** Vanilla JS (classic scripts, no modules, no build step), HTML5 Canvas 2D, Three.js r128, IndexedDB. No test framework.

## Global Constraints

- No build process. All scripts are classic (non-module) `<script>` tags in `index.html`; every top-level `function` is a global.
- Serve over HTTP for IndexedDB: `python3 -m http.server 8000`. Opening `index.html` from the filesystem breaks persistence.
- Any new local `.js` file loaded by `index.html` **must** be added to the `Dockerfile` COPY list, which enumerates files explicitly.
- Design spec: `docs/superpowers/specs/2026-08-19-device-continuation-design.md`. It is authoritative; this plan implements it.
- Follow existing code style: 4-space indent, no semicolon omission, `function` declarations at top level, `getElementById` for DOM access.
- Per `CLAUDE.md`, show the proposed commit message and wait for approval before every commit.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `tests/render-baseline.js` | Create | Deterministic render-baseline harness. Not loaded by `index.html`; imported on demand from the console. |
| `app.js` | Modify | State fields, persistence, `updateCanvas` delegation, dead-code removal, `drawContinuationDevices`, `offsetX` on `drawScreenshotToContext`, UI wiring, computed preview gap. |
| `three-renderer.js` | Modify | `tileIndex` parameter on `renderThreeJSForScreenshot`; delete `renderThreeJSToCanvas`. |
| `index.html` | Modify | Two toggle rows in the Device tab. |
| `styles.css` | Modify | `.toggle.disabled` state. |

`tests/render-baseline.js` is deliberately not wired into `index.html` — it must not ship to users, and it is never loaded unless a developer imports it. It therefore does **not** go in the Dockerfile.

---

## Task 1: Render-baseline harness

The entire safety argument for deleting ~400 lines in Task 3 is "the rendered output is byte-identical". This task builds the thing that proves it.

**Files:**
- Create: `tests/render-baseline.js`

**Interfaces:**
- Consumes: nothing.
- Produces: global `renderBaseline` with:
  - `capture(): Promise<{[fixtureName: string]: string}>` — renders every fixture, stores the hash map in `localStorage` under `renderBaselineV1`, returns it.
  - `compare(): Promise<{pass: boolean, results: Array<{name: string, ok: boolean}>}>` — re-renders and diffs against the stored map.
  - `FIXTURE_NAMES: string[]`

- [ ] **Step 1: Create the harness file**

Create `tests/render-baseline.js`:

```js
// Deterministic render-baseline harness for the canvas pipeline.
//
// Usage, in DevTools console at http://localhost:8000 :
//   await import('/tests/render-baseline.js');
//   await renderBaseline.capture();   // before your change
//   ...edit code, reload the page...
//   await renderBaseline.compare();   // after your change
//
// Not loaded by index.html. Never ships.

(function () {
    const STORAGE_KEY = 'renderBaselineV1';

    // ---- determinism helpers -------------------------------------------------

    // Noise uses Math.random() per pixel, so it must be made deterministic or
    // every capture differs. Mulberry32, seeded identically on each run.
    function seededRandom(seed) {
        let a = seed;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    async function sha256(text) {
        const bytes = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)]
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    function nextFrame() {
        return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    function waitFor(predicate, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            (function poll() {
                if (predicate()) return resolve();
                if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
                setTimeout(poll, 100);
            })();
        });
    }

    // Solid-colour test image, generated so fixtures never depend on user files.
    function makeImage(w, h, color) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cx = c.getContext('2d');
        cx.fillStyle = color;
        cx.fillRect(0, 0, w, h);
        cx.fillStyle = '#ffffff';
        cx.fillRect(w * 0.2, h * 0.3, w * 0.6, h * 0.1);
        const src = c.toDataURL('image/png');
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve({ image: img, src: src });
            img.src = src;
        });
    }

    // ---- fixtures ------------------------------------------------------------

    function baseScreenshot(shot) {
        return {
            image: shot ? shot.image : null,
            name: 'fixture.png',
            deviceType: 'iPhone',
            localizedImages: shot ? { en: { image: shot.image, src: shot.src, name: 'fixture.png' } } : {},
            background: JSON.parse(JSON.stringify(state.defaults.background)),
            screenshot: JSON.parse(JSON.stringify(state.defaults.screenshot)),
            text: normalizeTextSettings(state.defaults.text),
            elements: [],
            popouts: [],
            overrides: {}
        };
    }

    function textElement(layer, x, y) {
        return {
            id: 'fixture-' + layer,
            type: 'text', x: x, y: y, width: 40, rotation: 0, opacity: 100,
            layer: layer, image: null, src: null, name: 'Text',
            text: layer, texts: { en: layer },
            font: "-apple-system, BlinkMacSystemFont, 'SF Pro Display'",
            fontSize: 60, fontWeight: '600', fontColor: '#ffffff',
            italic: false, frame: 'none', frameColor: '#ffffff', frameScale: 100
        };
    }

    // Each fixture returns the screenshots array to render, and the index to select.
    async function buildFixtures() {
        const shot = await makeImage(300, 650, '#3366ff');
        const bgImage = await makeImage(800, 800, '#aa3355');

        function one(mutate) {
            const s = baseScreenshot(shot);
            mutate(s);
            return { screenshots: [s], index: 0 };
        }

        return {
            'empty-project': { screenshots: [], index: 0 },

            'blank-screen': (() => {
                const s = baseScreenshot(null);
                s.name = 'Blank Screen';
                return { screenshots: [s], index: 0 };
            })(),

            '2d-gradient-text-top': one(s => {
                s.text.headlines = { en: 'Gradient headline that wraps onto two lines' };
                s.text.position = 'top';
            }),

            '2d-solid-text-bottom': one(s => {
                s.background.type = 'solid';
                s.text.headlines = { en: 'Bottom headline' };
                s.text.subheadlines = { en: 'And a supporting subheadline' };
                s.text.subheadlineEnabled = true;
                s.text.position = 'bottom';
            }),

            '2d-image-bg-cover': one(s => {
                s.background.type = 'image';
                s.background.image = bgImage.image;
                s.background.imageFit = 'cover';
                s.background.overlayOpacity = 40;
            }),

            '2d-noise': one(s => {
                s.background.noise = true;
                s.background.noiseIntensity = 25;
            }),

            '2d-shadow-frame': one(s => {
                s.screenshot.shadow.enabled = true;
                s.screenshot.frame.enabled = true;
                s.screenshot.rotation = 8;
            }),

            '2d-elements-all-layers': one(s => {
                s.elements = [
                    textElement('behind-screenshot', 30, 30),
                    textElement('above-screenshot', 50, 50),
                    textElement('above-text', 70, 70)
                ];
            }),

            '2d-popout': one(s => {
                s.popouts = [{
                    id: 'fixture-popout',
                    cropX: 20, cropY: 20, cropWidth: 40, cropHeight: 30,
                    x: 70, y: 30, width: 35, rotation: 6, opacity: 100, cornerRadius: 12,
                    shadow: { enabled: true, color: '#000000', blur: 30, opacity: 40, x: 0, y: 15 },
                    border: { enabled: true, color: '#ffffff', width: 3, opacity: 100 }
                }];
            }),

            '3d-iphone': one(s => {
                s.screenshot.use3D = true;
                s.screenshot.device3D = 'iphone';
                s.screenshot.rotation3D = { x: 10, y: -15, z: 0 };
            })
        };
    }

    // ---- capture -------------------------------------------------------------

    async function renderAll() {
        const realRandom = Math.random;
        const realSaveState = window.saveState;
        const snapshot = {
            screenshots: state.screenshots,
            selectedIndex: state.selectedIndex,
            outputDevice: state.outputDevice,
            currentLanguage: state.currentLanguage,
            projectLanguages: state.projectLanguages.slice()
        };

        // Never write fixtures into the user's IndexedDB project.
        window.saveState = function () {};

        const hashes = {};
        try {
            state.outputDevice = 'iphone-6.9';
            state.currentLanguage = 'en';
            state.projectLanguages = ['en'];

            const fixtures = await buildFixtures();

            // 3D fixtures need the model in memory before they render anything.
            if (typeof showThreeJS === 'function') showThreeJS(true);
            await waitFor(() => typeof phoneModelLoaded !== 'undefined' && phoneModelLoaded);

            for (const name of Object.keys(fixtures)) {
                const fixture = fixtures[name];
                state.screenshots = fixture.screenshots;
                state.selectedIndex = fixture.index;

                Math.random = seededRandom(0x9E3779B9);
                updateCanvas();
                await nextFrame();
                Math.random = realRandom;

                hashes[name] = await sha256(document.getElementById('preview-canvas').toDataURL('image/png'));
            }
        } finally {
            Math.random = realRandom;
            window.saveState = realSaveState;
            state.screenshots = snapshot.screenshots;
            state.selectedIndex = snapshot.selectedIndex;
            state.outputDevice = snapshot.outputDevice;
            state.currentLanguage = snapshot.currentLanguage;
            state.projectLanguages = snapshot.projectLanguages;
            updateScreenshotList();
            syncUIWithState();
            updateCanvas();
        }
        return hashes;
    }

    async function capture() {
        const hashes = await renderAll();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(hashes));
        console.log('Baseline captured:', Object.keys(hashes).length, 'fixtures');
        console.table(hashes);
        return hashes;
    }

    async function compare() {
        const storedRaw = localStorage.getItem(STORAGE_KEY);
        if (!storedRaw) throw new Error('No baseline stored. Run renderBaseline.capture() first.');
        const stored = JSON.parse(storedRaw);
        const current = await renderAll();

        const results = Object.keys(stored).map(name => ({
            name: name,
            ok: stored[name] === current[name]
        }));
        const pass = results.every(r => r.ok);
        console.table(results);
        console.log(pass ? 'PASS - all fixtures byte-identical' : 'FAIL - see table above');
        return { pass: pass, results: results };
    }

    window.renderBaseline = {
        capture: capture,
        compare: compare,
        get FIXTURE_NAMES() { return Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); }
    };
})();
```

- [ ] **Step 2: Start the server if it is not already running**

Run:

```bash
python3 -m http.server 8000
```

- [ ] **Step 3: Capture the baseline and confirm it is stable**

In DevTools console at `http://localhost:8000`:

```js
await import('/tests/render-baseline.js');
const a = await renderBaseline.capture();
const b = await renderBaseline.capture();
JSON.stringify(a) === JSON.stringify(b);
```

Expected: `true`, and a table of 11 fixtures.

If this prints `false`, the harness is not deterministic yet and **you must stop and fix it before proceeding** — a flaky baseline cannot protect Task 3. The likely culprit is `3d-iphone`: WebGL output can vary if the model or its texture is not fully settled. If two back-to-back captures differ only on `3d-iphone`, delete that fixture from `buildFixtures` and verify 3D by eye in Task 3 instead. Do not proceed with a baseline that does not reproduce.

- [ ] **Step 4: Commit**

```bash
git add tests/render-baseline.js
git commit -m "test: add deterministic render-baseline harness"
```

---

## Task 2: Reconcile the two draw families, then delegate

The two families are **not** pixel-equivalent today. Delegating without first
reconciling them would silently change what every user exports. Three drifts,
verified by reading both implementations:

| Drift | Singleton (main canvas, export) | `*ToContext` (side previews) | Effect |
|---|---|---|---|
| Noise amplitude | `intensity/100 * 50` | `intensity/100 * 255` | **5.1× stronger noise.** A live bug: side previews already misrepresent the export. |
| Shadow alpha | `hexToRgba(color, o/100)` → exact alpha | `color + round(o/100*255).toString(16)` → quantised | Tiny alpha difference on every shadowed device. |
| Corner geometry | `roundRect()` helper, quadratic curves | native `ctx.roundRect`, true arcs | Few-pixel difference on every rounded device. |

Reconcile **toward the singleton**, because that is what users currently see on the
main canvas and in exports, and it is what the Task 1 baseline captured. This also
fixes the noise bug and makes side previews finally agree with the export.

Popouts and elements are untouched: `drawPopouts` and `drawElements` already
delegate to their `*ToContext` versions, so they have no twin and no drift.

**Files:**
- Modify: `app.js` — `drawNoiseToContext` (7193), `drawScreenshotToContext` (7208), `drawDeviceFrameToContext` (7294), `updateCanvas` (6823-6879)

**Interfaces:**
- Consumes: `renderScreenshotToCanvas(index, targetCanvas, targetCtx, dims, previewScale)`, `drawBackgroundToContext(context, dims, bg)`, `drawNoiseToContext(context, dims, intensity)`, `drawTextToContext(context, dims, txt)`, `roundRect(ctx, x, y, w, h, r)`, `hexToRgba(hex, alpha)` — all already exist.
- Produces: `updateCanvas()` with unchanged signature and unchanged rendered output.

- [ ] **Step 1: Confirm the baseline is loaded**

In the console:

```js
await import('/tests/render-baseline.js');
localStorage.getItem('renderBaselineV1') !== null;
```

Expected: `true`. If `false`, redo Task 1 Step 3.

- [ ] **Step 2: Fix the noise amplitude**

In `drawNoiseToContext`, replace:

```js
    const noiseAmount = intensity / 100;

    for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * 255 * noiseAmount;
```

with:

```js
    // Matches the amplitude the main canvas and export have always used
    const noiseAmount = intensity / 100 * 50;

    for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * noiseAmount;
```

- [ ] **Step 3: Fix the shadow alpha**

In `drawScreenshotToContext`, replace:

```js
        const shadowOpacity = settings.shadow.opacity / 100;
        const shadowColor = settings.shadow.color + Math.round(shadowOpacity * 255).toString(16).padStart(2, '0');
        context.shadowColor = shadowColor;
```

with:

```js
        const shadowColor = hexToRgba(settings.shadow.color, settings.shadow.opacity / 100);
        context.shadowColor = shadowColor;
```

`shadowOpacity` is not used again in that block; removing it is correct.

- [ ] **Step 4: Fix the corner geometry**

In `drawScreenshotToContext` there are two `context.roundRect(...)` calls — one
filling the shadow shape, one clipping the image. Replace both:

```js
        context.roundRect(x, y, imgWidth, imgHeight, radius);
```

with:

```js
        roundRect(context, x, y, imgWidth, imgHeight, radius);
```

In `drawDeviceFrameToContext`, replace:

```js
    context.roundRect(x - frameWidth / 2, y - frameWidth / 2, width + frameWidth, height + frameWidth, radius);
```

with:

```js
    roundRect(context, x - frameWidth / 2, y - frameWidth / 2, width + frameWidth, height + frameWidth, radius);
```

Leave the `context.roundRect` calls in `drawPopoutsToContext` alone — popouts have
no singleton twin, so changing them would alter output for no reason.

- [ ] **Step 5: Verify the main canvas is untouched**

Reload, then:

```js
await import('/tests/render-baseline.js');
(await renderBaseline.compare()).pass;
```

Expected: `true`. Nothing in this step touched the singleton path the main canvas
still uses, so any failure means a stray edit.

- [ ] **Step 6: Verify the side previews now agree with the main canvas**

Load a project with at least two screenshots. Turn noise on at a high intensity and
enable the device shadow. The side previews must now show the *same* noise
intensity and shadow as the centre canvas — before this change the side previews
were visibly grainier.

- [ ] **Step 7: Commit the reconciliation**

```bash
git add app.js
git commit -m "fix: align side-preview rendering with the main canvas

Noise was 5.1x stronger in the side previews than in the main canvas and
the export, and shadow alpha and corner geometry differed slightly. The
preview now matches what you get when you export."
```

- [ ] **Step 8: Replace the body of `updateCanvas`**

Replace the whole function with:

```js
function updateCanvas() {
    saveState(); // Persist state on every update
    const dims = getCanvasDimensions();
    canvas.width = dims.width;
    canvas.height = dims.height;

    // Scale for preview
    const maxPreviewWidth = 400;
    const maxPreviewHeight = 700;
    const scale = Math.min(maxPreviewWidth / dims.width, maxPreviewHeight / dims.height);
    canvas.style.width = (dims.width * scale) + 'px';
    canvas.style.height = (dims.height * scale) + 'px';

    if (state.screenshots.length === 0) {
        // Empty state: nothing to render, but the preview still shows the
        // default background (and default text, if a project ever carries any)
        const bg = getBackground();
        drawBackgroundToContext(ctx, dims, bg);
        if (bg.noise) {
            drawNoiseToContext(ctx, dims, bg.noiseIntensity);
        }
        drawTextToContext(ctx, dims, getText());
    } else {
        renderScreenshotToCanvas(state.selectedIndex, canvas, ctx, dims, scale);
    }

    // Update side previews
    updateSidePreviews();
}
```

- [ ] **Step 9: Verify the render is unchanged**

Reload the page, then in the console:

```js
await import('/tests/render-baseline.js');
(await renderBaseline.compare()).pass;
```

Expected: `true`. This is the payoff from Steps 2-4: the delegated path now produces
byte-identical output because the two families were made equivalent first.

One deliberate behaviour change will **not** show up here but must be understood: when a screenshot has `use3D` set and the model has not finished loading, the old `updateCanvas` drew nothing, whereas `renderScreenshotToCanvas` falls back to drawing the flat 2D screenshot. This removes a blank flash during model load and is an improvement. The harness waits for `phoneModelLoaded`, so it does not exercise that window.

If any fixture fails, do not proceed — the most likely cause is an incomplete
reconciliation in Steps 2-4. Diff the failing fixture's draw path against its
singleton twin before continuing.

- [ ] **Step 10: Verify the app by hand**

Load a project with screenshots, switch slides, toggle 2D/3D, and confirm the empty-state preview still shows the default gradient when the project has no screenshots.

- [ ] **Step 11: Commit**

```bash
git add app.js
git commit -m "refactor: render the main canvas through renderScreenshotToCanvas"
```

---

## Task 3: Delete the superseded draw family

**Files:**
- Modify: `app.js` — delete `drawBackground` (7716), `drawScreenshot` (7786), `drawDeviceFrame` (7884), `drawText` (7900), `drawNoise` (8034)
- Modify: `three-renderer.js` — delete `renderThreeJSToCanvas` (737)

Line numbers are from before Task 2; re-locate by name.

**`roundRect` (8050) is NOT deleted.** Task 2 Step 4 made
`drawScreenshotToContext` and `drawDeviceFrameToContext` depend on it to preserve
corner geometry. Deleting it would break every device render.

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. Pure deletion.

- [ ] **Step 1: Confirm every deletion target is unreferenced**

```bash
for fn in drawBackground drawScreenshot drawDeviceFrame drawText drawNoise renderThreeJSToCanvas; do
  echo "== $fn"
  grep -rn "\b$fn\b" --include='*.js' --include='*.html' . | grep -v '^\./\.git' | grep -v "function $fn"
done
```

Expected: only matches for the `*ToContext` variants (`drawBackgroundToContext` etc. — the `\b` boundary still shows them; ignore those) and no plain-name call sites.

If a plain-name call site remains, stop: something still depends on the old family.

- [ ] **Step 2: Confirm `roundRect` is still needed**

```bash
grep -n "roundRect(context\|roundRect(ctx" app.js
```

Expected: three call sites — two in `drawScreenshotToContext`, one in
`drawDeviceFrameToContext`. If this returns nothing, Task 2 Step 4 was not applied
and you must go back and apply it.

- [ ] **Step 3: Delete the five functions in `app.js`**

Delete each function declaration in full, from its `function` line to its closing brace. Delete the preceding comment lines that belong to it. Do not touch any `*ToContext` function, and do not touch `roundRect`.

- [ ] **Step 4: Delete `renderThreeJSToCanvas` in `three-renderer.js`**

Delete the whole function, including its `// Render 3D phone only (with transparent background) to be composited` comment.

- [ ] **Step 5: Verify syntax**

```bash
node --check app.js && node --check three-renderer.js && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 6: Verify the render is still unchanged**

Reload, then:

```js
await import('/tests/render-baseline.js');
(await renderBaseline.compare()).pass;
```

Expected: `true`.

- [ ] **Step 7: Check the console for reference errors**

Exercise the app: switch slides, change background type, toggle noise, toggle 2D/3D, export the current screenshot. The console must stay clean of `ReferenceError`.

- [ ] **Step 8: Commit**

```bash
git add app.js three-renderer.js
git commit -m "refactor: delete the superseded single-context draw functions"
```

---

## Task 4: Continuation state and persistence

**Files:**
- Modify: `app.js` — `saveState` (1489), `loadState` (1596), `createNewScreenshot` (6199), `duplicateScreenshot` (2038)

**Interfaces:**
- Consumes: nothing new.
- Produces: every screenshot object carries `continueFromPrev: boolean` and `continueFromNext: boolean`, both defaulting to `false`, round-tripping through IndexedDB.

- [ ] **Step 1: Add the fields to new screenshots**

In `createNewScreenshot`, in the object passed to `state.screenshots.push`, after `popouts: []`:

```js
        popouts: [],
        continueFromPrev: false,
        continueFromNext: false,
```

- [ ] **Step 2: Persist the fields**

In `saveState`, in the object returned by the `state.screenshots.map` callback, after `popouts: s.popouts || [],`:

```js
            popouts: s.popouts || [],
            continueFromPrev: s.continueFromPrev || false,
            continueFromNext: s.continueFromNext || false,
```

- [ ] **Step 3: Restore the fields on load**

`loadState` builds `state.screenshots[index]` in three separate branches — blank screen, localized images, and legacy single image. In **each** of the three, after `popouts: s.popouts || [],`, add:

```js
                                    popouts: s.popouts || [],
                                    continueFromPrev: s.continueFromPrev || false,
                                    continueFromNext: s.continueFromNext || false,
```

Indentation differs per branch; match the surrounding lines.

- [ ] **Step 4: Carry the fields through duplication**

In `duplicateScreenshot`, add both fields to the object literal passed to `JSON.parse(JSON.stringify(...))`, after `overrides: original.overrides`:

```js
        overrides: original.overrides,
        continueFromPrev: original.continueFromPrev || false,
        continueFromNext: original.continueFromNext || false
    }));
```

- [ ] **Step 5: Verify round-trip, duplication, and style-transfer isolation**

Reload the page, then in the console:

```js
(async () => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 650; c.getContext('2d').fillRect(0, 0, 300, 650);
    const src = c.toDataURL('image/png');
    const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });

    const before = state.screenshots;
    state.screenshots = [];
    createNewScreenshot(img, src, 'a.png', 'en', 'iPhone');
    createNewScreenshot(img, src, 'b.png', 'en', 'iPhone');
    state.selectedIndex = 0;

    const out = {};
    out.defaultsFalse = state.screenshots[0].continueFromPrev === false
                     && state.screenshots[0].continueFromNext === false;

    state.screenshots[0].continueFromNext = true;
    duplicateScreenshot(0);
    out.duplicateCarriesFlag = state.screenshots[1].continueFromNext === true;

    // style transfer must NOT move the flags
    state.screenshots[2].continueFromNext = false;
    transferStyle(0, 2);
    out.transferLeavesFlagAlone = state.screenshots[2].continueFromNext === false;

    state.screenshots = before;
    state.selectedIndex = 0;
    updateScreenshotList(); syncUIWithState(); updateCanvas();
    return out;
})()
```

Expected: all three properties `true`.

- [ ] **Step 6: Verify persistence across reload**

```js
state.screenshots[0].continueFromNext = true; saveState();
```

Reload the page, then:

```js
state.screenshots[0].continueFromNext === true
```

Expected: `true`. Then set it back to `false` and `saveState()` so you do not leave the project altered.

- [ ] **Step 7: Commit**

```bash
git add app.js
git commit -m "feat: add continueFromPrev/continueFromNext screenshot state"
```

---

## Task 5: 2D continuation rendering

**Files:**
- Modify: `app.js` — `drawScreenshotToContext` (7208), `renderScreenshotToCanvas` (7068); add `drawContinuationDevices`

**Interfaces:**
- Consumes: `continueFromPrev` / `continueFromNext` from Task 4; `getScreenshotImage(screenshot)`.
- Produces:
  - `drawScreenshotToContext(context, dims, img, settings, offsetX = 0)` — new trailing parameter, translates the whole device by `offsetX` canvas pixels.
  - `drawContinuationDevices(context, dims, index)` — draws every enabled neighbour device for slide `index`.

- [ ] **Step 1: Add `offsetX` to `drawScreenshotToContext`**

Change the signature and wrap the existing body in a translate. The function currently starts:

```js
function drawScreenshotToContext(context, dims, img, settings) {
    if (!img) return;

    const scale = settings.scale / 100;
```

Change it to:

```js
function drawScreenshotToContext(context, dims, img, settings, offsetX = 0) {
    if (!img) return;

    context.save();
    if (offsetX !== 0) {
        context.translate(offsetX, 0);
    }

    const scale = settings.scale / 100;
```

The function ends with the device-frame block:

```js
    // Draw device frame if enabled
    if (settings.frame && settings.frame.enabled) {
        context.save();
        ...
        context.restore();
    }
}
```

Add the matching restore immediately before the closing brace:

```js
        context.restore();
    }

    context.restore();
}
```

The outer save/restore must wrap **both** the image block and the frame block, because the frame is drawn in its own save/restore after the image's is released.

- [ ] **Step 2: Add `drawContinuationDevices`**

Insert directly above `function drawElements(` in `app.js`:

```js
// ===== Continuation rendering =====
// A slide can render an adjacent slide's device translated by exactly one canvas
// width, so a device bleeding off one slide appears to continue onto this one.
// Everything is derived from the neighbour at render time - nothing is stored.
function drawContinuationDevices(context, dims, index) {
    const screenshot = state.screenshots[index];
    if (!screenshot) return;

    const links = [
        { enabled: screenshot.continueFromPrev, source: index - 1, offsetX: -dims.width, tile: 1 },
        { enabled: screenshot.continueFromNext, source: index + 1, offsetX: dims.width, tile: -1 }
    ];

    links.forEach(link => {
        if (!link.enabled) return;
        const source = state.screenshots[link.source];
        if (!source) return;

        const img = getScreenshotImage(source);
        if (!img) return;

        const settings = source.screenshot;
        if (settings.use3D) {
            if (typeof renderThreeJSForScreenshot === 'function' && phoneModelLoaded) {
                renderThreeJSForScreenshot(context.canvas, dims.width, dims.height, link.source, link.tile);
            }
        } else {
            drawScreenshotToContext(context, dims, img, settings, link.offsetX);
        }
    });
}
```

The `tile` values are the mirror of `offsetX` because the tile index is relative to the *source* slide: rendering slide N-1's device onto slide N means taking the tile one width to the **right** of slide N-1, hence `tile: 1`.

`renderThreeJSForScreenshot` does not accept a fifth argument until Task 6; extra arguments are ignored in JS, so the 3D branch renders untranslated until then. That is expected and is fixed in the next task.

- [ ] **Step 3: Call it from `renderScreenshotToCanvas`**

In `renderScreenshotToCanvas`, find:

```js
    // Elements behind screenshot
    drawElementsToContext(targetCtx, dims, elements, 'behind-screenshot');

    // Draw screenshot - 3D if active for this screenshot, otherwise 2D
```

Insert between them:

```js
    // Elements behind screenshot
    drawElementsToContext(targetCtx, dims, elements, 'behind-screenshot');

    // Neighbour devices bleeding across the shared edge, under this slide's own device
    drawContinuationDevices(targetCtx, dims, index);

    // Draw screenshot - 3D if active for this screenshot, otherwise 2D
```

- [ ] **Step 4: Verify the seam is continuous**

Reload, then in the console:

```js
(async () => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 650;
    const cx = c.getContext('2d');
    cx.fillStyle = '#3366ff'; cx.fillRect(0, 0, 300, 650);
    const src = c.toDataURL('image/png');
    const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });

    const saved = { shots: state.screenshots, idx: state.selectedIndex, save: window.saveState };
    window.saveState = function () {};
    state.screenshots = [];
    createNewScreenshot(img, src, 'a.png', 'en', 'iPhone');
    createNewScreenshot(img, src, 'b.png', 'en', 'iPhone');

    // Slide 0's device bleeds off its right edge; slide 1 continues it.
    state.screenshots[0].screenshot.x = 150;
    state.screenshots[0].screenshot.scale = 60;
    state.screenshots[0].background.type = 'solid';
    state.screenshots[1].background.type = 'solid';
    state.screenshots[1].continueFromPrev = true;

    const dims = getCanvasDimensions();
    function renderTo(i) {
        const t = document.createElement('canvas');
        renderScreenshotToCanvas(i, t, t.getContext('2d'), dims, 1);
        return t;
    }
    const left = renderTo(0), right = renderTo(1);

    // Compare the last column of slide 0 against the first column of slide 1.
    const a = left.getContext('2d').getImageData(dims.width - 1, 0, 1, dims.height).data;
    const b = right.getContext('2d').getImageData(0, 0, 1, dims.height).data;
    let maxDiff = 0, deviceRows = 0;
    for (let i = 0; i < a.length; i += 4) {
        maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]), Math.abs(a[i+1] - b[i+1]), Math.abs(a[i+2] - b[i+2]));
        if (a[i] !== a[0] || a[i+1] !== a[1] || a[i+2] !== a[2]) deviceRows++;
    }

    state.screenshots = saved.shots; state.selectedIndex = saved.idx; window.saveState = saved.save;
    updateScreenshotList(); syncUIWithState(); updateCanvas();
    return { maxDiff, deviceRows };
})()
```

Expected: `deviceRows` well above 0 — proving the device actually crosses the seam rather than the test comparing two empty columns — and `maxDiff` at most 2, allowing for antialiasing on the edge pixel. A `maxDiff` near 255 means the translation sign is inverted; swap `offsetX` between the two links.

- [ ] **Step 5: Confirm no regression for slides without continuation**

```js
await import('/tests/render-baseline.js');
(await renderBaseline.compare()).pass;
```

Expected: `true`. No fixture sets the flags, so every one must be untouched.

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: render 2D continuation devices from adjacent slides"
```

---

## Task 6: 3D continuation rendering

**Files:**
- Modify: `three-renderer.js` — `renderThreeJSForScreenshot` (813)

**Interfaces:**
- Consumes: `drawContinuationDevices` from Task 5, which already passes a fifth argument.
- Produces: `renderThreeJSForScreenshot(targetCanvas, width, height, screenshotIndex, tileIndex = 0)`, where `tileIndex` selects which canvas-width tile of the source scene to render: `-1` one width left, `0` the source itself, `+1` one width right.

- [ ] **Step 1: Add the parameter**

Change:

```js
function renderThreeJSForScreenshot(targetCanvas, width, height, screenshotIndex) {
```

to:

```js
function renderThreeJSForScreenshot(targetCanvas, width, height, screenshotIndex, tileIndex = 0) {
```

- [ ] **Step 2: Replace the camera setup with an off-axis frustum**

Find, near the end of the function:

```js
    // Temporarily resize renderer
    const oldSize = { width: 400, height: 700 };
    threeRenderer.setSize(dims.width, dims.height);
    threeCamera.aspect = dims.width / dims.height;
    threeCamera.updateProjectionMatrix();
```

Replace with:

```js
    // Temporarily resize renderer
    const oldSize = { width: 400, height: 700 };
    threeRenderer.setSize(dims.width, dims.height);
    if (tileIndex === 0) {
        threeCamera.clearViewOffset();
        threeCamera.aspect = dims.width / dims.height;
    } else {
        // Render one tile of a triple-wide frustum centred on the source slide,
        // which spans [-W, 2W] in source-canvas coordinates. Offsetting the
        // frustum rather than moving the phone keeps the perspective identical,
        // so the two halves match exactly at the seam.
        threeCamera.aspect = (3 * dims.width) / dims.height;
        threeCamera.setViewOffset(
            3 * dims.width, dims.height,
            (1 + tileIndex) * dims.width, 0,
            dims.width, dims.height
        );
    }
    threeCamera.updateProjectionMatrix();
```

- [ ] **Step 3: Clear the view offset when restoring**

Find, further down:

```js
    // Restore everything
    threeRenderer.setSize(oldSize.width, oldSize.height);
    threeCamera.aspect = oldSize.width / oldSize.height;
    threeCamera.updateProjectionMatrix();
```

Replace with:

```js
    // Restore everything
    threeRenderer.setSize(oldSize.width, oldSize.height);
    threeCamera.clearViewOffset();
    threeCamera.aspect = oldSize.width / oldSize.height;
    threeCamera.updateProjectionMatrix();
```

The camera is shared across every render, so a leaked view offset would corrupt every later frame.

- [ ] **Step 4: Verify the `tileIndex = 0` invariant**

Reload, then:

```js
await import('/tests/render-baseline.js');
(await renderBaseline.compare()).pass;
```

Expected: `true`. The `3d-iphone` fixture renders with `tileIndex` defaulting to `0`, so this proves the new branch is inert for normal rendering.

- [ ] **Step 5: Verify the 3D seam**

Run the Task 5 Step 4 script again with one change — after creating the two screenshots, add:

```js
    state.screenshots[0].screenshot.use3D = true;
    state.screenshots[0].screenshot.device3D = 'iphone';
    if (typeof showThreeJS === 'function') showThreeJS(true);
    await new Promise(r => { (function poll(){ phoneModelLoaded ? r() : setTimeout(poll, 100); })(); });
```

Expected: same shape of result — `deviceRows` above 0 and `maxDiff` at most 2. WebGL antialiasing is disabled, so the seam should be near-exact. If `maxDiff` is large but the device is visibly continuous, widen the tolerance to 8 and note it; if the device is visibly offset by a whole slide, the `1 + tileIndex` mapping is inverted.

- [ ] **Step 6: Commit**

```bash
git add three-renderer.js
git commit -m "feat: render 3D continuation via off-axis camera frustum"
```

---

## Task 7: Device tab toggles

**Files:**
- Modify: `index.html` — Device tab, after the Device Type control group (line 540-546)
- Modify: `styles.css` — add `.toggle.disabled`
- Modify: `app.js` — `setupEventListeners` (3594), `syncUIWithState` (2150)

**Interfaces:**
- Consumes: `continueFromPrev` / `continueFromNext` from Task 4.
- Produces: element ids `continue-prev-toggle` and `continue-next-toggle`.

- [ ] **Step 1: Add the markup**

In `index.html`, immediately after the Device Type `control-group` closes and before `<div id="rotation-3d-options"`, insert:

```html
                <div class="control-group">
                    <label class="control-label">Continuation</label>
                    <div class="toggle-row">
                        <span class="toggle-label">Continue from previous slide</span>
                        <div class="toggle" id="continue-prev-toggle"></div>
                    </div>
                    <div class="toggle-row">
                        <span class="toggle-label">Continue from next slide</span>
                        <div class="toggle" id="continue-next-toggle"></div>
                    </div>
                </div>
```

- [ ] **Step 2: Add the disabled style**

Append to `styles.css`:

```css
.toggle.disabled {
    opacity: 0.4;
    pointer-events: none;
}
```

- [ ] **Step 3: Wire the handlers**

In `setupEventListeners`, immediately before the closing brace of the function, add:

```js
    // Continuation toggles
    [
        { id: 'continue-prev-toggle', key: 'continueFromPrev' },
        { id: 'continue-next-toggle', key: 'continueFromNext' }
    ].forEach(entry => {
        const toggle = document.getElementById(entry.id);
        if (!toggle) return;
        toggle.addEventListener('click', function () {
            if (this.classList.contains('disabled')) return;
            const screenshot = getCurrentScreenshot();
            if (!screenshot) return;
            this.classList.toggle('active');
            screenshot[entry.key] = this.classList.contains('active');
            updateCanvas();
        });
    });
```

- [ ] **Step 4: Sync the toggles with state**

In `syncUIWithState`, immediately before the `// Elements` comment near the end, add:

```js
    // Continuation toggles - disabled at the ends of the slide list
    const continuePrev = document.getElementById('continue-prev-toggle');
    const continueNext = document.getElementById('continue-next-toggle');
    if (continuePrev && continueNext) {
        const current = getCurrentScreenshot();
        const hasPrev = !!current && state.selectedIndex > 0;
        const hasNext = !!current && state.selectedIndex < state.screenshots.length - 1;
        continuePrev.classList.toggle('active', !!(current && current.continueFromPrev));
        continueNext.classList.toggle('active', !!(current && current.continueFromNext));
        continuePrev.classList.toggle('disabled', !hasPrev);
        continueNext.classList.toggle('disabled', !hasNext);
    }
```

- [ ] **Step 5: Verify by hand**

Reload with a project of at least three screenshots. Confirm: on the first slide "Continue from previous" is dimmed and unclickable; on the last slide "Continue from next" is dimmed; on a middle slide both are clickable; toggling one immediately redraws the canvas; switching slides and returning preserves the toggle state.

- [ ] **Step 6: Commit**

```bash
git add index.html styles.css app.js
git commit -m "feat: add continuation toggles to the Device tab"
```

---

## Task 8: Collapse the preview gap for linked slides

**Files:**
- Modify: `app.js` — `updateSidePreviews` (6881), `slideToScreenshot` (6969); add `continuationGap`

**Interfaces:**
- Consumes: `continueFromPrev` / `continueFromNext` from Task 4.
- Produces: `continuationGap(leftIndex, rightIndex): number` — `0` when the two adjacent slides are joined by a continuation, otherwise `10`.

- [ ] **Step 1: Add the helper**

Insert directly above `function updateSidePreviews(`:

```js
// Gap in preview pixels between two adjacent slides. Linked slides sit flush so
// the seam can be judged while editing; everything else keeps the 10px gutter.
const PREVIEW_GAP = 10;

function continuationGap(leftIndex, rightIndex) {
    const left = state.screenshots[leftIndex];
    const right = state.screenshots[rightIndex];
    if (!left || !right) return PREVIEW_GAP;
    if (left.continueFromNext || right.continueFromPrev) return 0;
    return PREVIEW_GAP;
}
```

- [ ] **Step 2: Use it for the side preview offsets**

In `updateSidePreviews`, replace:

```js
    // Calculate main canvas display width and position side previews with 10px gap
    const mainCanvasWidth = dims.width * previewScale;
    const gap = 10;
    const sideOffset = mainCanvasWidth / 2 + gap;
    const farSideOffset = sideOffset + mainCanvasWidth + gap;
```

with:

```js
    // Calculate main canvas display width and position side previews, closing the
    // gutter where a continuation joins two slides
    const mainCanvasWidth = dims.width * previewScale;
    const selected = state.selectedIndex;
    const leftGap = continuationGap(selected - 1, selected);
    const rightGap = continuationGap(selected, selected + 1);
    const farLeftGap = continuationGap(selected - 2, selected - 1);
    const farRightGap = continuationGap(selected + 1, selected + 2);
    const leftOffset = mainCanvasWidth / 2 + leftGap;
    const rightOffset = mainCanvasWidth / 2 + rightGap;
    const farLeftOffset = leftOffset + mainCanvasWidth + farLeftGap;
    const farRightOffset = rightOffset + mainCanvasWidth + farRightGap;
```

Then update the four usages in the same function:

- `sidePreviewLeft.style.right = \`calc(50% + ${sideOffset}px)\`;` → use `leftOffset`
- `sidePreviewFarLeft.style.right = \`calc(50% + ${farSideOffset}px)\`;` → use `farLeftOffset`
- `sidePreviewRight.style.left = \`calc(50% + ${sideOffset}px)\`;` → use `rightOffset`
- `sidePreviewFarRight.style.left = \`calc(50% + ${farSideOffset}px)\`;` → use `farRightOffset`

- [ ] **Step 3: Use it for the slide animation distance**

In `slideToScreenshot`, replace:

```js
    const slideDistance = dims.width * previewScale + 10; // canvas width + gap
```

with:

```js
    // Travel the same distance the target preview is actually offset by, so a
    // closed gutter does not desync the animation
    const gap = direction === 'right'
        ? continuationGap(state.selectedIndex, newIndex)
        : continuationGap(newIndex, state.selectedIndex);
    const slideDistance = dims.width * previewScale + gap;
```

- [ ] **Step 4: Verify by hand**

With three slides and no continuations, confirm the preview strip looks exactly as before and sliding between slides lands cleanly with no jump. Then enable "Continue from previous" on slide 2 and confirm slides 1 and 2 sit flush in the strip while slides 2 and 3 keep their gutter, and that sliding between 1 and 2 still lands cleanly.

- [ ] **Step 5: Confirm no render regression**

```js
await import('/tests/render-baseline.js');
(await renderBaseline.compare()).pass;
```

Expected: `true`.

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: close the preview gutter between linked slides"
```

---

## Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the finished feature.
- Produces: nothing code-facing.

- [ ] **Step 1: Update `CLAUDE.md`**

The architecture section is stale in ways this work makes worse. In the "Key patterns in app.js" section, correct the `app.js` line count, and replace the canvas rendering pipeline list with:

```markdown
**Canvas rendering pipeline:**
All rendering goes through `renderScreenshotToCanvas(index, canvas, ctx, dims, scale)`,
used by the main preview, the side previews, and export. `updateCanvas()` delegates
to it for the selected screenshot and handles the empty-state preview itself.

1. `drawBackgroundToContext()` - gradient/solid/image with optional blur and overlay
2. `drawNoiseToContext()` - optional noise texture
3. `drawElementsToContext(..., 'behind-screenshot')`
4. `drawContinuationDevices()` - adjacent slides' devices bleeding across the seam
5. `drawScreenshotToContext()` or `renderThreeJSForScreenshot()` - this slide's device
6. `drawElementsToContext(..., 'above-screenshot')`
7. `drawPopoutsToContext()`
8. `drawTextToContext()`
9. `drawElementsToContext(..., 'above-text')`

**Device continuation:**
`screenshot.continueFromPrev` / `continueFromNext` make a slide render its
neighbour's device translated by one canvas width. Fully derived at render time -
nothing is copied, so slide reordering re-derives automatically. 3D uses
`camera.setViewOffset` to render an off-axis tile rather than moving the model.
```

- [ ] **Step 2: Update `README.md`**

In the "Device Mockups" feature list, add:

```markdown
- **Continuation**: A device can bleed off one slide and continue onto the next, so a pair of screenshots reads as one continuous scene
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document the unified render path and device continuation"
```

---

## Verification checklist

Run before considering the feature done:

- [ ] `node --check app.js && node --check three-renderer.js`
- [ ] `renderBaseline.compare()` passes
- [ ] 2D seam check: `maxDiff <= 2`, `deviceRows > 0`
- [ ] 3D seam check: `maxDiff <= 2`, `deviceRows > 0`
- [ ] Export a two-slide set with a continuation and confirm the PNGs join correctly when placed side by side
- [ ] Export all languages on a project with localized images and confirm the continuation follows the language
- [ ] Toggles disabled on the first and last slides
- [ ] Delete a middle slide with continuations set and confirm no console errors and the flags re-derive against the new neighbours
- [ ] Console clean of errors through a full session
