"""Rebuild assets/fbskin.ico, .png and .svg after foobar2000's own format icon.

Measured from foobar2000/icons/FLAC.ico: 256 canvas, body 188x256 at x 34, bottom
band 74 tall, corner fold 34, one pixel black border, mark 120x162 ten pixels
below the top, label 51 tall with 6 pixels of margin either side.

Two details matter, both taken from that file:

  * each size gets its own artwork. Scaling the 256 drawing down turns the 1px
    border into a sixth of a pixel at 16px, which reads as a grey or missing
    edge. FLAC.ico keeps the border at one pixel at every size and drops the
    transparent margin entirely at 16.
  The mark is inlined below (lifted from foobar2000's logo.svg), so this file
  builds fbskin.ico, fbskin.png and fbskin.svg on its own; it needs Microsoft
  Edge only to rasterise that mark.

  * the diagonal is not one pixel wide. FLAC.ico's is about 1.4, which is why
    its edge looks solid where a 1px 45 degree band washes out to grey.
"""
import base64
import io
import math
import os
import struct
import time

import subprocess
import tempfile
import time

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = (16, 32, 48, 256)          # the same four foobar2000 ships
BASE = 256
X0, W, BAND, FOLD = 34, 188, 74, 34
INK, BODY = (0, 0, 0), (255, 255, 255)
LABEL, FONT, CAP = "FBSKIN", r"C:\Windows\Fonts\segoeuib.ttf", 51
LABEL_PAD = 6                       # pixels of margin either side of the label at 256
DIAG_D, DIAG_DX = 1.1, -0.2         # border thickness across the diagonal
BROWSER = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# The mark, lifted verbatim out of foobar2000's own logo.svg, so this file builds
# the whole icon set without reading icon.svg or icon.png.
FOX_VIEWBOX = (0.0, 0.0, 85.741, 12.889)
FOX = """<g transform="translate(-109.74 -21.661)"><g transform="matrix(.041327 0 0 .041327 108.67 22.121)"><path transform="translate(5.7342 -45.32)" d="m231.37 130.44c-7.0078-18.035-18.005-47.838-40.321-83.722l-36.909 49.676c-6.6817-1.0272-11.377-1.4552-17.926-1.4552-6.5484 1e-6 -11.244 0.42799-17.926 1.4552l-36.909-49.676c-22.316 35.884-33.314 65.687-40.321 83.722-5.6008 14.81-12.819 47.46-5.424 75.009 10.425 36.954 53.825 90.601 100.58 122.32 46.755-31.721 90.155-85.368 100.58-122.32 7.3953-27.55 0.17684-60.199-5.424-75.009z" stroke="#000" stroke-width=".5"/><path d="m56.029 105.96c8.5741-6.5233 29.48 1.8808 47.519 25.506 8.7966 11.473 28.399 44.242 13.652 54.187-17.039 10.459-42.122-7.4842-51.435-22.542-12.993-18.713-19.874-49.434-9.7367-57.15z" fill="#fff"/><path d="m227.87 105.96c-8.5741-6.5233-29.48 1.8808-47.519 25.506-8.7966 11.473-28.399 44.242-13.652 54.187 17.039 10.459 42.122-7.4842 51.435-22.542 12.993-18.713 19.874-49.434 9.7367-57.15z" fill="#fff"/><g><path transform="scale(.26458)" d="m536.5 771.78c-13.826 0.0769-23.332 6.1131-32 15l-94.75 107.5c-6.6594 9.8183-2.1573 12.568 3.416 16.668 9.5605 5.6877 23.522 6.2977 34.25-3.668l89.168-93.832 89 93.832c10.728 9.9657 24.689 9.3556 34.25 3.668 5.5733-4.0996 10.076-6.8496 3.416-16.668l-94.75-107.5c-8.6685-8.8869-18.174-14.923-32-15z" fill="#fff"/></g></g></g>"""

_FOX_PNG = None


def geometry(size):
    """every measurement at 256 scaled to this size, with the border kept at 1px"""
    k = size / BASE
    margin = 0 if size <= 16 else round(X0 * k)      # FLAC.ico drops it at 16
    body_w = size - 2 * margin
    band = max(1, round(BAND * k))
    fold = max(1, round(FOLD * k))
    diag_w = max(1.0, 1.4 * k) if size > 32 else 1.0
    return dict(k=k, x0=margin, w=body_w, band=band, fold=fold, diag_w=diag_w)


def _fox_render(width=6000):
    """rasterise FOX once: the logo canvas is seven times wider than the mark, so
    render big enough that the mark itself still has plenty of pixels"""
    global _FOX_PNG
    if _FOX_PNG is not None:
        return _FOX_PNG
    vx, vy, vw, vh = FOX_VIEWBOX
    height = max(1, round(width * vh / vw))
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="{0} {1} {2} {3}"'
           ' width="{4}" height="{5}">{6}</svg>').format(vx, vy, vw, vh, width, height, FOX)
    work = tempfile.mkdtemp()
    sp = os.path.join(work, "fox.svg")
    with open(sp, "w", encoding="utf-8") as f:
        f.write(svg)
    hp = os.path.join(work, "fox.html")
    with open(hp, "w", encoding="utf-8") as f:
        f.write("<html><body style='margin:0;background:#fff'><img src='file:///{0}'"
                " width={1} height={2}></body></html>".format(
                    sp.replace("\\", "/"), width, height))
    out = os.path.join(work, "fox.png")
    subprocess.run([BROWSER, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--user-data-dir=" + work, "--window-size={},{}".format(width, height),
                    "--screenshot=" + out, "--virtual-time-budget=4000",
                    "file:///" + hp.replace("\\", "/")], check=False, timeout=90)
    for _ in range(30):
        if os.path.exists(out) and os.path.getsize(out) > 0:
            break
        time.sleep(0.3)
    _FOX_PNG = Image.open(out).convert("RGB")
    return _FOX_PNG


def _fox_box():
    """the mark's bounds inside FOX_VIEWBOX coordinates"""
    im = _fox_render()
    a = np.array(im).astype(int).mean(axis=2)
    ys, xs = np.where(a < 110)
    vx, vy, vw, vh = FOX_VIEWBOX
    return (vx + xs.min() * vw / im.width, vy + ys.min() * vh / im.height,
            (xs.max() - xs.min() + 1) * vw / im.width,
            (ys.max() - ys.min() + 1) * vh / im.height)


def mark_mask():
    """the mark's dark strokes, cropped to their bounds"""
    a = np.array(_fox_render()).astype(int).mean(axis=2)
    m = Image.fromarray(np.where(a < 110, 255, 0).astype("uint8"), mode="L")
    return m.crop(m.point(lambda v: 255 if v else 0).getbbox())


def label_image(cap, width):
    if cap < 3 or width < 6:
        return None
    probe = ImageDraw.Draw(Image.new("L", (10, 10)))
    size = max(6, cap)
    while size < 400:
        f = ImageFont.truetype(FONT, size)
        b = probe.textbbox((0, 0), LABEL, font=f)
        if b[3] - b[1] >= cap:
            break
        size += 1
    b = probe.textbbox((0, 0), LABEL, font=f)
    t = Image.new("RGBA", (b[2] - b[0], b[3] - b[1]), (0, 0, 0, 0))
    ImageDraw.Draw(t).text((-b[0], -b[1]), LABEL, font=f, fill=(255, 255, 255, 255))
    return t.resize((width, cap), Image.LANCZOS)


def build(size):
    g = geometry(size)
    x0, w, band, fold = g["x0"], g["w"], g["band"], g["fold"]
    right, bottom = x0 + w, size
    band_top = bottom - band
    ss = max(8, min(64, 2048 // size))
    d, dx = DIAG_D, DIAG_DX

    # The border is the thickness between two polygons, not a stroke: a stroke
    # centred on the edge spreads its ink over both sides and reads heavier than
    # the original. The outer polygon is filled without antialiasing (45 degrees
    # still lands on whole pixels), the inner one is supersampled so its edge
    # softens the way a vector renderer softens it.
    ox = right - fold + dx
    n = (-1 / math.sqrt(2), 1 / math.sqrt(2))
    ax, ay = ox + n[0] * d, 0 + n[1] * d
    bx, by = right + dx + n[0] * d, fold + n[1] * d
    y_t, x_l, x_r, y_b = 1.0, x0 + 1, right - 1, bottom - 1
    t = (y_t - ay) / (by - ay)
    x_top = ax + t * (bx - ax)
    t = (x_r - ax) / (bx - ax)
    y_right = ay + t * (by - ay)
    outer = [(x0, 0), (ox, 0), (right + dx, fold), (right, bottom), (x0, bottom)]
    inner = [(x_l, y_t), (x_top, y_t), (x_r, y_right), (x_r, y_b), (x_l, y_b)]

    o = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(o).polygon([(x * ss, y * ss) for x, y in outer], fill=255)
    o = o.reduce(ss)
    i = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(i).polygon([(x * ss, y * ss) for x, y in inner], fill=255)
    i = i.reduce(ss)
    # the inner polygon leaks one subpixel row into the last row and column of
    # its straight sides; clip it so the border stays exactly one pixel there
    inner_box = Image.new("L", (size, size), 0)
    ImageDraw.Draw(inner_box).rectangle((x0 + 1, 1, right - 2, bottom - 2), fill=255)
    i = ImageChops.multiply(i, inner_box)

    body_box = Image.new("L", (size, size), 0)
    ImageDraw.Draw(body_box).rectangle((x0, 0, right - 1, size - 1), fill=255)
    outer = ImageChops.multiply(o, body_box)
    inner = ImageChops.multiply(i, body_box)
    ring = ImageChops.subtract(outer, inner)

    # alpha is the silhouette's coverage; the colour is the border over the page.
    # That is what makes the original's outer edge soft in alpha while its colour
    # stays black, instead of the flat one-pixel edge a hard mask produces.
    O = np.asarray(outer, dtype=float) / 255.0
    Rr = np.asarray(ring, dtype=float) / 255.0
    with np.errstate(divide="ignore", invalid="ignore"):
        dark = np.where(O > 1e-6, Rr / np.maximum(O, 1e-6), 0.0)
    dark = np.clip(dark, 0.0, 1.0)
    value = (255.0 * (1.0 - dark)).astype("uint8")
    alpha = (255.0 * O).astype("uint8")
    im = Image.fromarray(np.dstack([value, value, value, alpha]))

    d_ = ImageDraw.Draw(im)
    # the fold, drawn at full size: two straight lines meeting the border
    d_.line([(right - fold - 1, 0), (right - fold - 1, fold)], fill=INK, width=1)
    d_.line([(right - fold - 1, fold), (right - 1, fold)], fill=INK, width=1)
    # the band the name sits in
    d_.rectangle((x0 + 1, band_top, right - 2, bottom - 2), fill=INK)

    mw = max(1, round(120 * w / W))
    mh = max(1, round(162 * w / W))
    m = mark_mask().resize((mw, mh), Image.LANCZOS)
    tint = Image.new("RGBA", m.size, INK + (255,))
    tint.putalpha(m)
    im.alpha_composite(tint, (x0 + (w - mw) // 2, max(1, round(10 * w / W))))

    cap = min(max(1, round(CAP * w / W)), band - 2)
    pad = max(1, round(LABEL_PAD * w / W))
    lbl = label_image(cap, max(1, w - 2 * pad))
    if lbl is not None and lbl.width <= w - 2:
        ty = band_top + max(1, (band - cap) // 2)
        ty = min(ty, size - 1 - cap)
        im.alpha_composite(lbl, (x0 + (w - lbl.width) // 2, ty))
    return im


def svg_text():
    ox = X0 + W - FOLD + DIAG_DX
    outer = "M{} 0 H{:.2f} L{:.2f} {} V{} H{} Z".format(
        X0, ox, X0 + W + DIAG_DX, FOLD, BASE, X0)
    t = DIAG_D
    nx, ny = -1 / math.sqrt(2), 1 / math.sqrt(2)
    ax, ay = ox + nx * t, ny * t
    bx, by = X0 + W + DIAG_DX + nx * t, FOLD + ny * t
    s = (t - ay) / (by - ay)
    x_top = ax + s * (bx - ax)
    s = ((X0 + W - t) - ax) / (bx - ax)
    y_right = ay + s * (by - ay)
    inner = "M{} 1 H{:.2f} L{} {:.2f} V{} H{} Z".format(
        X0 + 1, x_top, X0 + W - 1, y_right, BASE - 1, X0 + 1)

    bx, by, bw, bh = _fox_box()
    raw = ('<svg x="{}" y="10" width="120" height="162"'
           ' viewBox="{:.3f} {:.3f} {:.3f} {:.3f}" preserveAspectRatio="none">'
           '{}</svg>').format(X0 + (W - 120) // 2, bx, by, bw, bh, FOX)
    lines = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {0} {0}" width="{0}" height="{0}">'.format(BASE),
        '  <title>foobar2000 mobile skin</title>',
        '  <path d="{}" fill="#ffffff"/>'.format(outer),
        '  <path d="{} {}" fill="#000000" fill-rule="evenodd"/>'.format(outer, inner),
        '  <rect x="{}" y="{}" width="{}" height="{}" fill="#000000"/>'.format(
            X0 + 1, BASE - BAND, W - 2, BAND - 1),
        '  <path d="M{} 0 V{} H{}" fill="none" stroke="#000000" stroke-width="1"/>'.format(
            X0 + W - FOLD - 1, FOLD, X0 + W - 1),
        '  ' + raw,
        '  <text x="{}" y="{}" text-anchor="middle" font-family="Segoe UI" font-weight="700"'
        ' font-size="70" textLength="{}" lengthAdjust="spacingAndGlyphs" fill="#ffffff">{}</text>'.format(
            BASE // 2, BASE - BAND + 12 + CAP, W - 2 * LABEL_PAD, LABEL),
        '</svg>',
    ]
    return "\n".join(lines) + "\n"


def write_ico(images, path):
    """an .ico holding each size's own artwork, as PNG payloads"""
    entries, payloads, offset = [], [], 6 + 16 * len(images)
    for im in images:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        data = buf.getvalue()
        entries.append(struct.pack("<BBBBHHII", im.width % 256, im.height % 256,
                                   0, 0, 1, 32, len(data), offset))
        payloads.append(data)
        offset += len(data)
    with open(path, "wb") as f:
        f.write(struct.pack("<HHH", 0, 1, len(images)))
        for e in entries:
            f.write(e)
        for p in payloads:
            f.write(p)


def write_atomically(path, writer, tries=5):
    tmp = path + ".tmp"
    for i in range(tries):
        try:
            writer(tmp)
            os.replace(tmp, path)
            return
        except OSError:
            if i == tries - 1:
                raise
            time.sleep(0.3)


if __name__ == "__main__":
    images = [build(s) for s in SIZES]
    write_atomically(os.path.join(HERE, "fbskin.ico"), lambda tmp: write_ico(images, tmp))
    write_atomically(os.path.join(HERE, "fbskin.png"),
                     lambda tmp: images[-1].save(tmp, format="PNG"))

    def write_svg(tmp):
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(svg_text())

    write_atomically(os.path.join(HERE, "fbskin.svg"), write_svg)
    print("wrote assets/fbskin.ico, .png and .svg")
