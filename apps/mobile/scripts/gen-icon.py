#!/usr/bin/env python3
"""
Generates the carnet app icon set: a 3/4-rotated Moleskine-style notebook
on a warm dark background, with an elastic band closure and page edges
peeking out on the right + bottom.

Outputs:
  assets/icon.png             1024×1024 full icon with background
  assets/adaptive-icon.png    1024×1024 notebook on transparent (Android
                              adaptive foreground — fits the 66% safe zone
                              so it survives masking by any launcher shape)

Rationale: the notebook silhouette is tilted -6° for personality, sized so
the whole shape stays inside the adaptive safe zone, and uses a vertical
leather-tone gradient on the cover so it reads at small sizes too. Colors
match the splash backgroundColor in app.json so the splash → app icon
transition feels intentional.

Regenerate after design tweaks:
    cd apps/mobile && python3 scripts/gen-icon.py
"""

from __future__ import annotations
from PIL import Image, ImageDraw

CANVAS = 1024

# Color palette — warm leather + cream pages, anchored to the splash bg.
BG = (26, 20, 16, 255)              # #1A1410 — splash bg
COVER_TOP = (122, 77, 56, 255)      # #7A4D38 — leather highlight
COVER_BOTTOM = (92, 56, 38, 255)    # #5C3826 — leather shadow
SPINE = (60, 36, 24, 255)           # darker spine shadow on the left
PAGE = (245, 232, 208, 255)         # #F5E8D0 — cream page edges
BAND = (60, 47, 34, 255)            # #3C2F22 — elastic band
HIGHLIGHT = (162, 110, 80, 200)     # subtle top-edge highlight on cover
DARK_LINE = (40, 25, 18, 180)       # micro-shadow below the band

# Notebook geometry, sized to fit Android's 66% adaptive safe zone.
NB_W = 520
NB_H = 650
RADIUS = 22
ROTATION_DEG = -6
PAGE_OFFSET = 14                    # cream sliver visible on right + bottom
SPINE_WIDTH = 14
BAND_HEIGHT = 28
BAND_Y_FRAC = 0.72                  # vertical position of the band on cover


def make_vertical_gradient(size: tuple[int, int], top, bottom) -> Image.Image:
    """Solid leather-tone gradient — top lighter than bottom."""
    w, h = size
    g = Image.new("RGBA", (w, h), top)
    px = g.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        gn = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(w):
            px[x, y] = (r, gn, b, 255)
    return g


def make_rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    """Single-channel mask for rounded corners."""
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle(
        (0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255,
    )
    return m


def build_notebook() -> Image.Image:
    """Compose the notebook on a transparent canvas, then return it
    rotated and cropped to its bounding box."""
    # Padding around so rotation doesn't clip the corners.
    pad = 60
    canvas_w = NB_W + 2 * pad
    canvas_h = NB_H + 2 * pad
    nb = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(nb, "RGBA")

    # Page edges — drawn first, offset down + right, masked with cover later.
    page_box = (
        pad + PAGE_OFFSET, pad + PAGE_OFFSET,
        pad + NB_W + PAGE_OFFSET - 1, pad + NB_H + PAGE_OFFSET - 1,
    )
    d.rounded_rectangle(page_box, radius=RADIUS, fill=PAGE)

    # Cover gradient — generate at notebook size, mask with rounded rect.
    cover = make_vertical_gradient((NB_W, NB_H), COVER_TOP, COVER_BOTTOM)
    cover.putalpha(make_rounded_mask((NB_W, NB_H), RADIUS))
    nb.alpha_composite(cover, (pad, pad))

    # Subtle highlight along the top edge for depth.
    hl = Image.new("RGBA", (NB_W - 24, 6), HIGHLIGHT)
    nb.alpha_composite(hl, (pad + 12, pad + 18))

    # Spine — darker vertical band on the left, inset from top + bottom
    # so the spine reads as a shadow, not a stripe.
    spine_inset = 28
    d2 = ImageDraw.Draw(nb, "RGBA")
    d2.rectangle(
        (pad, pad + spine_inset, pad + SPINE_WIDTH, pad + NB_H - spine_inset),
        fill=SPINE,
    )

    # Elastic band — full width across the cover, with a thin dark line
    # below it for a subtle drop-shadow.
    band_y = pad + int(NB_H * BAND_Y_FRAC)
    d2.rectangle(
        (pad - 6, band_y, pad + NB_W + 6, band_y + BAND_HEIGHT),
        fill=BAND,
    )
    d2.rectangle(
        (pad - 6, band_y + BAND_HEIGHT, pad + NB_W + 6, band_y + BAND_HEIGHT + 3),
        fill=DARK_LINE,
    )
    # Tiny highlight on top of band for depth
    d2.rectangle(
        (pad - 6, band_y, pad + NB_W + 6, band_y + 2),
        fill=(80, 62, 46, 180),
    )

    # Rotate. expand=True keeps the corners.
    rotated = nb.rotate(ROTATION_DEG, resample=Image.BICUBIC, expand=True)
    return rotated.crop(rotated.getbbox())


def render(bg_color, scale: float = 1.0) -> Image.Image:
    """Render the full icon. `scale` shrinks the notebook within the canvas
    so the adaptive-foreground variant fits Android's 66% safe zone after
    launcher masking."""
    canvas = Image.new("RGBA", (CANVAS, CANVAS), bg_color)
    nb = build_notebook()
    if scale != 1.0:
        new_size = (int(nb.width * scale), int(nb.height * scale))
        nb = nb.resize(new_size, resample=Image.LANCZOS)
    x = (CANVAS - nb.width) // 2
    y = (CANVAS - nb.height) // 2
    canvas.alpha_composite(nb, (x, y))
    return canvas


def main() -> None:
    # Full icon: notebook on solid warm-dark background. The legacy icon
    # isn't masked so it can use the full canvas.
    render(BG).save("assets/icon.png", optimize=True)
    # Adaptive foreground: notebook on transparent, scaled to fit the 66%
    # safe zone so circle / squircle launcher masks don't clip the corners.
    render((0, 0, 0, 0), scale=0.62).save("assets/adaptive-icon.png", optimize=True)
    print("wrote assets/icon.png and assets/adaptive-icon.png")


if __name__ == "__main__":
    main()
