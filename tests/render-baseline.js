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
        // Deliberately NOT requestAnimationFrame: rAF is suspended while the
        // page is hidden (document.hidden === true), which hangs every capture
        // when the harness is driven headlessly rather than in a visible tab.
        // Canvas drawing is synchronous, so a macrotask yield is sufficient.
        return new Promise(resolve => setTimeout(resolve, 0));
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
                // Regression guard for the null-image early-return in drawScreenshot():
                // text and elements must still draw from this screenshot's own
                // settings, not fall through to state.defaults, so this fixture
                // must NOT hash identically to 'empty-project'.
                s.text.headlines = { en: 'Blank screen headline' };
                s.elements = [textElement('above-text', 50, 85)];
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
            projectLanguages: state.projectLanguages.slice(),
            // getText() replaces state.defaults.text by reference (see app.js
            // getText()), so a deep snapshot is required here too - otherwise
            // the 'empty-project' fixture mutates the user's real project
            // defaults and, since saveState is restored to the real function
            // before the finally block's updateCanvas() call below, that
            // mutation gets persisted into IndexedDB.
            // background.image may hold a live Image object that does not
            // survive JSON round-tripping, so it is preserved by reference
            // and reattached on restore rather than deep-cloned.
            defaults: JSON.parse(JSON.stringify(state.defaults)),
            defaultsBackgroundImage: state.defaults.background.image
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

            // Warm-up pass: render every fixture once and discard the result.
            // The very first canvas paint after a page load measurably differs
            // (by a few pixel values) from every paint after it - observed on
            // getImageData/putImageData noise output, rotated+shadowed draws,
            // and popouts, with identical inputs and an identical seeded RNG.
            // This looks like a GPU/canvas-compositor cold-start effect, not
            // app logic (dims, draw order and RNG consumption are all fixed).
            // Rendering each fixture once before the measured pass makes the
            // measured pass consistently "warm" so capture()/compare() do not
            // depend on whether they are the first paint since page load.
            for (const name of Object.keys(fixtures)) {
                const fixture = fixtures[name];
                state.screenshots = fixture.screenshots;
                state.selectedIndex = fixture.index;
                updateCanvas();
                await nextFrame();
            }

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
            // Restore defaults BEFORE the updateCanvas() call below, which
            // runs with the real (non-noop) saveState and would otherwise
            // persist the harness's mutated defaults into IndexedDB.
            state.defaults = snapshot.defaults;
            state.defaults.background.image = snapshot.defaultsBackgroundImage;
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
