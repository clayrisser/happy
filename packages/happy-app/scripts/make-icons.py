#!/usr/bin/env python3
"""Derive every Cattle Drover icon asset from one master mark (BASED-98).

The master is `sources/assets/images/drover-mark.png`: the longhorn skull as a
trimmed alpha mask, white where the mark is, transparent elsewhere. Everything
the app ships is a placement of that one mask, so a change to the mark is one
file and one command, not eight hand-edited PNGs that drift.

    python3 scripts/make-icons.py          # rewrite the assets
    python3 scripts/make-icons.py --check   # fail if they are stale

Ground is #000000 everywhere it is opaque, matching the Android adaptive
`backgroundColor` already declared in app.config.js, so the icon reads the
same on both platforms and on the wrist. Requires Pillow.
"""

import sys
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parent.parent
images = root / "sources" / "assets" / "images"
master = images / "drover-mark.png"
watch_icon = root / "watch" / "DroverWatch" / "Assets.xcassets" / "AppIcon.appiconset" / "App-Icon-1024x1024@1x.png"

black = (0, 0, 0, 255)
white = (255, 255, 255, 255)


def place(size, width_fraction, opaque):
    """The mark, centered, occupying `width_fraction` of a `size` square."""
    mark = Image.open(master).convert("RGBA")
    target_w = round(size * width_fraction)
    target_h = round(mark.height * target_w / mark.width)
    mark = mark.resize((target_w, target_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (size, size), black if opaque else (0, 0, 0, 0))
    canvas.paste(mark, ((size - target_w) // 2, (size - target_h) // 2), mark)
    return canvas.convert("RGB") if opaque else canvas


# width_fraction per asset, and whether the ground is painted.
#
# 0.78 on a square icon: the mark is 1.57:1, so filling more width would crowd
# the rounded-rect corners; filling less makes a wide mark look lost.
# 0.60 on the Android adaptive foreground, because the launcher may crop
# everything outside the centre 66% and a cropped horn is a broken icon.
assets = [
    (images / "icon.png", 1024, 0.78, True),
    (images / "favicon.png", 1024, 0.78, True),
    (images / "icon-adaptive.png", 1024, 0.60, False),
    (images / "icon-monochrome.png", 1024, 0.60, False),
    (images / "icon-notification.png", 512, 0.82, False),
    (watch_icon, 1024, 0.78, True),
]


def main():
    check = "--check" in sys.argv[1:]
    stale = []
    for path, size, fraction, opaque in assets:
        made = place(size, fraction, opaque)
        if check:
            if not path.exists():
                stale.append(path)
                continue
            have = Image.open(path).convert(made.mode)
            if have.size != made.size or have.tobytes() != made.tobytes():
                stale.append(path)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        made.save(path)
        print(f"wrote {path.relative_to(root)} ({size}px, {'opaque' if opaque else 'alpha'})")

    if check and stale:
        for path in stale:
            print(f"stale: {path.relative_to(root)}", file=sys.stderr)
        print("run: python3 scripts/make-icons.py", file=sys.stderr)
        return 1
    if check:
        print("icons are current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
