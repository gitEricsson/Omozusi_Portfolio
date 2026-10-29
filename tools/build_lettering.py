"""Turn words into pen-written lettering for js/ink.js.

    python tools/build_lettering.py           # writes assets/lettering/*.json
    python tools/build_lettering.py --debug   # also writes tools/debug/lettering-*.png

For every letter it stores the real outline (to fill) and pen strokes through the
middle of the letter, in writing order, with the stroke's half-width at each point.
js/ink.js sweeps a pen along those strokes to reveal the outlines as if being written.

How the pen strokes are found:
  1. rasterise each letter large, thin it to a one-pixel skeleton (Zhang-Suen);
  2. split the skeleton into a graph of edges between ends and junctions;
  3. trim the short spurs that serifs leave on the skeleton;
  4. walk the graph like a hand would: start top-left, keep going as straight
     as possible through junctions, lift the pen only when there's nowhere to go;
     closed loops (like "o") start at the top and go anticlockwise; small separate
     marks (the dot of an "i") come last.
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "lettering"
DEBUG = ROOT / "tools" / "debug"
REF = 400          # font size (px) all geometry is generated at
PAD = 40
STEP = 2.5         # px between stored pen points
MIN_STROKE = 0.19  # strokes shorter than this (× font size) are serif ticks, not written

JOBS = [
    {"id": "name", "font": "tools/fonts/Gloock-Regular.ttf", "lines": ["Omozusi", "Eguare"]},
    {"id": "signature", "font": "tools/fonts/MrsSaintDelafield-Regular.ttf", "lines": ["Omozusi Eguare"]},
]

N8 = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]  # (dy, dx), clockwise from north


# ---------- raster helpers ----------

def thin(img):
    """Zhang-Suen thinning to a one-pixel, 8-connected skeleton."""
    img = img.copy()
    while True:
        changed = False
        for step in (0, 1):
            P = np.pad(img, 1)
            p2, p3, p4 = P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:]
            p5, p6, p7 = P[2:, 2:], P[2:, 1:-1], P[2:, :-2]
            p8, p9 = P[1:-1, :-2], P[:-2, :-2]
            nb = [p2, p3, p4, p5, p6, p7, p8, p9]
            B = sum(n.astype(np.int8) for n in nb)
            seq = nb + [p2]
            A = sum(((~seq[i]) & seq[i + 1]).astype(np.int8) for i in range(8))
            if step == 0:
                c = ~(p2 & p4 & p6) & ~(p4 & p6 & p8)
            else:
                c = ~(p2 & p4 & p8) & ~(p2 & p6 & p8)
            m = img & (B >= 2) & (B <= 6) & (A == 1) & c
            if m.any():
                img[m] = False
                changed = True
        if not changed:
            return img


def distance_inside(mask):
    """Approximate Euclidean distance (px) from each inside pixel to the outside."""
    INF = 1e9
    d = np.where(mask, INF, 0.0)
    h, w = d.shape
    # Two-pass chamfer (3-4 weights), good to a few percent.
    for y in range(h):
        row = d[y]
        if y > 0:
            up = d[y - 1]
            row = np.minimum(row, up + 1.0)
            row[1:] = np.minimum(row[1:], up[:-1] + 1.4142)
            row[:-1] = np.minimum(row[:-1], up[1:] + 1.4142)
        for x in range(1, w):
            if row[x] > row[x - 1] + 1.0:
                row[x] = row[x - 1] + 1.0
        d[y] = row
    for y in range(h - 1, -1, -1):
        row = d[y]
        if y < h - 1:
            dn = d[y + 1]
            row = np.minimum(row, dn + 1.0)
            row[1:] = np.minimum(row[1:], dn[:-1] + 1.4142)
            row[:-1] = np.minimum(row[:-1], dn[1:] + 1.4142)
        for x in range(w - 2, -1, -1):
            if row[x] > row[x + 1] + 1.0:
                row[x] = row[x + 1] + 1.0
        d[y] = row
    return d


def components(mask):
    """8-connected components, largest first: [(pixels as set of (y, x))]."""
    seen = np.zeros_like(mask, bool)
    comps = []
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        stack, comp = [(y, x)], set()
        seen[y, x] = True
        while stack:
            cy, cx = stack.pop()
            comp.add((cy, cx))
            for dy, dx in N8:
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        comps.append(comp)
    return sorted(comps, key=len, reverse=True)


# ---------- skeleton graph ----------

def neighbours(p, pix):
    return [(p[0] + dy, p[1] + dx) for dy, dx in N8 if (p[0] + dy, p[1] + dx) in pix]


def unstair(pix):
    """Drop corner pixels that only make diagonal 'staircases': without this every
    step of a curve looks like a junction and the pen would lift at each one."""
    pix = set(pix)
    for p in sorted(pix):
        y, x = p
        n, e, s, w = (y - 1, x) in pix, (y, x + 1) in pix, (y + 1, x) in pix, (y, x - 1) in pix
        if not ((n and e) or (e and s) or (s and w) or (w and n)):
            continue
        nb = neighbours(p, pix)
        if len(nb) < 2:
            continue
        # Removable only if its neighbours stay connected to each other without it.
        seen, stack = {nb[0]}, [nb[0]]
        while stack:
            q = stack.pop()
            for r in nb:
                if r not in seen and max(abs(r[0] - q[0]), abs(r[1] - q[1])) == 1:
                    seen.add(r)
                    stack.append(r)
        if len(seen) == len(nb):
            pix.discard(p)
    return pix


def edges_of(pix):
    """Split a skeleton into edges between nodes: free ends, and junctions (touching
    junction pixels merged into one node, represented by a single pixel)."""
    pix = unstair(pix)
    deg = {p: len(neighbours(p, pix)) for p in pix}
    junction = {p for p, d in deg.items() if d >= 3}
    node_of = {}
    for p in junction:                      # cluster touching junction pixels
        if p in node_of:
            continue
        stack, cluster = [p], []
        node_of[p] = p
        while stack:
            q = stack.pop()
            cluster.append(q)
            for r in neighbours(q, pix):
                if r in junction and r not in node_of:
                    node_of[r] = p
                    stack.append(r)
        rep = min(cluster, key=lambda q: (q[0] - sum(c[0] for c in cluster) / len(cluster)) ** 2
                  + (q[1] - sum(c[1] for c in cluster) / len(cluster)) ** 2)
        for q in cluster:
            node_of[q] = rep
    for p, d in deg.items():
        if d <= 1:
            node_of[p] = p
    if not node_of:  # a closed loop: open it at the top, so the pen starts there
        top = min(pix, key=lambda p: (p[0], p[1]))
        node_of[top] = top

    visited = set()
    edges = []
    for p in list(node_of):
        for nb in neighbours(p, pix):
            if nb in node_of and node_of[nb] == node_of[p]:
                continue                     # inside the same junction
            if (p, nb) in visited:
                continue
            path = [node_of[p], nb] if nb not in node_of else [node_of[p], node_of[nb]]
            visited.add((p, nb))
            visited.add((nb, p))
            prev, cur = p, nb
            while cur not in node_of:
                nxt = [q for q in neighbours(cur, pix) if q != prev and (cur, q) not in visited]
                if not nxt:
                    break
                nxt.sort(key=lambda q: abs(q[0] - cur[0]) + abs(q[1] - cur[1]))
                q = nxt[0]
                visited.add((cur, q))
                visited.add((q, cur))
                path.append(node_of.get(q, q))
                prev, cur = cur, q
            if len(path) >= 2 and not (len(path) == 2 and path[0] == path[1]):
                edges.append(path)
    return edges


def prune(edges, min_len):
    """Drop short spurs (one end free) left on the skeleton by serifs and corners."""
    for _ in range(2):
        ends = {}
        for e in edges:
            for p in (e[0], e[-1]):
                ends[p] = ends.get(p, 0) + 1
        keep = []
        for e in edges:
            free = ends[e[0]] == 1 or ends[e[-1]] == 1
            if free and len(e) < min_len and len(edges) > 1:
                continue
            keep.append(e)
        if len(keep) == len(edges):
            break
        edges = keep
    return edges


def direction(path, at_start, n=6):
    a = path[0] if at_start else path[-1]
    b = path[min(n, len(path) - 1)] if at_start else path[max(-n - 1, -len(path))]
    v = (b[1] - a[1], b[0] - a[0]) if at_start else (a[1] - b[1], a[0] - b[0])
    m = math.hypot(*v) or 1.0
    return (v[0] / m, v[1] / m)


def walk(edges):
    """Order edges into pen strokes the way a hand would write them."""
    remaining = list(range(len(edges)))
    strokes = []
    pen = None
    while remaining:
        # Where to put the pen down: a free end if possible, top-left first,
        # near where the pen just lifted.
        ends = {}
        for i in remaining:
            for p in (edges[i][0], edges[i][-1]):
                ends.setdefault(p, []).append(i)
        def score(p):
            free = len(ends[p]) == 1
            s = p[0] + 0.35 * p[1] - (40 if free else 0)
            if pen is not None:
                s += 0.4 * math.hypot(p[0] - pen[0], p[1] - pen[1])
            return s
        start = min(ends, key=score)
        stroke = []
        cur, heading = start, None
        while True:
            cand = [i for i in remaining if edges[i][0] == cur or edges[i][-1] == cur]
            if not cand:
                break
            def turn(i):
                e = edges[i] if edges[i][0] == cur else edges[i][::-1]
                d = direction(e, True)
                if heading is None:
                    # first move: down or left is how pens usually begin
                    return -(d[1] * 0.6 - d[0] * 0.4)
                return -(d[0] * heading[0] + d[1] * heading[1])
            i = min(cand, key=turn)
            e = edges[i] if edges[i][0] == cur else edges[i][::-1]
            # closed loop opened at its top: go anticlockwise (leftwards) first
            if e[0] == e[-1] and len(e) > 3 and e[1][1] > e[0][1]:
                e = e[::-1]
            remaining.remove(i)
            stroke.extend(e if not stroke else e[1:])
            heading = direction(e, False)
            cur = e[-1]
        strokes.append(stroke)
        pen = cur
    return strokes


def resample(path, dist, ox, oy):
    """Even spacing along the stroke, lightly smoothed, with the half-width at each point."""
    pts = np.array([(p[1], p[0]) for p in path], float)
    if len(pts) == 1:
        y, x = path[0]
        return [[round(float(x - ox), 1), round(float(y - oy), 1), round(float(dist[y, x]) * 1.3 + 2.5, 1)]]
    k = 5
    if len(pts) > k:
        pad = np.pad(pts, ((k // 2, k // 2), (0, 0)), mode="edge")
        pts = np.stack([np.convolve(pad[:, j], np.ones(k) / k, mode="valid") for j in (0, 1)], 1)
    seg = np.hypot(*np.diff(pts, axis=0).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(2, int(s[-1] / STEP) + 1)
    t = np.linspace(0, s[-1], n)
    xs, ys = np.interp(t, s, pts[:, 0]), np.interp(t, s, pts[:, 1])
    out = []
    for x, y in zip(xs, ys):
        yi = int(min(max(round(y), 0), dist.shape[0] - 1))
        xi = int(min(max(round(x), 0), dist.shape[1] - 1))
        # Cover the full stroke width (and a little more) so the reveal never leaves gaps.
        r = float(dist[yi, xi]) * 1.3 + 2.5
        out.append([round(float(x - ox), 1), round(float(y - oy), 1), round(r, 1)])
    return out


# ---------- per letter ----------

def glyph_strokes(pil_font, ch):
    """Pen strokes for one character, in glyph coordinates (origin on the baseline)."""
    l, t, r, b = pil_font.getbbox(ch, anchor="ls")
    w, h = int(r - l) + 2 * PAD, int(b - t) + 2 * PAD
    ox, oy = PAD - l, PAD - t
    im = Image.new("L", (w, h), 0)
    ImageDraw.Draw(im).text((ox, oy), ch, font=pil_font, fill=255, anchor="ls")
    mask = np.asarray(im) > 127
    if not mask.any():
        return [], None
    dist = distance_inside(mask)
    strokes = []
    marks = []
    for comp in components(thin(mask)):
        edges = edges_of(comp)
        size = sum(len(e) for e in edges)
        if size < 0.05 * REF:          # a dot or a fleck: one short stroke
            pts = sorted(comp, key=lambda p: (p[0], p[1]))
            marks.append(pts)
            continue
        edges = prune(edges, min_len=max(14, 0.08 * REF))
        walked = walk(edges)
        # Leftover serif ticks (a foot serif, the flag at the top of a stem) would make the pen
        # dab backwards at the end of a letter. Leave them out: the letter's full outline fills
        # them in as the pen moves on. Keep at least the longest stroke of every component.
        longest = max(walked, key=len)
        strokes.extend(s for s in walked if s is longest or len(s) >= MIN_STROKE * REF)
    strokes.extend(marks)              # dots and flecks after the letter itself
    return [resample(s, dist, ox, oy) for s in strokes if s], (mask, ox, oy)


def outline(glyph_set, gname, scale, x):
    pen = SVGPathPen(glyph_set, ntos=lambda v: f"{v:.1f}".rstrip("0").rstrip("."))
    glyph_set[gname].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))
    return pen.getCommands()


def build(job, debug):
    font_path = ROOT / job["font"]
    tt = TTFont(font_path)
    upm = tt["head"].unitsPerEm
    scale = REF / upm
    cmap = tt.getBestCmap()
    hmtx = tt["hmtx"]
    glyph_set = tt.getGlyphSet()
    pil_font = ImageFont.truetype(str(font_path), REF)
    os2 = tt["OS/2"]

    lines = []
    for text in job["lines"]:
        x = 0.0
        glyphs, strokes = [], []
        top, bottom, left, right = 0.0, 0.0, 1e9, -1e9
        for ch in text:
            gname = cmap[ord(ch)]
            adv = hmtx[gname][0] * scale
            if ch.strip():
                gi = len(glyphs)
                glyphs.append({"ch": ch, "x": round(x, 1), "d": outline(glyph_set, gname, scale, x)})
                st, ras = glyph_strokes(pil_font, ch)
                for s in st:
                    strokes.append({"g": gi, "p": [[round(px + x, 1), py, pr] for px, py, pr in s]})
                l, t, r, b = pil_font.getbbox(ch, anchor="ls")
                top, bottom = min(top, t), max(bottom, b)
                left, right = min(left, x + l), max(right, x + r)
            x += adv
        # Ink extents can run past the advance (script swashes), so store them too.
        lines.append({"text": text, "advance": round(x, 1), "top": round(top, 1), "bottom": round(bottom, 1),
                      "left": round(left, 1), "right": round(right, 1),
                      "glyphs": glyphs, "strokes": strokes})
        if debug:
            debug_line(job["id"], len(lines) - 1, pil_font, text, lines[-1])

    data = {"ref": REF, "ascent": round(os2.sTypoAscender * scale, 1), "descent": round(-os2.sTypoDescender * scale, 1),
            "lines": lines}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{job['id']}.json").write_text(json.dumps(data, separators=(",", ":")))
    n = sum(len(l["strokes"]) for l in lines)
    pts = sum(len(s["p"]) for l in lines for s in l["strokes"])
    print(f"{job['id']}: {n} strokes, {pts} points, {(OUT / (job['id'] + '.json')).stat().st_size // 1024} KB")


def debug_line(job_id, li, pil_font, text, line):
    """The letters in grey, each stroke in a colour running red -> blue in writing order, start dots in white."""
    DEBUG.mkdir(parents=True, exist_ok=True)
    w = int(line["advance"]) + 2 * PAD
    top, bottom = line["top"], line["bottom"]
    h = int(bottom - top) + 2 * PAD
    oy = PAD - top
    im = Image.new("RGB", (w, h), (20, 16, 12))
    d = ImageDraw.Draw(im)
    d.text((PAD, oy), text, font=pil_font, fill=(70, 62, 54), anchor="ls")
    n = max(1, len(line["strokes"]) - 1)
    for i, s in enumerate(line["strokes"]):
        k = i / n
        col = (int(255 * (1 - k)), 80, int(255 * k))
        pts = [(PAD + x, oy + y) for x, y, _ in s["p"]]
        if len(pts) > 1:
            d.line(pts, fill=col, width=4)
        x0, y0 = pts[0]
        d.ellipse([x0 - 6, y0 - 6, x0 + 6, y0 + 6], fill=(255, 255, 255))
        d.text((x0 + 7, y0 - 18), str(i), fill=(255, 255, 255))
    im.save(DEBUG / f"lettering-{job_id}-{li}.png")


def main():
    debug = "--debug" in sys.argv
    for job in JOBS:
        build(job, debug)


if __name__ == "__main__":
    main()
