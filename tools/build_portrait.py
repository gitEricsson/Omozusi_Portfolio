"""Build the living-portrait assets from the illustration and hand-placed landmarks.

    python tools/build_portrait.py            # writes assets/portrait/*
    python tools/build_portrait.py --debug    # also writes tools/debug/* previews

Outputs (assets/portrait/):
    art.webp      the illustration, 2x, colour bled under transparent pixels so edges don't fringe
    weights.png   motion maps: R hair, G head, B body, A earring
    meta.json     size, eye curves and colours, pivots
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "portrait"
DEBUG = ROOT / "tools" / "debug"
SCALE = 2
EYE_SAMPLES = 32
LUMA = np.array([0.299, 0.587, 0.114], np.float32)


# ---------- small image helpers ----------

def poly_mask(poly, w, h, ss=4):
    """Antialiased polygon mask as float32 [0,1]."""
    im = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(im).polygon([(x * ss, y * ss) for x, y in poly], fill=255)
    return np.asarray(im.resize((w, h), Image.LANCZOS), np.float32) / 255.0


def box_blur(a, r):
    """Three box passes ~ gaussian. Works on 2D or 3D (H,W,C)."""
    r = int(max(1, round(r)))
    out = a.astype(np.float32)
    for _ in range(3):
        for axis in (0, 1):
            pad = [(0, 0)] * out.ndim
            pad[axis] = (r + 1, r)
            p = np.pad(out, pad, mode="edge")
            c = np.cumsum(p, axis=axis)
            hi = np.take(c, range(2 * r + 1, c.shape[axis]), axis=axis)
            lo = np.take(c, range(0, c.shape[axis] - 2 * r - 1), axis=axis)
            out = (hi - lo) / (2 * r + 1)
    return out


def dilate(a, r):
    out = a.copy()
    for _ in range(int(r)):
        p = np.pad(out, 1, mode="edge")
        out = np.maximum.reduce([p[1:-1, 1:-1], p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]])
    return out


def distance_from(mask, max_d):
    """Approximate distance (px) from True pixels, capped at max_d."""
    dist = np.full(mask.shape, float(max_d), np.float32)
    cur = mask.astype(bool)
    dist[cur] = 0
    for d in range(1, max_d):
        nxt = dilate(cur.astype(np.float32), 1) > 0
        dist[nxt & ~cur] = d
        cur = nxt
    return dist


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def bleed(rgb, alpha):
    """Spread opaque colours into transparent pixels so bilinear sampling never pulls in black."""
    known = (alpha > 0.5).astype(np.float32)
    out = rgb.copy()
    for r in (2, 6, 18, 48):
        m = box_blur(known, r)
        v = box_blur(rgb * known[..., None], r)
        fill = v / np.maximum(m, 1e-4)[..., None]
        out = np.where((alpha <= 0.5)[..., None] & (m > 1e-3)[..., None] & (out.sum(2, keepdims=True) == 0), fill, out)
        known_now = (out.sum(2) > 0).astype(np.float32)
        known = np.maximum(known, known_now)
    return out


# ---------- art ----------

def build_art(rgba):
    """2x upscale in premultiplied space, gently sharpened so facet edges stay crisp."""
    h, w = rgba.shape[:2]
    a = rgba[..., 3:4]
    pre = np.concatenate([rgba[..., :3] * a, a], axis=2)
    im = Image.fromarray((pre * 255).round().astype(np.uint8), "RGBA")
    big = np.asarray(im.resize((w * SCALE, h * SCALE), Image.LANCZOS), np.float32) / 255.0
    A = big[..., 3]
    rgb = big[..., :3] / np.maximum(A, 1e-3)[..., None]
    rgb = np.clip(rgb, 0, 1)
    sharp = Image.fromarray((rgb * 255).round().astype(np.uint8)).filter(
        ImageFilter.UnsharpMask(radius=1.4, percent=70, threshold=2))
    rgb = np.asarray(sharp, np.float32) / 255.0
    # Tidy the cutout edge: the source alpha is stair-stepped, so soften it by a hair.
    A = np.clip((box_blur(A, 1) - 0.5) * 1.6 + 0.5, 0, 1)
    rgb[A < 0.02] = 0
    rgb = bleed(rgb, A)
    out = np.dstack([rgb, A])
    Image.fromarray((out * 255).round().astype(np.uint8), "RGBA").save(OUT / "art.webp", quality=95, method=6, exact=True)
    return out


# ---------- eyes ----------

def eye_data(img, alpha, e, w, h):
    """Per-column curves (lid top, lash top, opening top, opening bottom) and colours sampled from the art."""
    poly = e["opening"]
    m = poly_mask(poly, w, h, ss=8)
    xs_poly = [p[0] for p in poly]
    x0, x1 = min(xs_poly) + 0.25, max(xs_poly) - 0.25
    xs = np.linspace(x0, x1, EYE_SAMPLES)

    # Opening top/bottom per column from the polygon itself (sub-pixel via supersampled mask).
    ss = 8
    big = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(big).polygon([(x * ss, y * ss) for x, y in poly], fill=255)
    big = np.asarray(big) > 127
    rows = []
    for x in xs:
        col = big[:, min(int(round(x * ss)), w * ss - 1)]
        ys = np.nonzero(col)[0]
        if len(ys) == 0:
            cy = np.interp(x, [p[0] for p in poly], [p[1] for p in poly])
            top = bot = cy
        else:
            top, bot = ys[0] / ss, (ys[-1] + 1) / ss
        lash_top = top - e["lash"]
        lid_top = lash_top - e["lid"]
        rows.append([lid_top, lash_top, top, bot])
    rows = np.array(rows)
    # Smooth the curves a little so the blink edge never wobbles.
    for k in range(4):
        rows[:, k] = np.convolve(np.pad(rows[:, k], 2, mode="edge"), np.ones(5) / 5, mode="valid")

    cx, cy, r = e["iris"]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    inside = m > 0.9
    in_iris = (xx - cx) ** 2 + (yy - cy) ** 2 < (r * 0.95) ** 2
    lum = img @ LUMA

    # The visible white is a small share of the opening; take only its brightest pixels.
    sclera_px = img[inside & ~in_iris & (lum > np.percentile(lum[inside & ~in_iris], 80))]
    sclera = np.median(sclera_px, axis=0) if len(sclera_px) else np.array([0.85, 0.8, 0.74])
    iris_px = img[inside & in_iris]
    iris_lum = iris_px @ LUMA
    iris = np.median(iris_px[iris_lum < np.percentile(iris_lum, 70)], axis=0)
    # Lash colour: darkest band just above the opening.
    band = (yy < np.interp(xx, xs, rows[:, 2])) & (yy > np.interp(xx, xs, rows[:, 1])) & (xx > x0 + 4) & (xx < x1 - 4)
    lash_px = img[band]
    lash_lum = lash_px @ LUMA if len(lash_px) else None
    lash = np.median(lash_px[lash_lum <= np.percentile(lash_lum, 40)], axis=0) if len(lash_px) else iris * 0.8

    # Lid skin: the plane between the lid top and the lash band, without crease lines or highlights.
    lid_band = (yy > np.interp(xx, xs, rows[:, 0]) + 1) & (yy < np.interp(xx, xs, rows[:, 1]) - 1) & (xx > x0 + 6) & (xx < x1 - 6)
    lid_px = img[lid_band]
    lid_lum = lid_px @ LUMA
    mid = (lid_lum >= np.percentile(lid_lum, 35)) & (lid_lum <= np.percentile(lid_lum, 75))
    lid = np.median(lid_px[mid], axis=0)
    # Keep the lid her own shadowed lid colour (it reads like eyeshadow under the liner),
    # lifted only slightly toward the skin under the eye where the closed lid catches light.
    under_band = (yy > np.interp(xx, xs, rows[:, 3]) + 3) & (yy < np.interp(xx, xs, rows[:, 3]) + 11) & (xx > x0 + 8) & (xx < x1 - 8)
    under = np.median(img[under_band], axis=0)
    lid = lid * 0.85 + under * 0.15

    return {
        "x0": x0, "x1": x1,
        "lidColor": lid.round(4).tolist(),
        "curve": rows.round(3).tolist(),
        "iris": [cx, cy, r],
        "sclera": sclera.round(4).tolist(),
        "irisColor": iris.round(4).tolist(),
        "lashColor": lash.round(4).tolist(),
    }


# ---------- motion maps ----------

def layer_mask(spec, w, h):
    """Place a segmentation cut-out at its offset; returns a bool mask in illustration space."""
    path, ox, oy = spec
    a = np.asarray(Image.open(ROOT / path).convert("RGBA"))[..., 3] > 127
    m = np.zeros((h, w), bool)
    lh, lw = a.shape
    y0, x0 = max(0, oy), max(0, ox)
    y1, x1 = min(h, oy + lh), min(w, ox + lw)
    m[y0:y1, x0:x1] = a[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
    return m


def build_weights(lm, alpha, w, h):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    face = poly_mask(lm["face"], w, h) > 0.5
    band = poly_mask(lm["headband"], w, h) > 0.5
    sil = alpha > 0.5
    collar = lm["collar_y"]
    layers = lm.get("layers")
    rigid = face | band
    if layers:
        band = band | layer_mask(layers["headband"], w, h)
        glasses = layer_mask(layers["glasses"], w, h)
        hair_mask = layer_mask(layers["hair"], w, h) & sil
        rigid = (face | band | glasses) & ~hair_mask | glasses | layer_mask(layers["headband"], w, h)
    else:
        hair_mask = sil & ~face & ~band & (yy < collar)

    # Hair: only where the hair is, still at the roots and freest at the outer curls,
    # reaching a little past the outline so the silhouette itself moves.
    dist = distance_from(rigid, 70)
    hair = smoothstep(4, 60, dist) * hair_mask
    hair = dilate(hair, 6)
    hair = box_blur(hair, 3)
    hair *= 1 - box_blur(dilate(rigid.astype(np.float32), 2), 2)
    hair *= smoothstep(collar + 25, collar - 15, yy)
    hair = np.clip(hair / max(hair.max(), 1e-6), 0, 1)

    # Head: everything above the jacket, soft into the neck.
    head_region = (face | band | (sil & (yy < collar)) | (hair > 0.05)).astype(np.float32)
    head_region = np.maximum(head_region, ((yy < collar - 40) & (dilate(sil.astype(np.float32), 16) > 0)).astype(np.float32))
    head = np.clip(box_blur(dilate(head_region, 6), 10), 0, 1)
    head *= smoothstep(collar + 70, collar + 10, yy) * 0.6 + 0.4 * (yy < collar + 10)
    head = np.clip(head, 0, 1)

    body = smoothstep(collar - 20, h, yy) * (1 - head)

    if layers:
        ear = layer_mask(layers["earring"], w, h).astype(np.float32)
        # The hoop hangs from its top: pivot at the top-centre of the cut-out.
        ys, xs = np.nonzero(ear > 0.5)
        lm["earring"]["pivot"] = [float(xs[ys < ys.min() + 4].mean()), float(ys.min())]
    else:
        ear = poly_mask(lm["earring"]["shape"], w, h)
    ear = np.clip(box_blur(dilate(ear, 2), 1.5) * 1.15, 0, 1)

    wts = np.stack([hair, head, body, ear], axis=2)
    Image.fromarray((wts * 255).round().astype(np.uint8), "RGBA").save(OUT / "weights.png", optimize=True)
    return wts


def debug_overlay(img, alpha, lm, eyes, w, h):
    k = 2
    bg = np.ones_like(img) * np.array([0.09, 0.067, 0.05])
    comp = img * alpha[..., None] + bg * (1 - alpha[..., None])
    im = Image.fromarray((comp * 255).astype(np.uint8)).resize((w * k, h * k), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    sc = lambda pts: [(x * k, y * k) for x, y, *_ in pts]
    d.line(sc(lm["face"] + lm["face"][:1]), fill=(40, 255, 80), width=1)
    d.line(sc(lm["headband"] + lm["headband"][:1]), fill=(255, 220, 0), width=1)
    d.line(sc(lm["earring"]["shape"] + lm["earring"]["shape"][:1]), fill=(255, 140, 0), width=1)
    for e, ed in zip(lm["eyes"], eyes):
        xs = np.linspace(ed["x0"], ed["x1"], EYE_SAMPLES)
        rows = np.array(ed["curve"])
        for kk, col in zip(range(4), [(0, 220, 255), (255, 0, 255), (255, 255, 255), (255, 60, 60)]):
            d.line([(x * k, y * k) for x, y in zip(xs, rows[:, kk])], fill=col, width=1)
        cx, cy, r = e["iris"]
        d.ellipse([(cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k], outline=(0, 255, 0), width=1)
    for x, y in (lm["earring"]["pivot"], lm["neck_pivot"]):
        d.ellipse([x * k - 4, y * k - 4, x * k + 4, y * k + 4], outline=(255, 255, 0), width=2)
    im.save(DEBUG / "landmarks.png")
    for i, e in enumerate(lm["eyes"]):
        xs = [p[0] for p in e["opening"]]
        ys = [p[1] for p in e["opening"]]
        box = (int(min(xs) - 12) * k, int(min(ys) - 30) * k, int(max(xs) + 12) * k, int(max(ys) + 10) * k)
        crop = im.crop(box)
        crop.resize((crop.width * 4, crop.height * 4), Image.NEAREST).save(DEBUG / f"eye{i}.png")


def main():
    debug = "--debug" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    if debug:
        DEBUG.mkdir(parents=True, exist_ok=True)
    lm = json.loads((ROOT / "tools" / "landmarks.json").read_text())
    src = Image.open(ROOT / lm["source"]).convert("RGBA")
    rgba = np.asarray(src, np.float32) / 255.0
    h, w = rgba.shape[:2]
    # The background removal left a few near-white specks between the outer curls: drop them.
    rgb_, a_ = rgba[..., :3], rgba[..., 3]
    lum_ = rgb_ @ LUMA
    sat_ = rgb_.max(2) - rgb_.min(2)
    near_edge = distance_from(a_ < 0.5, 14) < 14
    yy_ = np.mgrid[0:h, 0:w][0]
    speck = near_edge & (lum_ > 0.72) & (sat_ < 0.16) & (yy_ < lm["collar_y"])
    speck = dilate(speck.astype(np.float32), 1) > 0
    rgba = rgba.copy()
    rgba[..., 3] = np.where(speck, 0, a_)
    print(f"removed {int(speck.sum())} speck pixels")
    img, alpha = rgba[..., :3], rgba[..., 3]

    print("art")
    build_art(rgba)
    print("eyes")
    eyes = [eye_data(img, alpha, e, w, h) for e in lm["eyes"]]
    print("weights")
    build_weights(lm, alpha, w, h)
    if debug:
        debug_overlay(img, alpha, lm, eyes, w, h)

    face = np.array(lm["face"], np.float32)
    # How wide her curls are at eye level, so the name can tuck in beside them.
    eye_row = int(round(np.mean([e["iris"][1] for e in eyes])))
    band = alpha[eye_row - 25:eye_row + 25].max(axis=0) > 0.5
    xs = np.nonzero(band)[0]
    meta_hair = [float(xs.min()), float(xs.max())]
    meta = {
        "hairAtEyes": meta_hair,
        "size": [w, h],
        "eyes": eyes,
        "neckPivot": lm["neck_pivot"],
        "earPivot": lm["earring"]["pivot"],
        "eyeMid": [float(np.mean([e["iris"][0] for e in eyes])), float(np.mean([e["iris"][1] for e in eyes]))],
        "head": [float(face[:, 0].min()), float(face[:, 1].min()), float(face[:, 0].max()), float(face[:, 1].max())],
    }
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    print("done")


if __name__ == "__main__":
    main()
