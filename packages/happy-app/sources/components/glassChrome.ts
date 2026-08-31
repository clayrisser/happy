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
    /**
     * Slop on the HORIZONTAL axis, where it differs from `slop` (DROVE-236).
     *
     * A control that sits against its neighbour has no horizontal slop to
     * take: claiming it would be claiming the neighbour's ink. That is true of
     * the composer's session capsule, whose segments touch each other, and it
     * is a fact about the shape rather than an oversight, so it is modelled
     * rather than averaged into one number.
     */
    horizontalSlop?: number;
    /** Set where the target is deliberately under the floor, with the reason. */
    exemptReason?: string;
}

export function controlTargetWidth(control: ChromeControlSize): number {
    return control.drawnWidth + (control.horizontalSlop ?? control.slop) * 2;
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

//
// Separation: why the composer had no edge, and the number that fixes it
// (DROVE-171), re-measured with content behind the glass (DROVE-180).
//
// Clay, on a close-up of the composer against the black chat: "There's no
// contrast here". The cause is arithmetic rather than taste. The dark theme's
// glass tint was `rgba(16, 16, 16, 0.08)`, a NEAR-BLACK wash at 8% over a
// `#000000` chat: composited it lands on rgb(1, 1, 1), a contrast ratio of
// 1.008:1 against the ground. The material was tinted TOWARD the background it
// was meant to float over.
//
// DROVE-171 fixed the direction and then overshot the amount, and the reason
// is written into the version of this comment it replaced: it assumed
// DROVE-168's fade, which took the transcript to nothing before it reached the
// composer, so the ground behind the glass was the page background at every
// scroll position and the tint was the ONLY thing that could separate. On that
// assumption more tint is strictly safer, and 0.16 was picked with room to
// spare.
//
// The assumption is gone. DROVE-180 lets the transcript pass behind the
// composer at full alpha, so the ground is usually live content the material
// can refract, and the empty black chat with nothing scrolled under it is now
// the WORST case rather than the only case. Tint past what that worst case
// needs and every other case pays for it: an over-tinted surface is the grey
// slab again, just a lighter one.
//
// So the tints are the measured minimum that clears each theme's floor, found
// by `minimumChromeTintAlpha` at the same 1% steps `minimumFillAlpha` uses:
//
//   dark   0.16 -> 0.15   1.440:1 -> 1.392:1   floor 1.35
//   light  0.10 -> 0.09   1.251:1 -> 1.222:1   floor 1.20
//
// A test asserts each shipped tint is within one step of that minimum, so the
// next person to raise one has to move the FLOOR and say why, rather than
// nudging the alpha.
//

/**
 * The chat behind the composer with nothing scrolled under it: an empty
 * session. It is the worst case for separation, not the only one (DROVE-180).
 */
export const CHROME_GROUND = { dark: '#000000', light: '#F2F2F7' } as const;

/**
 * `UIGlassEffect.tintColor` for chrome, per theme.
 *
 * A translucent wash, not a fill: at 15% and 9% the material still refracts
 * and blurs what is behind it, which is the difference between a glass surface
 * and a grey rectangle. That matters more since DROVE-180 than it did when
 * these were chosen, because there is now real content back there to refract.
 * Asserted below the fill bar, and within one step of the measured minimum.
 */
export const CHROME_GLASS_TINT = {
    dark: 'rgba(255, 255, 255, 0.15)',
    light: 'rgba(0, 0, 0, 0.09)',
} as const;

export function chromeGlassTint(dark: boolean): string {
    return dark ? CHROME_GLASS_TINT.dark : CHROME_GLASS_TINT.light;
}

export function chromeGround(dark: boolean): string {
    return dark ? CHROME_GROUND.dark : CHROME_GROUND.light;
}

/**
 * What the tint composites to over its theme's ground, and how far that sits
 * from the ground. This is the number DROVE-171 asks to be stated rather than
 * eyeballed.
 *
 * dark  rgba(255,255,255,0.15) over #000000 -> rgb(38, 38, 38),    1.39:1
 * light rgba(0,0,0,0.09)       over #F2F2F7 -> rgb(220, 220, 225), 1.22:1
 * was   rgba(255,255,255,0.16) over #000000 -> rgb(41, 41, 41),    1.44:1  (DROVE-171)
 * was   rgba(16,16,16,0.08)    over #000000 -> rgb(1, 1, 1),       1.01:1  (before it)
 */
export function chromeSurfaceSeparation(dark: boolean): number {
    const ground = chromeGround(dark);
    return contrastRatio(compositeSurface(ground, [chromeGlassTint(dark)]), parseColor(ground));
}

/**
 * The floor each theme's separation has to clear.
 *
 * Dark is the higher bar because black gives the material nothing of its own:
 * a glass control over `#000000` is whatever its tint makes it. Light is lower
 * on purpose. There the ground is already bright, the material keeps a visible
 * rim and shadow against it, and pushing the tint to the dark theme's number
 * turns a glass slab into a grey one, which is the failure mode DROVE-171
 * names ("a flat fill that happens to have contrast fails").
 */
export const CHROME_SEPARATION_FLOOR = { dark: 1.35, light: 1.2 } as const;

/**
 * The most opaque a chrome tint may be and still be a tint.
 *
 * `minimumFillAlpha` answers the opposite question, how opaque a fill has to
 * be to carry a glyph against ANY backdrop, and the answer there is far higher
 * than this. Staying under a quarter is what keeps the backdrop visible
 * through the surface.
 */
export const CHROME_TINT_MAX_ALPHA = 0.25;

/**
 * The least tint a theme can carry and still clear its separation floor.
 *
 * Searched, for the same reason `minimumFillAlpha` is searched: compositing is
 * linear in sRGB channel values and the contrast ratio is not, so the closed
 * form is easy to get subtly wrong, and stepping the alpha through the same
 * `chromeSurfaceSeparation` the assertions use cannot disagree with them.
 *
 * This is the DROVE-180 direction of travel, and it is the opposite of
 * DROVE-171's. With the transcript masked out, tint could only help. With the
 * transcript running behind the glass, every point of tint is a point of
 * content the material stops showing, so the right tint is the smallest one
 * that still draws an edge over an EMPTY black chat.
 */
export function minimumChromeTintAlpha(dark: boolean): number {
    const ground = chromeGround(dark);
    const channels = dark ? '255, 255, 255' : '0, 0, 0';
    const floor = dark ? CHROME_SEPARATION_FLOOR.dark : CHROME_SEPARATION_FLOOR.light;
    for (let step = 0; step <= 100; step += 1) {
        const alpha = step / 100;
        const surface = compositeSurface(ground, [`rgba(${channels}, ${alpha})`]);
        if (contrastRatio(surface, parseColor(ground)) >= floor) {
            return alpha;
        }
    }
    return 1;
}
