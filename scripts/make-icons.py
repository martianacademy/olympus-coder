"""Generates the app icon (build/icon.png) and the macOS installer background (build/background*.png).

Run with:  python3 scripts/make-icons.py      (needs Pillow)

Everything is drawn at 2x and scaled down, so edges stay smooth.
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent.parent / "build"
OUT.mkdir(exist_ok=True)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def vertical_gradient(size, stops):
    """stops: list of (position 0..1, rgb)."""
    w, h = size
    img = Image.new("RGB", size)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / (h - 1)
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]
            p1, c1 = stops[i + 1]
            if p0 <= t <= p1:
                d.line([(0, y), (w, y)], fill=lerp(c0, c1, (t - p0) / max(1e-6, p1 - p0)))
                break
    return img


def squircle_mask(size, inset, power=5.0):
    """macOS-style continuous-corner square (superellipse)."""
    w, _ = size
    a = (w - 2 * inset) / 2
    cx = cy = w / 2
    pts = []
    for i in range(720):
        th = 2 * math.pi * i / 720
        c, s = math.cos(th), math.sin(th)
        x = cx + a * math.copysign(abs(c) ** (2 / power), c)
        y = cy + a * math.copysign(abs(s) ** (2 / power), s)
        pts.append((x, y))
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m


# Brand: Olympus Mons erupting code. An orange shield volcano; a cream ball in its caldera is the eruption; a
# curly brace lying on its side above is the cloud. Solid near-black background, full-bleed, no padding.
NIGHT = (24, 17, 16)
ORANGE = (238, 106, 62)
CREAM = (255, 247, 240)


def bezier(p0, p1, p2, p3, n=80):
    out = []
    for i in range(n + 1):
        t = i / n
        out.append(tuple(((1 - t) ** 3) * p0[k] + 3 * ((1 - t) ** 2) * t * p1[k] + 3 * (1 - t) * t * t * p2[k] + t ** 3 * p3[k] for k in (0, 1)))
    return out


def round_stroke(d, pts, w, fill):
    """Round-capped stroke stamped as dabs (Pillow's wide polyline leaves specks on curves)."""
    r = w / 2
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / (w / 10)))
        for i in range(n + 1):
            x, y = x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n
            d.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def volcano_mask(S, by, ty, bl, tl, nw, ball_y):
    """Volcano with a U-shaped caldera whose round bottom is centred on the ball, so the gap around it is even."""
    cx = S / 2
    flank = bezier((bl, by), (bl + (tl - bl) * 0.40, by - (by - ty) * 0.10), (tl - (tl - bl) * 0.10, ty + (by - ty) * 0.22), (tl, ty))
    # Left wall straight down to the ball's centre line, then a half circle (radius nw) around the ball.
    arc = [(cx - nw * math.cos(math.pi * i / 90), ball_y + nw * math.sin(math.pi * i / 90)) for i in range(0, 46)]
    left = flank + [(cx - nw, ty), (cx - nw, ball_y)] + arc
    pts = left + [(2 * cx - x, y) for x, y in reversed(left)][1:]
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    m = m.filter(ImageFilter.GaussianBlur(S * 0.009)).point(lambda v: 255 if v > 128 else 0)  # soften corners
    ImageDraw.Draw(m).rectangle([0, by, S, S], fill=0)  # keep the base straight
    return m


def side_brace(cx, cy, span, depth):
    """A curly brace lying on its side: point up in the middle, ends curling down."""
    h, top = span, -span / 2
    xo, xp = depth / 2, -depth / 2
    upper = (
        bezier((xo, top), (0, top), (0, top), (0, top + h * 0.16))
        + bezier((0, top + h * 0.16), (0, top + h * 0.16), (0, -h * 0.16), (0, -h * 0.16))[1:]
        + bezier((0, -h * 0.16), (0, -h * 0.03), (xp, 0), (xp, 0))[1:]
    )
    pts = upper + [(x, -y) for x, y in reversed(upper)][1:]
    return [(cx + y, cy + x) for x, y in pts]  # swap axes so the point faces up


def make_icon(px=1024):
    """Full-bleed square: macOS (and the installers) round the corners themselves, so no padding, no own tile."""
    S = px * 2
    img = Image.new("RGB", (S, S), NIGHT)
    by, ty = S * 0.83, S * 0.385  # base and summit: tall enough to read as a volcano
    r, gap = S * 0.058, S * 0.024  # the eruption ball and the even gap around it in the caldera
    ball_y = ty + S * 0.012
    img.paste(ORANGE, (0, 0), volcano_mask(S, by, ty, S * 0.07, S * 0.355, r + gap, ball_y))
    d = ImageDraw.Draw(img)
    round_stroke(d, side_brace(S / 2, S * 0.215, S * 0.50, S * 0.11), S * 0.052, CREAM)
    d.ellipse([S / 2 - r, ball_y - r, S / 2 + r, ball_y + r], fill=CREAM)
    return img.resize((px, px), Image.LANCZOS)


def make_dock_icon(px=1024):
    """For the dev build's runtime Dock icon (not masked by macOS): the rounded tile on Apple's 1024 grid (824 body)."""
    body = int(px * 824 / 1024)
    tile = make_icon(body * 2).resize((body, body), Image.LANCZOS).convert("RGBA")
    mask = squircle_mask((body * 4, body * 4), 0).resize((body, body), Image.LANCZOS)
    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(tile, ((px - body) // 2, (px - body) // 2), mask)
    return out


def font(size, bold=False):
    for name in (["SFNS.ttf", "SF-Pro-Display-Semibold.otf"] if bold else ["SFNS.ttf"]) + ["Helvetica.ttc", "Arial.ttf", "DejaVuSans.ttf"]:
        for base in ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", "/usr/share/fonts/truetype/dejavu"]:
            p = Path(base) / name
            if p.exists():
                try:
                    return ImageFont.truetype(str(p), size)
                except OSError:
                    pass
    return ImageFont.load_default()


def make_dmg_background(scale):
    """660x400 window: app on the left, Applications on the right, an arrow between."""
    W, H = 660 * scale, 400 * scale
    bg = vertical_gradient((W, H), [(0, (24, 18, 40)), (0.7, (46, 22, 44)), (1, (92, 34, 30))]).convert("RGBA")
    d = ImageDraw.Draw(bg)
    rnd = random.Random(3)
    for _ in range(90):
        x, y = rnd.uniform(0, W), rnd.uniform(0, H * 0.6)
        r = rnd.choice([0.6, 0.9, 1.2]) * scale
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 240, 230, rnd.randint(60, 170)))
    # Soft horizon glow
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([W * 0.1, H * 0.78, W * 0.9, H * 1.4], fill=(255, 110, 60, 90))
    bg.alpha_composite(glow.filter(ImageFilter.GaussianBlur(40 * scale)))
    d = ImageDraw.Draw(bg)
    # Title
    t = "Olympus Coder"
    f = font(26 * scale, bold=True)
    tw = d.textlength(t, font=f)
    d.text(((W - tw) / 2, 38 * scale), t, font=f, fill=(255, 244, 236, 255))
    s = "Drag the app into Applications to install"
    f2 = font(13 * scale)
    sw = d.textlength(s, font=f2)
    d.text(((W - sw) / 2, 76 * scale), s, font=f2, fill=(220, 200, 210, 220))
    # Arrow between the two icon slots (icons sit at x=180 and x=480, y=215)
    y = 215 * scale
    x0, x1 = 262 * scale, 398 * scale
    for i in range(0, int(x1 - x0) - 18 * scale, 14 * scale):
        d.rounded_rectangle([x0 + i, y - 2 * scale, x0 + i + 8 * scale, y + 2 * scale], radius=2 * scale, fill=(255, 170, 120, 200))
    d.polygon([(x1, y), (x1 - 16 * scale, y - 10 * scale), (x1 - 16 * scale, y + 10 * scale)], fill=(255, 170, 120, 230))
    return bg.convert("RGB")


if __name__ == "__main__":
    icon = make_icon(1024)
    icon.save(OUT / "icon.png")
    icon.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png")
    make_dock_icon(1024).save(OUT / "icon-dock.png")
    make_dmg_background(1).save(OUT / "background.png")
    make_dmg_background(2).save(OUT / "background@2x.png")
    print("wrote", ", ".join(p.name for p in sorted(OUT.glob("*.png"))))
    # macOS: combine 1x + 2x into one Retina-aware TIFF for the DMG window.
    import shutil, subprocess
    if shutil.which("tiffutil"):
        subprocess.run(["tiffutil", "-cathidpicheck", str(OUT / "background.png"), str(OUT / "background@2x.png"), "-out", str(OUT / "background.tiff")], check=True)
