// Living portrait: the illustration drawn per pixel in WebGL2.
// For each screen pixel the shader works backwards through the motions
// (breath -> head -> earring -> hair -> blink) to find where to sample the art.
// Inside each eye opening the art is replaced by a drawn eye whose iris follows
// the gaze, so the lids always clip it. Data comes from tools/build_portrait.py.

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uArt, uWeights;
uniform vec2 uRes;          // canvas px
uniform vec4 uRect;         // image placement in canvas px (x, y, w, h), y down
uniform vec2 uSize;         // source image px
uniform float uTime, uHeadRot, uBreath, uEarRot, uHair, uGust;
uniform vec2 uHeadShift, uNeck, uEar;   // source px
uniform vec4 uEyeX;                     // x0, x1 for eye 0, then eye 1
uniform vec4 uEye[64];                  // per eye 32 columns of (lid top, lash top, opening top, opening bottom)
uniform vec3 uIris[2];                  // centre x, y, radius
uniform vec3 uSclera[2], uIrisCol[2], uLid[2], uLashCol[2];
uniform vec2 uGaze;                     // iris offset, source px
uniform float uBlink[2];
uniform float uArtLod;                  // mip level matching the on-screen scale
uniform vec2 uMouth[2];                 // lip corners, source px (image-left, image-right)
uniform vec2 uLift;                     // how far each corner rises, source px
uniform float uWiden, uSquint;          // smile width; lower lids rising with the cheeks
out vec4 outColor;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y) * 2.0 - 1.0;
}

// Explicit levels of detail: pixels outside the image return early, which leaves the GPU's
// automatic mip choice undefined along the image edges (it drew 1px lines of averaged colour).
vec4 W(vec2 p) { return textureLod(uWeights, p / uSize, 0.0); }

// A light breeze through the curls: slow flowing field, faster flutter in gusts.
vec2 hairField(vec2 p) {
  float t = uTime;
  vec2 q = p * 0.014;
  float a = noise(q + vec2(t * 0.3, t * 0.1));
  float b = noise(q * 1.8 + vec2(-t * 0.5, t * 0.35) + 7.3);
  float c = noise(p * 0.05 + vec2(t * 1.4, -t * 0.9));
  vec2 flow = vec2(a * 0.8 + 0.3 * uGust, b * 0.5);
  return (flow + vec2(c, c * 0.6) * 0.3 * (0.4 + uGust)) * uHair;
}

// Smile: each lip corner rises and draws outward, and the cheek above it lifts with it.
// Returns how far the art at p moves; inverted below by fixed-point iteration.
vec2 smileDisp(vec2 p) {
  vec2 axis = normalize(uMouth[1] - uMouth[0]);
  vec2 up = vec2(axis.y, -axis.x);
  vec2 d = vec2(0);
  for (int i = 0; i < 2; i++) {
    vec2 c = uMouth[i];
    vec2 outward = i == 0 ? -axis : axis;
    float lift = i == 0 ? uLift.x : uLift.y;
    vec2 pc = p - c;
    d += (up * lift + outward * uWiden * lift * 0.35) * exp(-dot(pc, pc) / (2.0 * 13.0 * 13.0));
    vec2 ck = p - (c + outward * 6.0 + up * 24.0);
    d += up * lift * 0.45 * exp(-dot(ck, ck) / (2.0 * 24.0 * 24.0));
  }
  return d;
}

// A small dimple where each raised corner tucks into the cheek.
float dimple(vec2 p) {
  vec2 axis = normalize(uMouth[1] - uMouth[0]);
  vec2 up = vec2(axis.y, -axis.x);
  float shade = 1.0;
  for (int i = 0; i < 2; i++) {
    float lift = i == 0 ? uLift.x : uLift.y;
    vec2 outward = i == 0 ? -axis : axis;
    vec2 dc = p - (uMouth[i] + up * lift * 0.8 + outward * 4.5);
    shade -= 0.16 * clamp(lift / 6.0, 0.0, 1.0) * exp(-dot(dc, dc) / (2.0 * 2.8 * 2.8));
  }
  return shade;
}

vec4 eyeCurve(int e, float t) {
  float f = clamp(t, 0.0, 1.0) * 31.0;
  int i = int(floor(f));
  int j = min(i + 1, 31);
  return mix(uEye[e * 32 + i], uEye[e * 32 + j], fract(f));
}

// The drawn eye at source position s, given the opening's top and bottom there.
vec3 eyeColour(int e, vec2 s, float t, float top, float bot) {
  vec3 iris = uIris[e];
  vec3 sc = uSclera[e] * 0.92;
  float ty = (s.y - top) / max(bot - top, 1e-3);
  // Flat planes: the heavy liner casts a deep shadow over the top half; the corners turn away.
  float shadowLine = 0.48 + 0.14 * (t - 0.5);
  float inShadow = 1.0 - smoothstep(shadowLine - 0.03, shadowLine + 0.03, ty);
  vec3 col = sc * mix(1.0, 0.5, inShadow);
  col *= mix(0.78, 1.0, smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.82, 1.0, t)));

  vec2 c = iris.xy + uGaze;
  vec2 d = s - c;
  float r = iris.z;
  float rr = length(d) / r;
  float a = atan(d.y, d.x);
  float wedge = floor((a / 6.28318 + 0.5) * 7.0 + float(e) * 0.5);
  float facet = 0.88 + 0.24 * hash(vec2(wedge, float(e) * 3.1));
  // As in the art: a near-black iris, the pupil barely separate from it, only the faintest
  // warmth low in the iris. Dark eyes under a heavy liner read as cool and in control.
  vec3 ic = uIrisCol[e] * 1.1 + vec3(0.01, 0.006, 0.002);
  ic *= mix(1.0, facet, 0.6);
  ic *= 1.0 + 0.22 * smoothstep(0.1, 0.9, d.y / r) * smoothstep(0.45, 0.7, rr);
  ic = mix(ic, uIrisCol[e] * 0.7, 1.0 - smoothstep(0.36, 0.44, rr));    // pupil, barely darker
  ic *= mix(1.0, 0.7, smoothstep(0.86, 0.98, rr));                        // limbal ring
  ic *= mix(1.0, 0.8, inShadow);
  float irisA = 1.0 - smoothstep(0.96, 1.02, rr);
  col = mix(col, ic, irisA);

  // A small, dim, cool reflection on the cornea, like the art's.
  vec2 hl = s - (iris.xy + uGaze * 0.85 + vec2(0.05, -0.38) * r);
  float spec = 1.0 - smoothstep(0.055 * r, 0.09 * r, length(hl));
  col = mix(col, vec3(0.3, 0.38, 0.4), spec * 0.6 * irisA);

  // Lash lines: a crisp dark edge under the upper liner and a dark lower lash line.
  // Kept to a hairline so they sharpen the edges without narrowing the eye.
  float lash = 1.0 - smoothstep(0.0, 0.45, s.y - top);
  float lower = 1.0 - smoothstep(0.0, 0.5, bot - s.y);
  col = mix(col, uLashCol[e], max(lash, lower * 0.7));
  return col;
}

// The closing upper lid, painted as flat skin planes like the rest of the face.
vec3 lidColour(int e, float t, float f) {
  vec3 c = uLid[e];
  float edge = 0.55 + 0.18 * (t - 0.5);
  c *= mix(1.0, 0.72, smoothstep(edge - 0.04, edge + 0.04, f));         // shadow plane above the lashes
  c *= mix(0.9, 1.0, smoothstep(0.0, 0.25, t) * (1.0 - smoothstep(0.75, 1.0, t)));
  c *= 1.0 + 0.06 * (1.0 - smoothstep(0.15, 0.3, abs(t - 0.45))) * (1.0 - smoothstep(0.2, 0.5, f));
  return c;
}

// Blink: the lash band slides down unchanged, painted lid skin fills in behind it,
// and the eye is squeezed into what's left. Returns source y; fills eye info.
float blink(int e, vec2 q, inout float eyeA, inout vec3 eyeCol) {
  float x0 = e == 0 ? uEyeX.x : uEyeX.z;
  float x1 = e == 0 ? uEyeX.y : uEyeX.w;
  float t = (q.x - x0) / (x1 - x0);
  if (t <= 0.0 || t >= 1.0) return q.y;
  vec4 c = eyeCurve(e, t);
  float lidTop = c.x, lashTop = c.y, top = c.z, bot = c.w;
  if (q.y < lidTop || q.y > bot + 3.0) return q.y;
  // A smile pushes the cheeks up: the lower lid rises and the upper lid settles a touch.
  float k = max(uBlink[e], uSquint * 0.12);
  float L = top - lashTop;
  float top2 = top + k * (bot - top - 0.6);
  float bot2 = bot - k * 0.9 - uSquint * 1.3;
  float sy;
  if (q.y < lashTop) {
    return q.y;
  } else if (q.y <= top2 - L) {
    // Lid skin where the lash band used to be and over the eye it now covers.
    float f = (q.y - lashTop) / max(top2 - L - lashTop, 1e-3);
    float fade = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.96, 1.0, t));
    eyeA = fade;
    eyeCol = lidColour(e, t, f);
    return q.y;
  } else if (q.y <= top2) {
    sy = lashTop + (q.y - (top2 - L));
  } else if (q.y <= bot2) {
    sy = top + (q.y - top2) * (bot - top) / max(bot2 - top2, 1e-3);
  } else {
    sy = bot + (q.y - bot2) * 3.0 / max(bot + 3.0 - bot2, 1e-3);
  }
  // The drawn eye fills the open gap, antialiased against the lids.
  float open = smoothstep(top2 - 0.35, top2 + 0.75, q.y) * (1.0 - smoothstep(bot2 - 0.75, bot2 + 0.35, q.y));
  open *= smoothstep(0.0, 0.035, t) * (1.0 - smoothstep(0.965, 1.0, t));
  open *= step(0.5, bot2 - top2 + 0.5);
  if (open > 0.0) {
    eyeA = open;
    eyeCol = eyeColour(e, vec2(q.x, sy), t, top, bot);
  }
  return sy;
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv0 = (frag - uRect.xy) / uRect.zw;
  if (uv0.x < 0.0 || uv0.x > 1.0 || uv0.y < 0.0 || uv0.y > 1.0) { outColor = vec4(0); return; }
  vec2 p = uv0 * uSize;

  // breath: the body rises very slightly from the bottom edge
  vec4 w = W(p);
  p.y = uSize.y + (p.y - uSize.y) / (1.0 + uBreath * w.b);

  // head: turn about the neck toward the viewer's cursor
  w = W(p);
  p = uNeck + rot(-uHeadRot * w.g) * (p - uNeck - uHeadShift * w.g);

  // earring swings from the lobe
  w = W(p);
  p = uEar + rot(-uEarRot * w.a) * (p - uEar);

  // smile: same inversion; skipped entirely while her face is at rest
  float shade = 1.0;
  if (uLift.x + uLift.y > 0.01) {
    vec2 m = p;
    for (int k = 0; k < 3; k++) m = p - smileDisp(m);
    shade = dimple(p);
    p = m;
  }

  // hair: invert the wind displacement by fixed-point iteration
  vec2 q = p;
  for (int k = 0; k < 2; k++) q = p - hairField(q) * W(q).r;

  float eyeA = 0.0;
  vec3 eyeCol = vec3(0);
  q.y = blink(0, q, eyeA, eyeCol);
  q.y = blink(1, q, eyeA, eyeCol);

  vec2 uv = q / uSize;
  vec4 art = textureLod(uArt, uv, uArtLod);
  // Past the art's edges there is nothing to stretch: stay transparent.
  art *= step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec3 col = mix(art.rgb, eyeCol, eyeA) * shade;
  float a = art.a;
  // The jacket fades into the background along the bottom edge.
  a *= 1.0 - smoothstep(0.8, 1.0, uv0.y);
  outColor = vec4(col * a, a);
}`;

const IDLE_AFTER = 3; // seconds without pointer movement before she returns to her default face

const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeIn = (t) => t * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

// Real eyes don't glide: they jump (saccades), hold, drift a little, and glance away when idle.
class Gaze {
  constructor() {
    this.cur = { x: 0, y: 0 };
    this.fix = { x: 0, y: 0 };
    this.sacc = null;
    this.lastSaccEnd = 0;
    this.nextMicro = 1;
    this.micro = { x: 0, y: 0 };
    this.glance = null;
    this.nextGlance = 5;
  }

  // target: desired offset in source px, or null when there's no (moving) pointer.
  // Returns true on a big jump.
  update(t, target) {
    let want = target;
    if (!target) {
      // Nobody there (or nobody moving): rest on the viewer, glancing away now and then.
      if (!this.glance && t > this.nextGlance) {
        const side = Math.random() < 0.5 ? -1 : 1;
        this.glance = { x: side * rand(3.5, 7.5), y: rand(-2, 2.2), until: t + rand(0.8, 1.7) };
      }
      if (this.glance && t > this.glance.until) {
        this.glance = null;
        this.nextGlance = t + rand(2.5, 6);
      }
      want = this.glance || { x: 0, y: 0 };
    } else {
      this.glance = null;
      this.nextGlance = t + rand(3, 6);
    }

    if (t > this.nextMicro) {
      this.micro = { x: rand(-0.4, 0.4), y: rand(-0.25, 0.25) };
      this.nextMicro = t + rand(0.5, 1.3);
    }
    const goal = { x: want.x + this.micro.x, y: want.y + this.micro.y };

    let bigJump = false;
    if (this.sacc) {
      const k = Math.min(1, (t - this.sacc.t0) / this.sacc.dur);
      const e = easeInOut(k);
      this.cur = { x: lerp(this.sacc.from.x, this.sacc.to.x, e), y: lerp(this.sacc.from.y, this.sacc.to.y, e) };
      if (k >= 1) { this.sacc = null; this.lastSaccEnd = t; }
    } else {
      const dist = Math.hypot(goal.x - this.cur.x, goal.y - this.cur.y);
      if (dist > 0.55 && t - this.lastSaccEnd > 0.11) {
        // Saccades take ~30 ms for a flick and ~75 ms across the whole eye.
        this.sacc = { from: { ...this.cur }, to: goal, t0: t, dur: 0.025 + dist * 0.0035 };
        bigJump = dist > 6;
      } else {
        // slow drift toward the fixation point between jumps
        this.cur.x = lerp(this.cur.x, goal.x, 0.02);
        this.cur.y = lerp(this.cur.y, goal.y, 0.02);
      }
    }
    return bigJump;
  }
}

export class Portrait {
  constructor(canvas, { base = "assets/portrait/" } = {}) {
    this.canvas = canvas;
    this.base = base;
    this.rect = [0, 0, 1, 1];
    this.cssRect = [0, 0, 1, 1];
    this.pointer = null;         // source px
    this.lastMove = 0;
    this.look = { x: 0, y: 0 };
    this.gaze = new Gaze();
    this.blinks = [];
    this.nextBlink = 1.6;
    this.gust = 0;
    this.frozen = null;
    this.forced = null;          // debug: { gaze: {x,y}, blink: k, smirk, smile }
    this.mood = { smirk: 0, smile: 0 };
    this.moodTarget = { smirk: 0, smile: 0 };
    this.running = false;
    this.t0 = performance.now();
  }

  async load(onProgress = () => {}) {
    const gl = this.canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;
    let done = 0;
    const tick = () => onProgress(++done / 4);
    const bitmap = (n) => fetch(this.base + n).then((r) => r.blob())
      .then((b) => createImageBitmap(b, { premultiplyAlpha: "none", colorSpaceConversion: "none" }))
      .then((bm) => (tick(), bm));
    const [meta, art, weights] = this.textures = await Promise.all([
      fetch(this.base + "meta.json").then((r) => r.json()).then((m) => (tick(), m)),
      bitmap("art.webp"),
      bitmap("weights.png"),
    ]);
    this.meta = meta;
    this.size = meta.size;
    this.program = this.#program(VERT, FRAG);
    gl.useProgram(this.program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    [["uArt", art], ["uWeights", weights]].forEach(([u, bm], i) => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bm);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(this.program, u), i);
    });

    const U = (n) => gl.getUniformLocation(this.program, n);
    this.u = {};
    for (const n of ["uRes", "uRect", "uSize", "uTime", "uHeadRot", "uBreath", "uEarRot", "uHair", "uGust",
      "uHeadShift", "uNeck", "uEar", "uEyeX", "uEye", "uIris", "uSclera", "uIrisCol", "uLid", "uLashCol", "uGaze", "uBlink", "uArtLod",
      "uMouth", "uLift", "uWiden", "uSquint"]) {
      this.u[n] = U(n);
    }
    const [w, h] = this.size;
    gl.uniform2f(this.u.uSize, w, h);
    gl.uniform2f(this.u.uNeck, ...meta.neckPivot);
    gl.uniform2f(this.u.uEar, ...meta.earPivot);
    gl.uniform4f(this.u.uEyeX, ...meta.eyes.flatMap((e) => [e.x0, e.x1]));
    const curves = new Float32Array(64 * 4);
    meta.eyes.forEach((e, k) => e.curve.forEach((row, i) => curves.set(row, (k * 32 + i) * 4)));
    gl.uniform4fv(this.u.uEye, curves);
    gl.uniform3fv(this.u.uIris, meta.eyes.flatMap((e) => e.iris));
    gl.uniform3fv(this.u.uSclera, meta.eyes.flatMap((e) => e.sclera));
    gl.uniform3fv(this.u.uIrisCol, meta.eyes.flatMap((e) => e.irisColor));
    gl.uniform3fv(this.u.uLid, meta.eyes.flatMap((e) => e.lidColor));
    gl.uniform3fv(this.u.uLashCol, meta.eyes.flatMap((e) => e.lashColor));
    gl.uniform2fv(this.u.uMouth, meta.mouth.corners.flat());
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    tick();
    return this;
  }

  #program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  // Place the image inside the canvas (CSS px).
  layout(cssW, cssH, rect) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.rect = rect.map((v) => v * dpr);
    this.cssRect = rect;
    if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (!this.running) this.render(this.now());
  }

  // Pointer in canvas CSS px, or null when it leaves.
  setPointer(x, y) {
    if (x == null) { this.pointer = null; return; }
    const [rx, ry, rw, rh] = this.cssRect;
    const [w, h] = this.size || [1, 1];
    this.pointer = { x: ((x - rx) / rw) * w, y: ((y - ry) / rh) * h };
    this.lastMove = this.now();
  }

  // Where the eyes are, in the canvas's CSS px (for layout).
  eyeLine() {
    const [rx, ry, rw, rh] = this.cssRect;
    const [w, h] = this.size;
    const m = this.meta;
    return { x: rx + (m.eyeMid[0] / w) * rw, y: ry + (m.eyeMid[1] / h) * rh, headL: rx + (m.head[0] / w) * rw, headR: rx + (m.head[2] / w) * rw };
  }

  blink(at = this.now()) { this.blinks.push(at); }

  // Expressions: "smirk" (one corner, knowing) and "smile" (both corners, warmer). 0–1.
  setMood(name, amount) {
    this.moodTarget[name] = amount;
    if (!this.running) this.render(this.now());
  }
  now() { return (performance.now() - this.t0) / 1000; }

  start() {
    if (this.running) return;
    this.running = true;
    let last = this.now();
    const loop = () => {
      if (!this.running) return;
      const t = this.now();
      this.step(t, Math.min(0.05, t - last));
      last = t;
      this.render(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  // Close fast (75 ms), hold, open slower (150 ms): the asymmetry is what reads as a real blink.
  #blinkValue(t) {
    let v = 0;
    for (const s of this.blinks) {
      const d = t - s;
      if (d < 0 || d > 0.26) continue;
      v = Math.max(v, d < 0.075 ? easeIn(d / 0.075) : d < 0.105 ? 1 : 1 - easeOut((d - 0.105) / 0.15));
    }
    this.blinks = this.blinks.filter((s) => t - s < 0.4);
    return v;
  }

  step(t, dt) {
    if (t > this.nextBlink) {
      this.blink(t);
      if (Math.random() < 0.2) this.blink(t + 0.3);
      this.nextBlink = t + rand(2.5, 7);
    }
    const swell = 0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.67 + 2.1);
    this.gust = Math.min(1, swell * 0.8);

    // A pointer that hasn't moved for a while counts as no pointer: she loses interest
    // and settles back into her default face until it moves again.
    const idle = !this.pointer || t - this.lastMove > IDLE_AFTER;

    // Gaze target: direction from between her eyes to the pointer, eased so far-away
    // pointers saturate instead of pushing the iris out of the eye.
    let target = null;
    const p = this.pointer;
    if (!idle) {
      const [mx, my] = this.meta.eyeMid;
      target = { x: Math.tanh((p.x - mx) / 230) * 7.5, y: Math.tanh((p.y - my) / 230) * 3.2 };
    }
    const bigJump = this.gaze.update(t, target);
    if (bigJump && Math.random() < 0.35 && t - (this.blinks.at(-1) ?? -9) > 1) {
      this.blink(t + 0.01);
      this.nextBlink = Math.max(this.nextBlink, t + 2.5);
    }

    // Expressions arrive quickly (~0.25 s) and leave a little slower (~0.5 s).
    // A smirk fades with interest; a click's smile always plays out.
    for (const k of ["smirk", "smile"]) {
      const target = k === "smirk" && idle ? 0 : this.moodTarget[k];
      const rate = target > this.mood[k] ? 9 : 5;
      this.mood[k] = lerp(this.mood[k], target, 1 - Math.exp(-dt * rate));
    }

    // The head follows the eyes, slowly.
    const g = this.gaze.cur;
    const k = 1 - Math.exp(-dt * 1.6);
    this.look.x = lerp(this.look.x, g.x / 7.5, k);
    this.look.y = lerp(this.look.y, g.y / 3.2, k);
  }

  render(t) {
    const gl = this.gl;
    if (!gl || !this.u) return; // still loading (e.g. the email link hovered early)
    if (this.frozen != null) t = this.frozen;
    const u = this.u;
    const deg = Math.PI / 180;
    const headRot = 0.5 * deg * (0.6 * Math.sin(t * 0.31) + 0.4 * Math.sin(t * 0.53 + 1.3)) + this.look.x * 1.3 * deg;
    const ear = 0.045 * Math.sin(t * 3.1) * (0.35 + 0.65 * this.gust) + 0.02 * Math.sin(t * 1.1) - headRot * 1.6;
    const gaze = this.forced?.gaze ?? this.gaze.cur;
    const blink = this.forced?.blink ?? this.#blinkValue(t);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform4f(u.uRect, ...this.rect);
    gl.uniform1f(u.uTime, t);
    gl.uniform1f(u.uHeadRot, headRot);
    gl.uniform2f(u.uHeadShift, this.look.x * 2.6 + Math.sin(t * 0.4) * 0.5, this.look.y * 1.4 + Math.sin(t * 0.29) * 0.4);
    gl.uniform1f(u.uBreath, 0.005 * Math.sin((t / 4.6) * Math.PI * 2));
    gl.uniform1f(u.uEarRot, ear);
    gl.uniform1f(u.uHair, 1.8 + 2.6 * this.gust);
    gl.uniform1f(u.uGust, this.gust);
    gl.uniform2f(u.uGaze, gaze.x, gaze.y);
    gl.uniform1fv(u.uBlink, [blink, blink]);
    gl.uniform1f(u.uArtLod, Math.max(0, Math.log2(this.textures[1].width / this.rect[2])));
    // The smirk lifts the corner nearer the viewer (image-left) far more than the other;
    // the smile lifts both. Blend whichever is stronger.
    const smirk = this.forced?.smirk ?? this.mood.smirk;
    const smile = this.forced?.smile ?? this.mood.smile;
    const ease = (v) => v * v * (3 - 2 * v);
    const sk = ease(Math.min(1, smirk)), sm = ease(Math.min(1, smile));
    gl.uniform2f(u.uLift, Math.max(sk * 6.8, sm * 6.2), Math.max(sk * 1.5, sm * 5.6));
    gl.uniform1f(u.uWiden, Math.max(sk * 0.5, sm * 1.0));
    gl.uniform1f(u.uSquint, Math.max(sk * 0.55, sm * 1.0));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
