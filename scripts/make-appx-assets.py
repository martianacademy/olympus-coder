"""Generates the Microsoft Store (MSIX/AppX) tile and logo images in build/appx/ from build/icon.png.

Run with:  python3 scripts/make-appx-assets.py      (needs Pillow, like scripts/make-icons.py)

electron-builder copies every file in build/appx/ into the package's assets\\ folder and, because the names carry
`.scale-NNN` / `.targetsize-NN` qualifiers, builds resources.pri so Windows picks the right size for the screen.
Tiles use the icon's own dark background (the same colour as `build.appx.backgroundColor` in package.json).
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "build" / "icon.png"
OUT = ROOT / "build" / "appx"
OUT.mkdir(parents=True, exist_ok=True)

icon = Image.open(SRC).convert("RGBA")
BG = icon.getpixel((5, 5))[:3]  # the icon is a full-bleed dark square: its corner is the tile colour


def glyph_box(img, bg, threshold=24):
    """Bounding box of everything that is not the background colour."""
    px = img.load()
    w, h = img.size
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if max(abs(p[i] - bg[i]) for i in range(3)) > threshold:
                xs.append(x)
                ys.append(y)
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


box = glyph_box(icon, BG)
glyph = icon.crop(box)


def plated(width, height, fill):
    """The glyph centred on the background colour; `fill` = the glyph's share of the tile's shorter side."""
    canvas = Image.new("RGBA", (width, height), BG + (255,))
    side = min(width, height) * fill
    gw, gh = glyph.size
    scale = side / max(gw, gh)
    g = glyph.resize((max(1, round(gw * scale)), max(1, round(gh * scale))), Image.LANCZOS)
    canvas.paste(g, ((width - g.width) // 2, (height - g.height) // 2), g)
    return canvas


def rounded_icon(size, radius_share=0.18):
    """The whole icon as a rounded square on transparency (taskbar / Start list icons without a plate)."""
    big = size * 4
    img = icon.resize((big, big), Image.LANCZOS)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * radius_share), fill=255)
    img.putalpha(mask)
    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    img.save(OUT / name, optimize=True)
    print(f"{name:52} {img.width}x{img.height}")


for old in OUT.glob("*.png"):
    old.unlink()

SCALES = (100, 200, 400)
for s in SCALES:
    k = s / 100
    # Store listing / package logo: 50x50 at 100%.
    save(plated(round(50 * k), round(50 * k), 0.78), f"StoreLogo.scale-{s}.png")
    # App list / taskbar icon on the plate: 44x44 at 100%.
    save(plated(round(44 * k), round(44 * k), 0.80), f"Square44x44Logo.scale-{s}.png")
    # Start tiles: small 71, medium 150, wide 310x150, large 310.
    save(plated(round(71 * k), round(71 * k), 0.62), f"SmallTile.scale-{s}.png")
    save(plated(round(150 * k), round(150 * k), 0.56), f"Square150x150Logo.scale-{s}.png")
    save(plated(round(310 * k), round(150 * k), 0.62), f"Wide310x150Logo.scale-{s}.png")
    save(plated(round(310 * k), round(310 * k), 0.50), f"LargeTile.scale-{s}.png")

# Exact-size icons for the taskbar, Start list, Alt+Tab and File Explorer (plated and unplated forms).
for t in (16, 24, 32, 48, 256):
    save(plated(t, t, 0.84), f"Square44x44Logo.targetsize-{t}.png")
    save(rounded_icon(t), f"Square44x44Logo.targetsize-{t}_altform-unplated.png")
