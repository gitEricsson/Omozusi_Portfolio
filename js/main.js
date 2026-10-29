import { Portrait } from "./portrait-gl.js";
import { Ink, loadLettering } from "./ink.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const debug = new URLSearchParams(location.search).has("debug");
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

document.documentElement.classList.add("js");

const hero = $(".hero");
const layer = $(".hero__portrait");
const canvas = $(".portrait");
const still = $(".portrait-still");
const lockup = $(".hero__lockup");
const nameEl = $(".hero__name");
const portrait = new Portrait(canvas);
let live = false;
let nameInk = null;      // her name, written by pen once the lettering data arrives
const GLOOCK_PER_PX = 4.17; // width of "Omozusi" per px of font size (with -0.02em tracking), until then

// Fallback numbers until meta.json arrives (they match the shipped art).
let meta = { size: [862, 713], eyeMid: [483, 298.5], hairAtEyes: [85, 693] };

// ---------- layout ----------
// Desktop: she stands on the bottom edge right of centre; her name fills the space left of her curls.
// Phone: her name sits on top; she fills the rest of the screen below it.
const HEADBAND_TOP = 40; // source px from the top of the art to the top of her headband

function layout() {
  const W = hero.clientWidth, H = hero.clientHeight;
  const [sw, sh] = meta.size;
  const aspect = sw / sh;
  const mobile = W < 641;
  const gutter = parseFloat(getComputedStyle(document.body).getPropertyValue("--gutter")) || 24;
  const setSize = (s) => {
    hero.style.setProperty("--name-size", `${s}px`);
    if (nameInk) { nameInk.align = mobile ? "center" : "left"; nameInk.layout(s); }
  };
  const perPx = nameInk ? nameInk.widthPerPx : GLOOCK_PER_PX;
  let rect;

  if (mobile) {
    const top = 76;
    let size = Math.min((W - gutter * 2) / perPx, W * 0.24);
    setSize(size);
    Object.assign(lockup.style, { top: `${top}px`, width: "" });
    const below = top + lockup.offsetHeight + 14;
    let imgW = Math.min(Math.max(((H - below) / (1 - HEADBAND_TOP / sh)) * aspect, W * 1.1), W * 1.6);
    const imgH = imgW / aspect;
    // 0.53: the middle of her face sits a little right of the image centre.
    rect = [W * 0.5 - imgW * 0.53, H - imgH, imgW, imgH];
    const headTop = rect[1] + (HEADBAND_TOP / sh) * imgH;
    if (headTop < below) {
      size *= Math.max(0.7, (headTop - 14 - top) / lockup.offsetHeight);
      setSize(size);
    }
  } else {
    const imgH = Math.min(H * 0.94, (W * 0.7) / aspect);
    const imgW = imgH * aspect;
    rect = [W * 0.62 - imgW * 0.53, H - imgH, imgW, imgH];
    const hairL = rect[0] + (meta.hairAtEyes[0] / sw) * imgW;
    const eyeY = rect[1] + (meta.eyeMid[1] / sh) * imgH;
    const tuck = imgW * 0.006; // the longer word just kisses her outer curls
    setSize(Math.min((hairL - gutter + tuck) / perPx, H * 0.17, 210));
    const top = Math.max(96, eyeY - nameEl.offsetHeight * 0.55);
    Object.assign(lockup.style, { top: `${top}px`, width: `${hairL - gutter + tuck}px` });
  }

  const [x, y, w, h] = rect;
  Object.assign(still.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  if (live) portrait.layout(W, H, rect);
  hero.style.setProperty("--gx", `${((x + (meta.eyeMid[0] / sw) * w) / W) * 100}%`);
  hero.style.setProperty("--gy", `${((y + (meta.eyeMid[1] / sh) * h) / H) * 100}%`);
  hero.classList.add("is-placed");
}

still.hidden = false;
document.fonts.ready.then(layout);
layout();
let resizeT;
addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { layout(); sizeSignature(); }, 100); });

// ---------- her name, written by hand ----------
// The tagline and email link arrive as the pen finishes.
loadLettering("name").then((data) => {
  nameInk = new Ink($(".hero__name .ink"), data, { lineHeight: 0.94, tracking: -0.02 });
  nameEl.classList.add("has-ink");
  layout();
  if (reduced) {
    nameInk.show();
    lockup.classList.add("is-written");
    return;
  }
  nameInk.write({ duration: 3.4, delay: 0.4, onProgress: (k) => { if (k > 0.8) lockup.classList.add("is-written"); } });
}).catch((e) => {
  console.warn("Name stays as text:", e.message);
  nameEl.classList.add("ink-failed");
  lockup.classList.add("is-written");
});

// ---------- the living portrait ----------
if (!reduced) {
  const giveUp = new Promise((_, reject) => setTimeout(() => reject(new Error("took too long")), debug ? 90000 : 10000));
  Promise.race([portrait.load(), giveUp]).then(() => {
    meta = portrait.meta;
    live = true;
    layout();
    portrait.start();
    // Fade the live portrait in over the still, then drop the still. Keyed to the first frame
    // actually drawn, so a tab that loads in the background keeps the still until it's shown.
    canvas.style.opacity = "0";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      canvas.style.transition = "opacity .6s ease-out";
      canvas.style.opacity = "1";
      setTimeout(() => (still.hidden = true), 650);
    }));
  }).catch((e) => {
    console.warn("Portrait stays still:", e.message);
    canvas.hidden = true;
  });
} else {
  canvas.hidden = true;
}

// Her eyes follow the pointer anywhere on the page while she's on screen.
let heroVisible = true;
function aim(x, y) {
  if (!live) return;
  const r = canvas.getBoundingClientRect();
  portrait.setPointer(x - r.left, y - r.top);
}
addEventListener("pointermove", (e) => { if (heroVisible) aim(e.clientX, e.clientY); }, { passive: true });
addEventListener("pointerdown", (e) => aim(e.clientX, e.clientY), { passive: true });
let touchT;
addEventListener("pointerup", (e) => {
  if (e.pointerType !== "mouse") { clearTimeout(touchT); touchT = setTimeout(() => portrait.setPointer(null), 1600); }
});
// The cursor left the window: she looks back at you.
addEventListener("mouseout", (e) => { if (!e.relatedTarget) portrait.setPointer(null); });

// The email link: hovering (or focusing) it earns a knowing smirk; clicking it, a proper smile.
const mail = $(".hero__mail");
let smileT;
const smirk = (on) => portrait.setMood("smirk", on ? 1 : 0);
mail.addEventListener("pointerenter", () => smirk(true));
mail.addEventListener("pointerleave", () => smirk(false));
mail.addEventListener("focus", () => smirk(true));
mail.addEventListener("blur", () => smirk(false));
mail.addEventListener("click", () => {
  portrait.setMood("smile", 1);
  clearTimeout(smileT);
  smileT = setTimeout(() => portrait.setMood("smile", 0), 1600);
});

new IntersectionObserver(([e]) => {
  heroVisible = e.isIntersecting;
  if (!live) return;
  heroVisible && !document.hidden ? portrait.start() : portrait.stop();
}).observe(hero);
document.addEventListener("visibilitychange", () => {
  if (!live) return;
  document.hidden || !heroVisible ? portrait.stop() : portrait.start();
});

// ---------- scrolling: the portrait recedes, the nav firms up ----------
const nav = $(".nav");
// The nav's small copy of her name appears only once the big one has scrolled out from under it.
new IntersectionObserver(([e]) => nav.classList.toggle("show-name", !e.isIntersecting), {
  rootMargin: "-72px 0px 0px 0px",
}).observe(nameEl);
let lastY = 0, ticking = false;
function onScroll() {
  const y = scrollY, H = hero.clientHeight;
  const k = Math.min(1, y / H);
  if (!reduced) {
    layer.style.transform = `translateY(${k * H * 0.18}px) scale(${1 - k * 0.04})`;
    layer.style.opacity = String(1 - k * 0.75);
    $(".hero__name").style.transform = `translateY(${k * H * 0.08}px)`;
  }
  nav.classList.toggle("is-solid", y > H * 0.85);
  nav.classList.toggle("is-hidden", y > lastY && y > H);
  lastY = y;
  ticking = false;
}
addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });

// ---------- reveals ----------
const io = new IntersectionObserver((entries) => entries.forEach((e) => {
  if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}), { rootMargin: "0px 0px -10% 0px" });
$$("[data-reveal]").forEach((el) => io.observe(el));

// ---------- signature: she signs off at the end of Contact ----------
let sigInk = null;
function sizeSignature() {
  if (!sigInk) return;
  const gutter = parseFloat(getComputedStyle(document.body).getPropertyValue("--gutter")) || 24;
  const room = (Math.min(innerWidth, 1320) - gutter * 2) * 0.9;
  sigInk.layout(Math.min(110, room / sigInk.widthPerPx));
}
loadLettering("signature").then((data) => {
  sigInk = new Ink($(".signoff .ink"), data, { color: "#d2a963", nib: "#f6e6c8", align: "center" });
  sizeSignature();
  if (reduced) return sigInk.show();
  new IntersectionObserver(([e], obs) => {
    if (!e.isIntersecting) return;
    obs.disconnect();
    sigInk.write({ duration: 3.8, delay: 0.25 });
  }, { threshold: 0.7 }).observe($(".signoff"));
}).catch(() => {});

// ---------- contact ----------
const copyBtn = $("[data-copy]");
const status = $(".contact__status");
copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(copyBtn.dataset.copy);
    status.textContent = "Copied to your clipboard.";
  } catch {
    getSelection().selectAllChildren(copyBtn);
    status.textContent = "Selected. Press Ctrl+C to copy.";
  }
  clearTimeout(copyBtn._t);
  copyBtn._t = setTimeout(() => (status.textContent = ""), 2600);
});

if (debug) Object.assign(window, { portrait, layout, ink: () => ({ nameInk, sigInk }) });
