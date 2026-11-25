"""Rebuild assets/icon.ico and icon.png from icon.svg.

Every size is rendered by the browser at its own resolution instead of scaling
the 512 render down, which is what made small sizes look soft and, because the
circle is inscribed in the canvas, slightly flattened at the edges.
"""
import os
import struct
import subprocess
import tempfile
import time

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SIZES = (16, 24, 32, 48, 64, 128, 256)
SVG = os.path.join(HERE, "icon.svg")


def render(size, out_png):
    html = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8")
    html.write("<html><body style='margin:0;background:transparent'>"
               "<img src='file:///{}' width={} height={}></body></html>".format(
                   SVG.replace("\\", "/"), size, size))
    html.close()
    profile = tempfile.mkdtemp()
    subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--default-background-color=00000000", "--user-data-dir=" + profile,
                    "--window-size={0},{0}".format(size), "--screenshot=" + out_png,
                    "--virtual-time-budget=3000", "file:///" + html.name.replace("\\", "/")],
                   check=False, timeout=60)
    os.unlink(html.name)
    for _ in range(20):
        if os.path.exists(out_png) and os.path.getsize(out_png) > 0:
            return
        time.sleep(0.2)
    raise SystemExit("browser did not write " + out_png)


def write_ico(images, path):
    entries, payloads, offset = [], [], 6 + 16 * len(images)
    for im in images:
        buf = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        im.save(buf.name, format="PNG")
        buf.close()
        data = open(buf.name, "rb").read()
        os.unlink(buf.name)
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


if __name__ == "__main__":
    work = tempfile.mkdtemp()
    images = []
    for s in SIZES:
        out = os.path.join(work, "icon-{}.png".format(s))
        render(s, out)
        im = Image.open(out).convert("RGBA")
        if im.size != (s, s):
            im = im.crop((0, 0, s, s))
        images.append(im)
    write_ico(images, os.path.join(HERE, "icon.ico"))
    render(512, os.path.join(work, "icon-512.png"))
    Image.open(os.path.join(work, "icon-512.png")).convert("RGBA").save(
        os.path.join(HERE, "icon.png"))
    print("wrote assets/icon.ico ({} sizes) and icon.png".format(len(SIZES)))
