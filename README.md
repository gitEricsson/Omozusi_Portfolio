# Omozusi_Portfolio

The portfolio website of **Omozusi Eguare**, a writer working across medicine and research, crypto and Web3, and YouTube scriptwriting.

The site opens on an illustrated portrait of her that is alive. Her eyes follow the visitor's cursor (or finger) with the quick, jerky movements of real eyes. She blinks at natural intervals, her head turns slightly toward you, her curls move in a light breeze and her earring swings. Everything is drawn in real time in WebGL from a single illustration, so it never loops and never looks like a video.

It is a static site: plain HTML, CSS and JavaScript, with no framework, no bundler and no build step.

---

## Contents

- [Highlights](#highlights)
- [Running it locally](#running-it-locally)
- [Project structure](#project-structure)
- [How the living portrait works](#how-the-living-portrait-works)
- [How the handwriting works](#how-the-handwriting-works)
- [Tuning the motion](#tuning-the-motion)
- [Editing the content](#editing-the-content)
- [Replacing or updating the portrait](#replacing-or-updating-the-portrait)
- [Design tokens](#design-tokens)
- [Accessibility and performance](#accessibility-and-performance)
- [Browser support](#browser-support)
- [Deployment](#deployment)
- [Before going live](#before-going-live)

---

## Highlights

- **Eyes that follow you.** Both irises track the pointer anywhere on the page:
  - **Saccades:** fast jumps of 30–75 ms instead of smooth gliding.
  - **Micro-saccades:** tiny drifts while she holds her gaze on a point.
  - **Losing interest:** if the cursor stays still for 3 seconds, or leaves the window, she settles back into her default face. Her eyes return to you, her head straightens and any smirk fades, with only the occasional glance away. She picks the cursor up again as soon as it moves.
- **Natural blinking.** A blink every 2.5–7 seconds, sometimes a double blink, and often one during a large eye movement, as people do. The lid closes in 75 ms and opens in 150 ms; that asymmetry is what makes a blink read as real.
- **True to the artwork.** The eye openings are traced exactly to the lower edge of her eyeliner, so the liner, wing and heavy-lidded look of the illustration are untouched. Only the iris moves and only the lid closes.
- **Her name writes itself.** On arrival a pen writes "Omozusi Eguare" in the display serif, stroke by stroke in real writing order, with a small gold nib at the tip. Each letter's serifs and hairlines settle in as the pen leaves it, then her tagline and email link appear.
- **She signs off.** At the end of the page, her signature writes itself in gold script when it comes into view, like signing a letter.
- **She reacts.** Hovering over or focusing the hero's "Email Omozusi" link earns a knowing smirk: one lip corner curls up into a dimple, the cheek lifts and her lower lids rise. Clicking it gives a fuller smile before the email opens.
- **Subtle life everywhere else.** Her head turns toward the viewer: the middle of her face moves slightly further than her outline, so it reads as a turn in depth rather than a tilt. Her curls move in the wind; segmentation masks keep her face, glasses and headband rigid. The earring swings from its own pivot, and the whole figure breathes.
- **Editorial design.** An espresso, clay, cream and gold palette taken from the artwork. A high-contrast display serif with a warm text serif, and section headings that stay in view while their content scrolls.
- **No dependencies.** Two Google Fonts and nothing else at runtime. The handwriting is pre-built geometry; no script font is downloaded.

## Running it locally

The page loads its textures with `fetch`, so it needs to be served over HTTP; opening `index.html` directly from disk won't work.

```bash
python tools/serve.py
```

Then open <http://127.0.0.1:5173>. The server sends `Cache-Control: no-store`, so edits show on every reload. Pass a different port as an argument if 5173 is taken:

```bash
python tools/serve.py 8080
```

Any other static server works too, for example `npx serve .`.

### Debug mode

Add `?debug` to the URL (`http://127.0.0.1:5173/?debug`) to expose the portrait engine on `window.portrait` for inspection in the browser console:

```js
portrait.blink();                                      // blink now
portrait.forced = { gaze: { x: -7.5, y: 0 }, blink: 0 }; // pin the gaze (source px) and lid (0–1)
portrait.setMood("smirk", 1);                          // or "smile"; 0 to relax
portrait.forced = null;                                // back to normal behaviour
```

`ink()` returns the two lettering animations (`{ nameInk, sigInk }`); `ink().nameInk.write({ duration: 3.4 })` writes her name again.

In debug mode, the 10-second load timeout that falls back to the still image is extended to 90 seconds.

## Project structure

```
.
├── index.html                  Page markup and all written content
├── css/
│   └── styles.css              Design tokens, layout, responsive rules, reduced-motion rules
├── js/
│   ├── main.js                 Layout of the hero, pointer handling, scroll effects, reveals, copy-to-clipboard
│   ├── portrait-gl.js          The living-portrait engine (WebGL2 shader, gaze and blink controllers)
│   └── ink.js                  Pen-written lettering (her name and the signature)
├── assets/
│   ├── favicon.svg
│   └── portrait/               Generated by tools/build_portrait.py — don't edit by hand
│       ├── art.webp            The illustration, 2× upscaled, edges cleaned
│       ├── weights.png         Motion maps (R hair, G head, B body, A earring)
│       └── meta.json           Eye shapes and colours, pivots, sizes
│   └── lettering/              Generated by tools/build_lettering.py — don't edit by hand
│       ├── name.json           "Omozusi / Eguare": letter outlines + pen strokes
│       └── signature.json      "Omozusi Eguare" in script: letter outlines + pen strokes
└── tools/
    ├── illustration.webp       Source illustration (transparent background)
    ├── layers/                 Segmentation cut-outs: hair, glasses, earring, headband, shirt
    ├── landmarks.json          Hand-placed shapes: eye openings, irises, lids, face, pivots, layer offsets
    ├── build_portrait.py       Turns the illustration + landmarks + layers into assets/portrait/*
    ├── build_lettering.py      Turns words into pen strokes and outlines in assets/lettering/*
    ├── fonts/                  Gloock and Mrs Saint Delafield, with their licences (OFL)
    └── serve.py                No-cache local server
```

## How the living portrait works

### 1. The asset pipeline (`tools/build_portrait.py`)

The pipeline runs once, offline, and produces the three files in `assets/portrait/`.

1. **Clean-up.** Removes stray near-white specks left between the outer curls by the background removal.
2. **Art.** Upscales the illustration 2× in premultiplied space, gently sharpens the facet edges and softens the stair-stepped cutout edge. It then spreads edge colours into the transparent area so texture filtering never pulls in a dark fringe. Output: `art.webp`.
3. **Eyes.** For each eye, the hand-traced opening from `landmarks.json` is sampled into 32 columns. Each column stores four heights: the top of the lid, the top of the lash band, the top of the opening and the bottom of the opening. Colours are sampled from the art:
   - The whites, from their brightest pixels
   - The iris
   - The liner, from the darkest band above the opening
   - The lid skin, from the plane between liner and crease

   All of this goes into `meta.json`.
4. **Motion maps** (`weights.png`):
   - **R, hair:** taken from the hair segmentation layer. It is zero at the roots and strongest at the outer curls, and extends slightly past the outline so the silhouette itself moves. Face, glasses and headband are excluded so they never bend.
   - **G, head:** everything above the collar, softening into the neck.
   - **B, body:** the jacket, for breathing.
   - **A, earring:** from the earring layer. Its pivot is the top-centre of the hoop.

### 2. The runtime (`js/portrait-gl.js`)

A single full-screen fragment shader draws the portrait. For each pixel on screen it works backwards through every motion to find which pixel of the art belongs there:

```
breath  →  head turn  →  earring swing  →  smile  →  hair wind  →  blink  →  sample the art
```

- **Smile** lifts each lip corner (and, more broadly, the cheek above it) along the line of her mouth, with a small dimple where the corner tucks in. The lip corners are marked in `tools/landmarks.json` under `mouth`.

- **Hair wind** is a layered noise field: a slow flow plus faster flutter during gusts. It is inverted by fixed-point iteration, so curls move without tearing.
- **Blink:** the dark lash band slides down unchanged; behind it, flat lid planes are painted in her own lid colour, and the eye is squeezed into the shrinking gap.
- **Inside each eye opening** the original pixels are replaced by a drawn eye, so the iris can move and the lids always clip it correctly:
  - Dim whites, with the upper half in shadow under the liner
  - A near-black iris in faint facets, the pupil barely separate
  - A small cool reflection
  - Hairline lash edges
- **Levels of detail** are chosen explicitly (`textureLod`) from the on-screen scale. Automatic mip selection breaks along the image edges and draws one-pixel lines.

Two small controllers run on the CPU each frame:

- **`Gaze`** converts the pointer position into an iris offset and moves the eyes the way real eyes move:
  - Saccades, with fixations between them
  - Micro-saccades every 0.5–1.3 s
  - A return to the viewer, with occasional glances away, when there is no pointer or it has been still for 3 s
- **The blink scheduler** handles random intervals, double blinks, and blinks triggered by large saccades.

The engine renders only while the hero is on screen and the tab is visible, and caps pixel density at 2×.

### 3. The page (`js/main.js`)

- **Layout:** sizes and places the portrait and the name lockup.
  - On desktop she stands on the bottom edge, right of centre. Her name is sized to the space left of her curls and set at eye level.
  - On phones her name sits on top and she fills the rest of the screen.
- **Loading:** shows the still illustration immediately, swaps to the live portrait once its first frame is drawn, and falls back to the still if WebGL is unavailable or loading takes over 10 seconds.
- **Scrolling:** the portrait recedes and dims, the nav gains a background past the hero and hides while scrolling down, and sections fade in.

## How the handwriting works

A font stores the outline of each letter, not the pen strokes that made it, so the strokes are worked out ahead of time by `tools/build_lettering.py`:

1. **Skeleton.** Each letter is drawn large and thinned to a one-pixel centre line. Pixels that only form diagonal "staircases" are removed, so curves don't read as junctions.
2. **Graph.** The centre line is split into strokes between free ends and junctions; touching junction pixels are merged into one point.
3. **Serifs trimmed.** Short spurs left on the centre line by serifs and sharp corners are dropped. Strokes still shorter than 0.19 × the font size after walking (a foot serif, the flag on top of a stem) are left out too (`MIN_STROKE`), so the pen never dabs backwards at the end of a letter; the letter's settle fills them in.
4. **Writing order.** The strokes are walked the way a hand would: start top-left, go as straight as possible through junctions, and lift the pen only when there's nowhere left to go. Closed loops start at the top and go anticlockwise; dots (the "i") come last.
5. **Width.** Each pen point stores how far it is from the letter's edge, so the pen is always wide enough to cover the stroke.

The output, for each line, is the real letter outlines plus the pen strokes, with the width at every point.

At runtime, `js/ink.js`:

- **Plans the timing.** Each stroke's duration is proportional to its length. Short pauses are added where the pen lifts, between letters and between lines.
- **Moves the pen.** It eases into and out of each stroke, as a hand slows at the ends.
- **Reveals the ink.** It stamps the pen's path into a mask, and the letter outlines are drawn through that mask, so what appears is always the true letterform.
- **Dabs dots.** A single-point stroke (the dot of the i) spreads out from the nib over 0.16 s instead of popping in.
- **Settles each letter.** Once the pen leaves a letter, its full shape fades in over 0.35 s. This fills in serif tips and hairlines that a pen through the middle wouldn't reach.
- **Draws the nib.** A small gold point, with a soft glow, rides at the pen tip.

To regenerate (after changing the words or fonts, set in `JOBS` at the top of the script):

```bash
pip install pillow numpy fonttools
python tools/build_lettering.py           # writes assets/lettering/*
python tools/build_lettering.py --debug   # also writes stroke-order previews to tools/debug/
```

In the debug previews, strokes run from red (first) to blue (last); white dots mark where the pen goes down.

## Tuning the motion

All in `js/portrait-gl.js`:

| What | Where | Current value |
|---|---|---|
| How far the irises travel | `step()` → `Math.tanh(...) * 7.5` (sideways), `* 3.2` (up/down) | ±7.5 / ±3.2 source px |
| How far away the cursor must be to reach full travel | `step()` → `/ 230` | 230 source px |
| Saccade speed | `Gaze.update()` → `0.025 + dist * 0.0035` | ~30 ms short, ~75 ms across the eye |
| Still cursor before she returns to her default face | `IDLE_AFTER` at the top of the file | 3 s |
| Glances while at rest | `Gaze.update()` → `nextGlance = t + rand(2.5, 6)` | every 2.5–6 s |
| Glance size and duration | `Gaze.update()` → `rand(3.5, 7.5)`, `rand(0.8, 1.7)` | — |
| Blink interval | `step()` → `rand(2.5, 7)` | 2.5–7 s |
| Chance of a double blink | `step()` → `Math.random() < 0.2` | 20% |
| Blink shape | `#blinkValue()` | 75 ms close, 30 ms hold, 150 ms open |
| Hair movement | `render()` → `uHair` | `1.8 + 2.6 × gust` px |
| Head turn toward the cursor | `render()` → `uTurn` | the middle of her face moves up to 2.2 px further than her outline |
| Head drift and tilt | `render()` → `uHeadShift`, `headRot` | up to 0.9 px drift, 0.25° tilt (kept tiny so it never wobbles) |
| Breathing | `render()` → `uBreath` | 0.5% over 4.6 s |
| Smirk and smile strength | `render()` → `uLift` | smirk: 8.6 / 2.0 px; smile: 9.0 / 8.2 px (image-left / image-right corner) |
| Expression speed | `step()` → `rate = target > ... ? 9 : 5` | ~0.25 s in, ~0.5 s out |
| How long the click smile lasts | `js/main.js` → `setTimeout(..., 1600)` | 1.6 s |

Handwriting, in `js/main.js` and `js/ink.js`:

| What | Where | Current value |
|---|---|---|
| Name: pen time | `main.js` → `nameInk.write({ duration: 3.4 })` | 3.4 s of pen travel (about 6.3 s from load to the last stroke, with pauses) |
| Name: delay after load | `main.js` → `delay: 0.4` | 0.4 s |
| Signature: pen time | `main.js` → `sigInk.write({ duration: 3.8 })` | 3.8 s (about 5.9 s with pauses) |
| Signature: when it starts | `main.js` → `threshold: 0.7` | when 70% of it is on screen |
| Pauses for pen lifts | `ink.js` → `begin()` → `LIFT`, `LETTER`, `LINE` | 60 ms per lift, +70 ms between letters, 320 ms between lines |
| Dot dab | `ink.js` → `begin()` → `DAB` | 0.16 s |
| Letter settle time | `ink.js` → `SETTLE` | 0.35 s |

## Editing the content

All text lives in `index.html`, taken from her CV:

| Section | Element | Notes |
|---|---|---|
| Hero | `.hero__lockup` | Name, one-line description, email link |
| About | `#about` | First-person summary and quick facts |
| What I write | `#writing` | Four `<details>` panels; the first is open by default |
| Published | `.published` | The IJTDH 2024 paper, ORCID, and sample links |
| Journey | `#journey` | One `<li class="role">` per role, newest first |
| Credentials | `.creds` | Education, certificates, service |
| Contact | `#contact` | Email (click to copy) and a mailto link |

**Adding writing samples:** under "Published", the sample links currently open an email asking for samples. To publish a real piece, find the comment above them in `index.html`, then replace the `mailto:` link with the article's URL and the text with its headline.

**Adding a role:** copy an existing `<li class="role" data-reveal>…</li>` in the Journey list and edit the year, title, organisation, dates and description.

## Replacing or updating the portrait

Requirements: Python 3.10+, with Pillow and NumPy.

```bash
pip install pillow numpy
python tools/build_portrait.py          # writes assets/portrait/*
python tools/build_portrait.py --debug  # also writes preview images to tools/debug/
```

**Using a higher-resolution copy of the same illustration:**

1. Save it as `tools/illustration.webp` (PNG works too; update `source` in `tools/landmarks.json`). The background must be transparent.
2. Multiply every coordinate in `tools/landmarks.json` by the size ratio (×2 for a 1724-px-wide file), including the layer offsets.
3. Replace the files in `tools/layers/` with layers at the same resolution, or scale them by the same ratio.
4. Re-run the build and check `tools/debug/eye0.png` and `eye1.png`. The coloured curves should sit on the lid, the lash band, the top of the opening and the bottom of the opening.

**Using a different illustration:** re-trace the landmarks. The eye opening must start at the lower edge of the eyeliner, not above it, or the eyes open too wide and lose the liner. Measuring on a pixel-grid crop at 10× or more works well.

## Design tokens

Defined as CSS custom properties on `:root` in `css/styles.css`:

| Token | Value | Use |
|---|---|---|
| `--espresso` | `#17110d` | Page background |
| `--cocoa` | `#2b2119` | Deep surfaces |
| `--umber` | `#3d2d21` | Low-contrast surfaces |
| `--glow` | `#6b4428` | The backlight behind her head |
| `--clay` | `#a96d3f` | Secondary accent |
| `--cream` | `#efd5ad` | Text |
| `--gold` | `#d2a963` | Links, years, accents (from her earring) |

Type: **Gloock** (display) and **Newsreader** (text), from Google Fonts. The signature uses **Mrs Saint Delafield**, pre-built into pen strokes. All three are licensed under the SIL Open Font License; the two used for lettering are in `tools/fonts/` with their licence files.

## Accessibility and performance

- **Structure:** semantic landmarks and headings, alt text on the portrait, visible focus outlines, and native `<details>` for expandable panels.
- **Reduced motion:** with "reduce motion" switched on in the system settings, the portrait stays still, her name and signature appear already written, smooth scrolling and fade-ins are off, and all content is visible immediately.
- **The written name** is drawn on a canvas, but the real text stays in the page (visually hidden) for screen readers and search engines. If the lettering can't load, the plain text is shown instead.
- **Without WebGL:** the still illustration is shown in the same position.
- **Weight:** the portrait assets are about 340 KB in total. Rendering pauses when the hero is off screen or the tab is hidden.
- **Privacy:** only her email address is published. No phone number or street address.

## Browser support

The living portrait needs **WebGL2**: current Chrome, Edge, Firefox and Safari (15+) on desktop and mobile. Older browsers get the still illustration and the rest of the site works normally.

## Deployment

Any static host will do; there's nothing to build.

- **GitHub Pages:** in the repository, open **Settings → Pages**, set the source to the `main` branch and the root folder, and save. The site is published at `https://<user>.github.io/Omozusi_Portfolio/`.
- **Netlify:** drag the project folder onto <https://app.netlify.com/drop>, or connect the repository with no build command and `.` as the publish directory.
- **Vercel:** import the repository with the "Other" framework preset and no build command.

The `tools/` folder isn't needed online, but it does no harm.

## Before going live

- [ ] Omozusi reads and approves the About copy (written in first person from her CV)
- [ ] Real writing samples added under "Published", or the "on request" links kept
- [ ] Open Graph image checked when the link is shared (currently `assets/portrait/art.webp`)
- [ ] Custom domain connected, if wanted

---

© 2026 Omozusi Eguare. All rights reserved.
