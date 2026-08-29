#!/usr/bin/env python3
"""Derive every Cattle Drover icon asset from one master mark (BASED-98).

The master is `sources/assets/images/drover-mark.png`: the longhorn skull as a
trimmed alpha mask, white where the mark is, transparent elsewhere. Everything
the app ships is a placement of that one mask, so a change to the mark is one
file and one command, not eight hand-edited PNGs that drift. That includes
`logo-drover.png`, the tintable mark the app's own screens render.

    python3 scripts/make-icons.py          # rewrite the assets
    python3 scripts/make-icons.py --check   # fail if they are stale

Ground is #000000 wherever the app paints one, matching the Android adaptive
`backgroundColor` already declared in app.config.js, so the icon reads the
same on both platforms and on the wrist. The Android splash pair is the one
exception: it inherits the light/dark ground expo-splash-screen declares.
Requires Pillow.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
images = root / "sources" / "assets" / "images"
public = root / "public"
master = images / "drover-mark.png"
# What the app's own <Image>s point at, as opposed to the platform icon files.
app_mark_path = images / "logo-drover.png"
watch_icon = root / "watch" / "DroverWatch" / "Assets.xcassets" / "AppIcon.appiconset" / "App-Icon-1024x1024@1x.png"

black = (0, 0, 0, 255)
white = (255, 255, 255, 255)
# The splash grounds expo-splash-screen declares in app.config.js, and the ink
# the light one needs so the mark is visible against it.
paper = (245, 245, 245, 255)
ink = (28, 28, 30, 255)
# The unread dot the web favicon wears while a session wants attention.
alert = (254, 44, 44, 255)

ico_sizes = [(16, 16), (32, 32), (48, 48)]


def snap_haze(alpha):
    """Zero the near-transparent haze the master carries outside the silhouette.

    Roughly two thirds of the master sits at alpha 1 or 2 rather than 0. On a
    black ground that is one level of 255 and beneath seeing, which is why
    every icon shipped so far bakes it in. Anywhere the mark is tinted over a
    light surface it stops being invisible and draws the mark's bounding box as
    a grey rectangle, so those assets snap it off.
    """
    return alpha.point(lambda v: 0 if v <= 2 else v)


def app_mark():
    """The mark as the app itself consumes it: a clean, tintable alpha mask.

    Native size, no ground, haze removed. Every in-app <Image> tints this, so
    it has to be clean on a light theme; the icon assets keep the raw master
    because their ground is black and their bytes already shipped.
    """
    mark = Image.open(master).convert("RGBA")
    painted = Image.new("RGBA", mark.size, white)
    painted.putalpha(snap_haze(mark.getchannel("A")))
    return painted


def place(size, width_fraction, color, ground, snap=False):
    """The mark, centered, occupying `width_fraction` of a `size` square.

    `color` paints the mark; `ground` paints behind it, or None for alpha.

    `snap` zeroes the near-transparent haze the master carries outside the
    silhouette (see `snap_haze`).
    """
    mark = Image.open(master).convert("RGBA")
    target_w = round(size * width_fraction)
    target_h = round(mark.height * target_w / mark.width)
    mark = mark.resize((target_w, target_h), Image.LANCZOS)

    alpha = mark.getchannel("A")
    if snap:
        alpha = snap_haze(alpha)
    painted = Image.new("RGBA", mark.size, color)
    painted.putalpha(alpha)

    canvas = Image.new("RGBA", (size, size), ground if ground else (0, 0, 0, 0))
    canvas.paste(painted, ((size - target_w) // 2, (size - target_h) // 2), painted)
    return canvas.convert("RGB") if ground else canvas


def with_alert_dot(canvas):
    """Stamp the unread dot bottom-right, where the mark leaves room.

    Top-right is the obvious badge corner and the wrong one here: the horn tips
    are the mark's highest AND widest points, so a dot there eats a tip and the
    silhouette stops reading at 16px. Below the horns the mark narrows to the
    nasal bone, so 0.78/0.78 at r 0.20 overlaps it by measured zero pixels.
    """
    canvas = canvas.convert("RGBA")
    size = canvas.width
    cx, cy, r = size * 0.78, size * 0.78, size * 0.20
    ImageDraw.Draw(canvas).ellipse(
        (cx - r, cy - r, cx + r, cy + r), fill=alert
    )
    return canvas


# width_fraction per asset, the colour the mark is painted, the ground behind
# it (None = transparent), whether it wears the unread dot, and whether the
# master's alpha haze is snapped off (see `place`).
#
# 0.78 on a square icon: the mark is 1.57:1, so filling more width would crowd
# the rounded-rect corners; filling less makes a wide mark look lost.
# 0.60 on the Android adaptive foreground, because the launcher may crop
# everything outside the centre 66% and a cropped horn is a broken icon.
# 0.52 on the splash, where the system scales the image itself and the mark
# only has to carry the same optical weight the old letterform did.
assets = [
    (images / "icon.png", 1024, 0.78, white, black, False, False),
    (images / "favicon.png", 1024, 0.78, white, black, False, False),
    (images / "icon-adaptive.png", 1024, 0.60, white, None, False, False),
    (images / "icon-monochrome.png", 1024, 0.60, white, None, False, False),
    (images / "icon-notification.png", 512, 0.82, white, None, False, False),
    (watch_icon, 1024, 0.78, white, black, False, False),
    (images / "splash-android-light.png", 1024, 0.52, ink, paper, False, True),
    (images / "splash-android-dark.png", 1024, 0.52, white, black, False, False),
    (images / "favicon-active.png", 1024, 0.78, white, black, True, False),
    (public / "favicon-active.ico", 48, 0.78, white, black, True, False),
]


def render(path, size, fraction, color, ground, badge, snap):
    # A .ico is tiny, so draw it big and downscale in one deterministic hop:
    # rendering the mask straight to 48px loses the horn tips.
    scale = 8 if path.suffix == ".ico" else 1
    made = place(size * scale, fraction, color, ground, snap)
    if badge:
        made = with_alert_dot(made)
    if scale > 1:
        made = made.resize((size, size), Image.LANCZOS)
    return made


def matches(path, made):
    """True when what is on disk is already what we would write."""
    if not path.exists():
        return False
    # Pillow opens an .ico at its largest frame, which is what we render.
    have = Image.open(path).convert(made.mode)
    return have.size == made.size and have.tobytes() == made.tobytes()


def write(path, made):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".ico":
        made.save(path, format="ICO", sizes=ico_sizes)
    else:
        made.save(path)


def main():
    check = "--check" in sys.argv[1:]
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    stale = []

    if not only or app_mark_path.name in only:
        made = app_mark()
        if check:
            if not matches(app_mark_path, made):
                stale.append(app_mark_path)
        else:
            write(app_mark_path, made)
            print(f"wrote {app_mark_path.relative_to(root)} ({made.width}x{made.height}, alpha)")

    for path, size, fraction, color, ground, badge, snap in assets:
        if only and path.name not in only:
            continue
        made = render(path, size, fraction, color, ground, badge, snap)
        if check:
            if not matches(path, made):
                stale.append(path)
            continue
        write(path, made)
        print(f"wrote {path.relative_to(root)} ({size}px, {'opaque' if ground else 'alpha'})")

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
