#!/usr/bin/env python3
"""Generate the extension icon set (16/32/48/128 px) into public/icons/.

A simple, trademark-safe placeholder mark: a rounded-square indigo tile with a
white speech bubble holding three transcript lines (talk -> notes). No Google
colors or logos. Each size is rendered at 8x and downscaled with LANCZOS for
crisp anti-aliased edges. Replace the PNGs with real artwork any time; rerun
with:  uv run --with pillow scripts/make-icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
SIZES = [16, 32, 48, 128]

BG = (79, 70, 229)        # indigo-600
BUBBLE = (255, 255, 255)  # white
LINE = (79, 70, 229)      # indigo (lines read as bg color inside the bubble)
SS = 8                    # supersample factor


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def render(size: int) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background tile (slight inset so the corners breathe at small sizes).
    pad = s * 0.04
    rounded(d, (pad, pad, s - pad, s - pad), radius=s * 0.22, fill=BG)

    # Speech bubble body.
    bx0, by0, bx1, by1 = s * 0.20, s * 0.24, s * 0.80, s * 0.64
    rounded(d, (bx0, by0, bx1, by1), radius=s * 0.10, fill=BUBBLE)
    # Bubble tail (a small triangle pointing down-left).
    d.polygon([(s * 0.34, by1 - 1), (s * 0.34, s * 0.78), (s * 0.50, by1 - 1)], fill=BUBBLE)

    # Three transcript lines inside the bubble.
    line_h = (by1 - by0) * 0.12
    left = bx0 + (bx1 - bx0) * 0.16
    widths = [0.62, 0.50, 0.40]  # fraction of inner width, tapering
    inner_w = (bx1 - bx0) * 0.84 - (bx1 - bx0) * 0.16
    for i, w in enumerate(widths):
        ly = by0 + (by1 - by0) * (0.26 + i * 0.24)
        rounded(d, (left, ly, left + inner_w * w / 0.62, ly + line_h),
                radius=line_h / 2, fill=LINE)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        render(size).save(path)
        print(f"wrote {path.relative_to(OUT.parent.parent)}")


if __name__ == "__main__":
    main()
