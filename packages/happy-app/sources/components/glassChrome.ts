/**
 * The rules behind the chrome's Liquid Glass, kept out of the components so a
 * test can check them (DROVE-153).
 *
 * Clay, with close-ups of the header and the composer: "They should all be
 * drawn with liquid glass like they should all feel native", then "I am
 * expecting the button sizes to be the normal button sizes that you see on a
 * normal app". Two separate asks, and this module holds the arithmetic for
 * both: which material a control gets, and how big it has to be.
 *
 * WHY THE OLD CHROME LOOKED FLAT. `MobileGlassSurface` has three materials and
 * only one of them reaches iOS 26's real material. `material="liquid"` renders
 * `GlassView`, which is a `UIVisualEffectView` carrying a `UIGlassEffect`.
 * `material="static"` and `material="frosted"` render `expo-blur`'s `BlurView`
 * with a flat colour painted over it. The header's pill, avatar and back
 * circle were all on `static`, and the composer slab on `frosted`. A blur of a
 * black chat is black, so what was left on screen was the flat overlay: a dark
 * grey rounded shape on black, which is exactly what Clay photographed. The
 * fix is the material, not the colour.
 */

/**
 * Apple's minimum comfortable target, and the number Clay's two reference
 * shots are both built on: the Screenshot markup toolbar's X and check, and
 * Messages' round + and its in-field mic.
 */
export const CHROME_TARGET_MIN = 44;

/**
 * Every chrome control on the session screen, with what it draws and what it
 * answers a touch on. The test walks this and fails on anything under
 * `CHROME_TARGET_MIN`, so a control cannot quietly shrink later.
 *
 * `drawn` is the visible surface, `target` is drawn plus slop. Both are listed
 * because Clay's complaint was about the drawn size: a 42pt disc with 6pt of
 * invisible slop passes the HIG and still reads as small next to a system app.
 */
export interface ChromeControlSize {
    name: string;
    drawnWidth: number;
    drawnHeight: number;
    slop: number;
    /** Set where the target is deliberately under the floor, with the reason. */
    exemptReason?: string;
}

export function controlTargetWidth(control: ChromeControlSize): number {
    return control.drawnWidth + control.slop * 2;
}

export function controlTargetHeight(control: ChromeControlSize): number {
    return control.drawnHeight + control.slop * 2;
}

/**
 * Which material a control should be drawn in, decided once per process.
 *
 * `liquid` is iOS 26's `UIGlassEffect`. Everything else falls back to the flat
 * surface the app drew before this ticket, which is a visible control with a
 * real background: the one outcome that must never happen is a control that
 * degrades to nothing, because a floating button with no surface over a chat
 * is invisible rather than merely plain.
 *
 * Reduce Transparency is honoured rather than fought. Apple's own controls go
 * solid under it, and a user who asked for less translucency is not asking for
 * a prettier composer.
 */
export type GlassChromeMaterial = 'liquid' | 'fallback';

export interface GlassChromeMaterialInput {
    platform: string;
    /** `isGlassEffectAPIAvailable()` from expo-glass-effect. */
    glassApiAvailable: boolean;
    runningOnMac: boolean;
    reduceTransparency: boolean;
}

export function resolveGlassChromeMaterial(input: GlassChromeMaterialInput): GlassChromeMaterial {
    if (input.platform !== 'ios') {
        return 'fallback';
    }
    if (input.runningOnMac || input.reduceTransparency || !input.glassApiAvailable) {
        return 'fallback';
    }
    return 'liquid';
}

/**
 * The glass style for chrome.
 *
 * `regular`, never `clear`. `clear` is the barely-there material Apple uses
 * over photography, where the content behind is the point; it gives a control
 * almost no fill of its own, which over a black chat is another way of drawing
 * nothing. `regular` is what the system toolbars and floating buttons use and
 * it is what carries a glyph.
 */
export const CHROME_GLASS_STYLE = 'regular' as const;

//
// Legibility, measured rather than eyeballed.
//
// The ticket asks for the glyph checked against the material over both a light
// and a dark scroll behind it. These are the sRGB relative-luminance and
// contrast formulas from WCAG 2.1; the bar is 3:1, which is 1.4.11 for a
// non-text user interface component, and it is the right bar because these are
// glyphs and surfaces rather than body copy.
//

export type Rgb = { r: number; g: number; b: number };

export function parseColor(color: string): Rgb {
    const value = color.trim();
    if (value.startsWith('#')) {
        const digits = value.slice(1);
        const full = digits.length === 3
            ? digits.split('').map((d) => d + d).join('')
            : digits;
        return {
            r: parseInt(full.slice(0, 2), 16) / 255,
            g: parseInt(full.slice(2, 4), 16) / 255,
            b: parseInt(full.slice(4, 6), 16) / 255,
        };
    }
    const match = value.match(/^rgba?\(([^)]+)\)$/i);
    if (!match) {
        throw new Error(`unsupported colour: ${color}`);
    }
    const parts = match[1].split(',').map((part) => Number(part.trim()));
    return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255 };
}

export function colorAlpha(color: string): number {
    const match = color.trim().match(/^rgba\(([^)]+)\)$/i);
    if (!match) {
        return 1;
    }
    const parts = match[1].split(',').map((part) => Number(part.trim()));
    return parts.length >= 4 ? parts[3] : 1;
}

/** WCAG relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
    const channel = (value: number) => (value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4));
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
}

/** Source-over compositing of a translucent layer onto an opaque one. */
export function compositeOver(top: string, bottom: Rgb): Rgb {
    const alpha = colorAlpha(top);
    const rgb = parseColor(top);
    return {
        r: rgb.r * alpha + bottom.r * (1 - alpha),
        g: rgb.g * alpha + bottom.g * (1 - alpha),
        b: rgb.b * alpha + bottom.b * (1 - alpha),
    };
}

/**
 * What a glyph actually sits on, given the chat scrolling behind the control.
 *
 * `layers` are painted in order from the back, each one source-over the last.
 * A control is a stack: whatever the chat is showing, then the dock or header
 * scrim the app paints under its chrome, then the control's own fill.
 */
export function compositeSurface(backdrop: string, layers: readonly string[]): Rgb {
    return layers.reduce<Rgb>((below, layer) => compositeOver(layer, below), parseColor(backdrop));
}

export function glyphContrast(glyph: string, backdrop: string, layers: readonly string[]): number {
    return contrastRatio(parseColor(glyph), compositeSurface(backdrop, layers));
}

/** WCAG 1.4.11: a non-text UI component needs 3:1 against what is behind it. */
export const CHROME_CONTRAST_FLOOR = 3;

/**
 * The extremes a chat can put behind a floating control: a wall of white
 * (a light theme, or a photo, or a diff full of added lines) and a wall of
 * black. Every legibility check runs against both.
 */
export const CHROME_BACKDROP_EXTREMES = ['#FFFFFF', '#000000'] as const;

/**
 * The least opaque a control's own fill may be and still hold the floor
 * against ANY backdrop.
 *
 * Searched rather than solved. Alpha compositing is linear in sRGB channel
 * values and the contrast ratio is not linear in those, so the closed form is
 * easy to get subtly wrong; stepping the alpha and asking the same
 * `glyphContrast` the assertions use cannot disagree with them. Returns 1 if
 * even an opaque fill of this colour cannot carry this glyph, which is a real
 * answer and not a failure: it means the pair is wrong, not the alpha.
 */
export function minimumFillAlpha(
    glyph: string,
    fill: string,
    ratio = CHROME_CONTRAST_FLOOR,
    backdrops: readonly string[] = CHROME_BACKDROP_EXTREMES,
): number {
    const rgb = parseColor(fill);
    const channels = `${Math.round(rgb.r * 255)}, ${Math.round(rgb.g * 255)}, ${Math.round(rgb.b * 255)}`;
    for (let step = 0; step <= 100; step += 1) {
        const alpha = step / 100;
        const layer = `rgba(${channels}, ${alpha})`;
        const holds = backdrops.every((backdrop) => glyphContrast(glyph, backdrop, [layer]) >= ratio);
        if (holds) {
            return alpha;
        }
    }
    return 1;
}
