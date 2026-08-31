import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_GLASS_ALPHA } from './agentDockLayout';
import {
    CHROME_BACKDROP_EXTREMES,
    CHROME_CONTRAST_FLOOR,
    CHROME_GLASS_STYLE,
    CHROME_GLASS_TINT,
    CHROME_SEPARATION_FLOOR,
    CHROME_TARGET_MIN,
    CHROME_TINT_MAX_ALPHA,
    chromeGlassTint,
    chromeGround,
    chromeSurfaceSeparation,
    minimumChromeTintAlpha,
    colorAlpha,
    compositeSurface,
    contrastRatio,
    controlTargetHeight,
    controlTargetWidth,
    glyphContrast,
    minimumFillAlpha,
    parseColor,
    relativeLuminance,
    resolveGlassChromeMaterial,
    type ChromeControlSize,
} from './glassChrome';
import {
    MOBILE_COMPOSER_METRICS,
} from './agentInputLayout';
import { COMPOSER_SESSION_CONTROL_SIZE, composerModelSegmentWidth } from './sessionPillLabel';
import { MOBILE_GLASS_CONTROL_SIZE } from './navigation/headerMetrics';
import {
    HOME_INDICATOR_KEEP_OUT,
    STATUS_ROW_TAP_HEIGHT,
    resolveComposerButtonFloor,
} from './agentDockLayout';

describe('which material the chrome gets', () => {
    const base = {
        platform: 'ios',
        glassApiAvailable: true,
        runningOnMac: false,
        reduceTransparency: false,
    };

    it('draws Liquid Glass on an iOS 26 handset', () => {
        expect(resolveGlassChromeMaterial(base)).toBe('liquid');
    });

    // The one requirement with no room in it. Every route below has to land on
    // a control with a real background, because a floating button that
    // degrades to nothing over a chat is worse than one that never looked like
    // glass.
    it.each([
        ['an iOS below 26, where UIGlassEffect is absent', { glassApiAvailable: false }],
        ['Android', { platform: 'android' }],
        ['the web build', { platform: 'web' }],
        ['Catalyst on a Mac', { runningOnMac: true }],
        ['a user who turned Reduce Transparency on', { reduceTransparency: true }],
    ])('falls back to the flat surface on %s', (_case, override) => {
        expect(resolveGlassChromeMaterial({ ...base, ...override })).toBe('fallback');
    });

    it('asks for the regular material, never the clear one', () => {
        // `clear` is the barely-there material Apple uses over photography. On
        // the black chat Clay photographed it draws close to nothing, which is
        // the same complaint in a different shape.
        expect(CHROME_GLASS_STYLE).toBe('regular');
    });
});

describe('every chrome control against Apple’s 44pt floor', () => {
    // Clay, looking at the header and the composer: "I am expecting the button
    // sizes to be the normal button sizes that you see on a normal app". Both
    // numbers are checked, because a 42pt disc with 6pt of invisible slop
    // passes the target and still reads small: `drawnWidth`/`drawnHeight` is
    // what he sees, `slop` is the courtesy padding around it.
    const controls: ChromeControlSize[] = [
        { name: 'header back chevron', drawnWidth: MOBILE_GLASS_CONTROL_SIZE, drawnHeight: MOBILE_GLASS_CONTROL_SIZE, slop: 0 },
        { name: 'header title pill', drawnWidth: MOBILE_GLASS_CONTROL_SIZE, drawnHeight: MOBILE_GLASS_CONTROL_SIZE, slop: 0 },
        { name: 'header avatar capsule', drawnWidth: MOBILE_GLASS_CONTROL_SIZE, drawnHeight: MOBILE_GLASS_CONTROL_SIZE, slop: 0 },
        { name: 'jump to bottom', drawnWidth: CHROME_TARGET_MIN, drawnHeight: CHROME_TARGET_MIN, slop: 0 },
        { name: 'composer add', drawnWidth: MOBILE_COMPOSER_METRICS.actionSize, drawnHeight: MOBILE_COMPOSER_METRICS.actionSize, slop: 0 },
        { name: 'permission mode segment', drawnWidth: COMPOSER_SESSION_CONTROL_SIZE, drawnHeight: COMPOSER_SESSION_CONTROL_SIZE, slop: 0 },
        { name: 'effort segment', drawnWidth: COMPOSER_SESSION_CONTROL_SIZE, drawnHeight: COMPOSER_SESSION_CONTROL_SIZE, slop: 0 },
        {
            // The model's name (DROVE-178). As tall as its siblings, and
            // wider: the shortest name the picker offers is `Opus 5` and its
            // segment is already over the floor with the padding on it, so
            // the width is measured from the name rather than assumed.
            name: 'model segment',
            drawnWidth: composerModelSegmentWidth('Opus 5'),
            drawnHeight: COMPOSER_SESSION_CONTROL_SIZE,
            slop: 0,
        },
        { name: 'speaker segment', drawnWidth: MOBILE_COMPOSER_METRICS.actionSize, drawnHeight: MOBILE_COMPOSER_METRICS.actionSize, slop: 0 },
        { name: 'mic segment', drawnWidth: MOBILE_COMPOSER_METRICS.actionSize, drawnHeight: MOBILE_COMPOSER_METRICS.actionSize, slop: 0 },
        {
            name: 'in-field send / voice / stop',
            drawnWidth: MOBILE_COMPOSER_METRICS.primaryActionSize,
            drawnHeight: MOBILE_COMPOSER_METRICS.primaryActionSize,
            slop: MOBILE_COMPOSER_METRICS.primaryActionSlop,
        },
    ];

    it.each(controls.map((control) => [control.name, control] as const))(
        '%s answers a touch on at least 44 by 44',
        (_name, control) => {
            expect(controlTargetWidth(control)).toBeGreaterThanOrEqual(CHROME_TARGET_MIN);
            expect(controlTargetHeight(control)).toBeGreaterThanOrEqual(CHROME_TARGET_MIN);
        },
    );

    it('draws every one of them at 36pt or more, and all but the nested one at 44', () => {
        const nested = controls.filter((control) => control.drawnHeight < CHROME_TARGET_MIN);
        // Exactly one exception, and it is the button INSIDE the 44pt input
        // capsule: drawing it at 44 would touch both of the field's edges.
        // Messages nests its own mic at the same proportion.
        expect(nested.map((control) => control.name)).toEqual(['in-field send / voice / stop']);
        expect(nested[0].drawnHeight).toBe(36);
    });

    // The status row is the one place the floor is NOT met, and the arithmetic
    // for why lives in agentDockLayout. Asserted here so the number is on the
    // record rather than sitting quietly in a hitSlop (DROVE-153).
    it('records the status row segments as the one target under the floor, and what 44 would cost', () => {
        expect(STATUS_ROW_TAP_HEIGHT).toBe(31);
        expect(STATUS_ROW_TAP_HEIGHT).toBeLessThan(CHROME_TARGET_MIN);
        // Its ceiling is the composer's own buttons and its floor is the home
        // indicator. There is nothing between them to take.
        expect(resolveComposerButtonFloor(34) - HOME_INDICATOR_KEEP_OUT).toBe(STATUS_ROW_TAP_HEIGHT);
        expect(CHROME_TARGET_MIN - STATUS_ROW_TAP_HEIGHT).toBe(13);
    });
});

describe('legibility, measured rather than eyeballed', () => {
    // The ticket asks for the glyph checked against the material over both a
    // light and a dark scroll behind it. What follows is WCAG 2.1's own sRGB
    // luminance and contrast arithmetic, at the 3:1 bar 1.4.11 sets for a
    // non-text user interface component.
    //
    // THE MODEL, stated so the numbers can be argued with. A glyph on a
    // floating control sits on a stack: the chat, then the opaque scrim the app
    // paints under its own chrome (resolveDockScrimHeight under the composer,
    // MobileHeaderScrim under the header), then the control's fill. The
    // measured claim is about that stack, not about UIGlassEffect's private
    // adaptation, which is Apple's to change.
    const glyphOnDark = '#ffffff';
    const glyphOnLight = '#000000';

    it('agrees with the reference values for pure black and pure white', () => {
        expect(relativeLuminance(parseColor('#FFFFFF'))).toBeCloseTo(1, 5);
        expect(relativeLuminance(parseColor('#000000'))).toBeCloseTo(0, 5);
        expect(contrastRatio(parseColor('#FFFFFF'), parseColor('#000000'))).toBeCloseTo(21, 3);
    });

    it.each(CHROME_BACKDROP_EXTREMES)(
        'holds the floor for a white glyph on the dark fallback over a %s chat',
        (backdrop) => {
            // theme.dark surfaceHigh, which is what a device with no material
            // draws. Opaque, so the chat behind it cannot reach the glyph.
            expect(glyphContrast(glyphOnDark, backdrop, ['#1E1E1E']))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        },
    );

    it.each(CHROME_BACKDROP_EXTREMES)(
        'holds the floor for a dark glyph on the light fallback over a %s chat',
        (backdrop) => {
            expect(glyphContrast(glyphOnLight, backdrop, ['#F8F8F8']))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        },
    );

    it('holds the floor with the CHAT ITSELF behind the composer glass', () => {
        // WAS: an opaque dock backdrop under the glass, "so the material never
        // samples raw chat". It samples raw chat now (DROVE-180): the
        // transcript runs behind the composer at TRANSCRIPT_GLASS_ALPHA and
        // the material blurs it. So this is the same assertion against the
        // real stack, which is the transcript at that alpha over the page,
        // then the card's tint, then the button's own.
        //
        // It is the measurement that SETS TRANSCRIPT_GLASS_ALPHA. Every step
        // above 0.42 fails it, which is why the alpha is 0.4 and not 1.
        const behind = (alpha: number) => `rgba(255, 255, 255, ${alpha})`;
        const darkStack = (alpha: number) => [
            behind(alpha), chromeGlassTint(true), chromeGlassTint(true),
        ];
        expect(glyphContrast(glyphOnDark, '#000000', darkStack(TRANSCRIPT_GLASS_ALPHA)))
            .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        // The light theme's worst case is the mirror: a black block under a
        // dark glyph on the light page.
        const lightStack = [
            `rgba(0, 0, 0, ${TRANSCRIPT_GLASS_ALPHA})`,
            chromeGlassTint(false),
            chromeGlassTint(false),
        ];
        expect(glyphContrast(glyphOnLight, chromeGround(false), lightStack))
            .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        // And the ceiling is real: a step past it and the dark theme fails.
        expect(glyphContrast(glyphOnDark, '#000000', darkStack(0.5)))
            .toBeLessThan(CHROME_CONTRAST_FLOOR);
        expect(glyphContrast(glyphOnDark, '#000000', darkStack(1)))
            .toBeLessThan(CHROME_CONTRAST_FLOOR);
    });

    it('says how much of that the app owns and how much the material carries', () => {
        // Stated rather than assumed. The model treats UIGlassEffect as a
        // plain translucent tint; the real `regular` material also blurs,
        // desaturates and clamps what it samples, all of which can only help.
        // Holding the pessimistic bound is the point: legibility does not
        // depend on a private Apple adaptation that changes between releases,
        // and if it ever looks wrong on device the lever is this alpha.
        const owned = 1 - (1 - colorAlpha(chromeGlassTint(true))) ** 2;
        expect(owned).toBeLessThan(minimumFillAlpha(glyphOnDark, '#000000'));
        expect(owned).toBeCloseTo(0.2775, 4);
    });

    it('says how opaque a fill has to be to survive ANY backdrop unaided', () => {
        // The number worth knowing, and the reason `colorScheme` is forced to
        // the theme rather than left on `auto`. A dark-theme control needs its
        // own fill at 42% before a white glyph is guaranteed 3:1 no matter what
        // scrolls behind it, and a light-theme one at 35%. Both are inside what
        // UIGlassEffect's `regular` style paints and well outside what `clear`
        // does, which is the measurement behind CHROME_GLASS_STYLE. Note how
        // far these sit from a guess: sRGB compositing is not linear in
        // luminance, and the closed form most people reach for says 70%.
        expect(minimumFillAlpha(glyphOnDark, '#000000')).toBeCloseTo(0.42, 2);
        expect(minimumFillAlpha(glyphOnLight, '#FFFFFF')).toBeCloseTo(0.35, 2);
    });

    it('keeps the blue-tinted buttons legible as well as blue', () => {
        // The tint carries meaning, so it does not get to be swapped for
        // something more readable; it has to be readable as it is. iOS system
        // blue with white on it, over either extreme.
        for (const backdrop of CHROME_BACKDROP_EXTREMES) {
            expect(glyphContrast('#FFFFFF', backdrop, ['#007AFF']))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        }
    });
});

describe('the composer has an edge against its own ground (DROVE-171)', () => {
    it('clears the separation floor for its theme', () => {
        expect(chromeSurfaceSeparation(true)).toBeGreaterThanOrEqual(CHROME_SEPARATION_FLOOR.dark);
        expect(chromeSurfaceSeparation(false)).toBeGreaterThanOrEqual(CHROME_SEPARATION_FLOOR.light);
    });

    it('is a large improvement on the tint it replaces, which was 1.008:1 over black', () => {
        // theme.colors.glass.tint on the dark theme: rgba(16, 16, 16, 0.08),
        // a near-black wash over a #000000 chat. That is what Clay
        // photographed and called "no contrast".
        const wasDark = contrastRatio(
            compositeSurface('#000000', ['rgba(16, 16, 16, 0.08)']),
            parseColor('#000000'),
        );
        expect(wasDark).toBeLessThan(1.02);
        expect(chromeSurfaceSeparation(true)).toBeGreaterThan(wasDark * 1.3);
    });

    it('lifts on dark and settles on light, because the ground moved', () => {
        expect(chromeGlassTint(true)).toBe(CHROME_GLASS_TINT.dark);
        expect(chromeGlassTint(false)).toBe(CHROME_GLASS_TINT.light);
        const darkSurface = compositeSurface(chromeGround(true), [chromeGlassTint(true)]);
        const lightSurface = compositeSurface(chromeGround(false), [chromeGlassTint(false)]);
        expect(relativeLuminance(darkSurface))
            .toBeGreaterThan(relativeLuminance(parseColor(chromeGround(true))));
        expect(relativeLuminance(lightSurface))
            .toBeLessThan(relativeLuminance(parseColor(chromeGround(false))));
    });

    it('stays a tint rather than becoming a fill, which is the other half of the ticket', () => {
        expect(colorAlpha(chromeGlassTint(true))).toBeLessThan(CHROME_TINT_MAX_ALPHA);
        expect(colorAlpha(chromeGlassTint(false))).toBeLessThan(CHROME_TINT_MAX_ALPHA);
        // A fill that could carry a glyph against any backdrop is far more
        // opaque than this. The gap is what keeps the backdrop visible.
        expect(colorAlpha(chromeGlassTint(true)))
            .toBeLessThan(minimumFillAlpha('#FFFFFF', '#1C1C1E'));
    });

    it('is the measured minimum now that content is behind it (DROVE-180)', () => {
        // WAS: "holds over a light code block because DROVE-168 never lets one
        // get behind it" — the ground was the page at every scroll position,
        // so tint could only ever help and DROVE-171 spent it freely.
        //
        // A light code block gets behind it now. Every point of tint is a
        // point of content the material stops showing, so the right tint is
        // the smallest that still draws an edge over an EMPTY black chat,
        // which is what the ground constants still describe. Within one 1%
        // step of the search, so raising one means moving the FLOOR and
        // saying why.
        expect(chromeGround(true)).toBe('#000000');
        expect(chromeGround(false)).toBe('#F2F2F7');
        expect(colorAlpha(chromeGlassTint(true)))
            .toBeCloseTo(minimumChromeTintAlpha(true), 2);
        expect(colorAlpha(chromeGlassTint(false)))
            .toBeCloseTo(minimumChromeTintAlpha(false), 2);
        // The numbers, so the diff can be read without running anything.
        expect(minimumChromeTintAlpha(true)).toBeCloseTo(0.15, 5);
        expect(minimumChromeTintAlpha(false)).toBeCloseTo(0.09, 5);
    });

    it('came DOWN from DROVE-171’s tint rather than up, and says by how much', () => {
        // DROVE-171 shipped 0.16 dark / 0.10 light, at 1.440:1 and 1.251:1.
        const wasDark = contrastRatio(
            compositeSurface(chromeGround(true), ['rgba(255, 255, 255, 0.16)']),
            parseColor(chromeGround(true)),
        );
        const wasLight = contrastRatio(
            compositeSurface(chromeGround(false), ['rgba(0, 0, 0, 0.10)']),
            parseColor(chromeGround(false)),
        );
        expect(wasDark).toBeCloseTo(1.44, 2);
        expect(wasLight).toBeCloseTo(1.25, 2);
        expect(chromeSurfaceSeparation(true)).toBeLessThan(wasDark);
        expect(chromeSurfaceSeparation(false)).toBeLessThan(wasLight);
        expect(chromeSurfaceSeparation(true)).toBeCloseTo(1.392, 3);
        expect(chromeSurfaceSeparation(false)).toBeCloseTo(1.222, 3);
    });
});
