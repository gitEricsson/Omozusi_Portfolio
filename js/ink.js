// Pen-written lettering. A nib travels along pen strokes through the middle of each
// letter (made by tools/build_lettering.py) and reveals the real letter outlines as it
// goes; each finished letter's ink then settles into its full shape.

const ease = (u) => 0.6 * u + 0.4 * (0.5 - 0.5 * Math.cos(Math.PI * u)); // a hand slows into and out of a stroke

export class Ink {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} data   lettering JSON
   * @param {object} opts   { color, nib, align: "left"|"center", lineHeight (× font size), tracking (em) }
   */
  constructor(canvas, data, { color = "#efd5ad", nib = "#d2a963", align = "left", lineHeight = 0.94, tracking = 0 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.data = data;
    this.color = color;
    this.nib = nib;
    this.align = align;
    this.lineHeight = lineHeight;
    this.mask = document.createElement("canvas");
    this.mctx = this.mask.getContext("2d");
    this.state = "idle"; // idle | writing | done

    // Paths per glyph, and one ordered list of strokes across all lines.
    this.glyphs = [];
    this.strokes = [];
    // Letter-spacing, like CSS: each letter shifts by its index × tracking.
    const track = tracking * data.ref;
    this.track = track;
    data.lines.forEach((line, li) => {
      const base = this.glyphs.length;
      line.glyphs.forEach((g, gi) => this.glyphs.push({ path: new Path2D(g.d), line: li, dx: gi * track, settle: 0 }));
      line.strokes.forEach((s) => {
        let len = 0;
        for (let i = 1; i < s.p.length; i++) len += Math.hypot(s.p[i][0] - s.p[i - 1][0], s.p[i][1] - s.p[i - 1][1]);
        this.strokes.push({ g: base + s.g, line: li, dx: s.g * track, p: s.p, len: Math.max(len, 1) });
      });
    });
    // The last stroke of each glyph: when it's done, that letter's ink settles.
    this.lastOf = new Map();
    this.strokes.forEach((s, i) => this.lastOf.set(s.g, i));
  }

  /** Width per px of font size, for layout before drawing. */
  get widthPerPx() {
    const r = this.data.ref;
    return Math.max(...this.data.lines.map((l) => this.#lineWidth(l) / r));
  }

  #lineWidth(l) {
    return l.right - l.left + Math.max(0, l.glyphs.length - 1) * this.track;
  }

  /** Height per px of font size. */
  get heightPerPx() {
    const { ref, lines } = this.data;
    return (-lines[0].top + (lines.length - 1) * this.lineHeight * ref + lines[lines.length - 1].bottom) / ref;
  }

  layout(fontPx, width = null) {
    const { ref, lines } = this.data;
    const s = fontPx / ref;
    const pad = Math.ceil(fontPx * 0.06); // room for the nib's glow and overhangs
    const w = Math.ceil(width ?? this.widthPerPx * fontPx) + pad * 2;
    const h = Math.ceil(this.heightPerPx * fontPx) + pad * 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.s = s;
    this.pad = pad;
    this.canvas.width = this.mask.width = Math.round(w * dpr);
    this.canvas.height = this.mask.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    // Negative margins so the letters, not the padding, line up with the layout.
    this.canvas.style.margin = this.align === "center" ? `${-pad}px auto` : `${-pad}px`;
    // Origin of each line (baseline-left), in CSS px.
    let y = pad - lines[0].top * s;
    this.origins = lines.map((l) => {
      const lw = this.#lineWidth(l) * s;
      const x = this.align === "center" ? (w - lw) / 2 - l.left * s : pad - l.left * s;
      const o = { x, y };
      y += this.lineHeight * fontPx;
      return o;
    });
    // Re-stamp what's already written at the new size.
    this.mctx.setTransform(1, 0, 0, 1, 0, 0);
    this.mctx.clearRect(0, 0, this.mask.width, this.mask.height);
    if (this.state === "writing") this.#stampUpTo(this.cursor ?? { i: 0, k: 0 }, { i: 0, k: 0 });
    this.draw();
  }

  #toLine(ctx, li, dx = 0) {
    const o = this.origins[li];
    ctx.setTransform(this.dpr * this.s, 0, 0, this.dpr * this.s, this.dpr * (o.x + dx * this.s), this.dpr * o.y);
  }

  // Stamp nib discs into the mask from one stroke position to another.
  #stampUpTo(to, from) {
    const m = this.mctx;
    m.fillStyle = "#000";
    for (let i = from.i; i <= to.i && i < this.strokes.length; i++) {
      const st = this.strokes[i];
      this.#toLine(m, st.line, st.dx);
      const k0 = i === from.i ? from.k : 0;
      const k1 = i === to.i ? to.k : st.p.length - 1;
      m.beginPath();
      // A single-point stroke (the dot of an i) is dabbed: the ink spreads out from the nib.
      const dab = st.p.length === 1 && i === to.i ? ease(to.u ?? 1) : 1;
      for (let k = Math.max(0, Math.floor(k0)); k <= Math.min(k1, st.p.length - 1); k++) {
        const [x, y, r] = st.p[k];
        m.moveTo(x + r * dab, y);
        m.arc(x, y, r * dab, 0, Math.PI * 2);
      }
      m.fill();
    }
  }

  draw(nibAt = null, nibAlpha = 0) {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.fillStyle = this.color;
    if (this.state === "done") {
      this.glyphs.forEach((g) => { this.#toLine(c, g.line, g.dx); c.fill(g.path); });
      return;
    }
    if (this.state === "idle") return;
    // Letters, cut to what the pen has covered...
    this.glyphs.forEach((g) => { this.#toLine(c, g.line, g.dx); c.fill(g.path); });
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "destination-in";
    c.drawImage(this.mask, 0, 0);
    c.globalCompositeOperation = "source-over";
    // ...plus finished letters settling into their full shape (serif tips, hairlines).
    this.glyphs.forEach((g) => {
      if (g.settle <= 0) return;
      c.globalAlpha = Math.min(1, g.settle);
      this.#toLine(c, g.line, g.dx);
      c.fill(g.path);
    });
    c.globalAlpha = 1;
    // The nib: a small point of gold light at the tip of the pen.
    if (nibAt && nibAlpha > 0) {
      const st = this.strokes[nibAt.i];
      const k = Math.min(st.p.length - 1, Math.round(nibAt.k));
      const [x, y] = st.p[k];
      const o = this.origins[st.line];
      const px = this.dpr * (o.x + (x + st.dx) * this.s), py = this.dpr * (o.y + y * this.s);
      const r = Math.max(2, 0.018 * this.data.ref * this.s) * this.dpr;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = nibAlpha;
      const g = c.createRadialGradient(px, py, 0, px, py, r * 4);
      g.addColorStop(0, "rgba(210, 169, 99, 0.55)");
      g.addColorStop(1, "rgba(210, 169, 99, 0)");
      c.fillStyle = g;
      c.beginPath(); c.arc(px, py, r * 4, 0, Math.PI * 2); c.fill();
      c.fillStyle = this.nib;
      c.beginPath(); c.arc(px, py, r, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1;
    }
  }

  /** Show the finished lettering at once (reduced motion, or after a resize when done). */
  show() {
    this.state = "done";
    this.draw();
  }

  /**
   * Write it out. duration covers the pen's travel; lifts between strokes and letters add a little.
   * Resolves when the ink has settled.
   */
  write({ duration = 3, delay = 0, onProgress = () => {} } = {}) {
    this.begin({ duration, delay });
    return new Promise((resolve) => {
      const start = performance.now();
      const frame = (now) => {
        const el = (now - start) / 1000;
        const finished = this.frameAt(el);
        onProgress(Math.min(1, el / this.end));
        if (finished) {
          this.show();
          resolve();
        } else {
          this.raf = requestAnimationFrame(frame);
        }
      };
      this.raf = requestAnimationFrame(frame);
    });
  }

  /** Plan the writing: when each stroke starts and how long it takes. */
  begin({ duration = 3, delay = 0 } = {}) {
    // Pauses: lifting the pen to start a new stroke, moving on to the next letter, the next line.
    const LIFT = 0.06, LETTER = 0.07, LINE = 0.32, DAB = 0.16;
    const total = this.strokes.reduce((a, s) => a + s.len, 0);
    const near = 0.08 * this.data.ref; // a new stroke starting this close to the last one needs no lift
    let t = delay;
    this.plan = this.strokes.map((s, i) => {
      const prev = this.strokes[i - 1];
      if (prev) {
        const a = prev.p[prev.p.length - 1], b = s.p[0];
        const jump = Math.hypot(b[0] + s.dx - a[0] - prev.dx, b[1] - a[1]) > near;
        t += prev.line !== s.line ? LINE : (prev.g !== s.g ? LETTER : 0) + (jump ? LIFT : 0.008);
      }
      // Time per stroke ~ its length; a dot still takes a moment to dab.
      const dur = s.p.length === 1 ? DAB : (s.len / total) * duration;
      const item = { t0: t, dur };
      t += dur;
      return item;
    });
    this.penUp = t;
    this.end = t + SETTLE;
    this.state = "writing";
    this.cursor = { i: 0, k: 0 };
    this.glyphs.forEach((g) => (g.settle = 0));
    this.settleStart = new Map();
    this.mctx.setTransform(1, 0, 0, 1, 0, 0);
    this.mctx.clearRect(0, 0, this.mask.width, this.mask.height);
  }

  /** Draw the writing as it is `el` seconds in (times must not go backwards). True when finished. */
  frameAt(el) {
    const plan = this.plan;
    let i = this.cursor.i;
    while (i < plan.length - 1 && el >= plan[i + 1].t0) i++;
    const st = this.strokes[i];
    const u = Math.min(1, Math.max(0, (el - plan[i].t0) / plan[i].dur));
    const to = { i, k: ease(u) * (st.p.length - 1), u };
    if (el >= plan[i].t0) {
      this.#stampUpTo(to, this.cursor);
      this.cursor = to;
    }
    // Letters whose last stroke is done settle into their full shape.
    for (const [g, last] of this.lastOf) {
      const done = last < i || (last === i && u >= 1);
      if (done && !this.settleStart.has(g)) this.settleStart.set(g, el);
      if (this.settleStart.has(g)) this.glyphs[g].settle = (el - this.settleStart.get(g)) / SETTLE;
    }
    const nibAlpha = el < plan[0].t0 ? 0 : el <= this.penUp ? 1 : Math.max(0, 1 - (el - this.penUp) / 0.4);
    if (el >= this.end + 0.4) return true;
    this.draw(to, nibAlpha);
    return false;
  }
}

const SETTLE = 0.35; // seconds for a finished letter's ink to settle into its full shape

export async function loadLettering(name) {
  const r = await fetch(`assets/lettering/${name}.json`);
  return r.json();
}
