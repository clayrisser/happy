import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CHROME_BACKDROP_EXTREMES,
    CHROME_CONTRAST_FLOOR,
    CHROME_TARGET_MIN,
    colorAlpha,
    controlTargetHeight,
    controlTargetWidth,
    glyphContrast,
    minimumFillAlpha,
    resolveGlassChromeMaterial,
} from './glassChrome';
import {
    FAB_RADIUS,
    FAB_SIZE,
    flatChromeExemptions,
    flatChromeMarkers,
    screenChromeControls,
    screenChromeSurfaces,
} from './glassChromeScreens';
import {
    MOBILE_HEADER_EDGE_RAMP_POINTS,
    MOBILE_HOME_SCRIM_OVERLAY_OPACITY,
    MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY,
    MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY,
} from './navigation/mobileHeaderScrimMetrics';

const sourcesRoot = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            walk(full, out);
        } else if (entry.endsWith('.tsx')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * A marker only counts where it is DRAWN. Several of these files explain the
 * materials at the top, and naming one is not using one, so a line that is
 * prose is skipped.
 */
function drawsFlatMaterial(source: string): boolean {
    return source.split('\n').some((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
            return false;
        }
        return flatChromeMarkers.some((marker) => trimmed.includes(marker));
    });
}

describe('the chrome outside the session screen, against DROVE-153’s floor', () => {
    // Same table and same bar as glassChrome.test.ts. A back chevron on the
    // settings screen has no business being smaller than the same chevron on
    // the session screen, and Clay's complaint was about the DRAWN size.
    it.each(screenChromeControls.map((control) => [control.name, control] as const))(
        '%s answers a touch on at least 44 by 44',
        (_name, control) => {
            expect(controlTargetWidth(control)).toBeGreaterThanOrEqual(CHROME_TARGET_MIN);
            expect(controlTargetHeight(control)).toBeGreaterThanOrEqual(CHROME_TARGET_MIN);
        },
    );

    it('draws every one of them at 44 or more, with no exceptions on these screens', () => {
        // The session composer has one nested exception, measured on DROVE-153.
        // Nothing here is nested inside another control, so nothing here earns
        // one.
        const under = screenChromeControls.filter((control) => control.drawnHeight < CHROME_TARGET_MIN);
        expect(under.map((control) => control.name)).toEqual([]);
    });

    it('keeps the floating add button a squircle rather than a circle', () => {
        // 56pt with a 20pt radius is what it already drew. Recorded so the
        // conversion to the chrome primitive cannot quietly round it off.
        expect(FAB_SIZE).toBeGreaterThan(CHROME_TARGET_MIN);
        expect(FAB_RADIUS).toBeLessThan(FAB_SIZE / 2);
    });
});

describe('the walk: every screen with a header or a floating control', () => {
    it('names a file that exists for every surface', () => {
        for (const surface of screenChromeSurfaces) {
            expect(() => statSync(join(sourcesRoot, surface.source)), surface.name).not.toThrow();
        }
    });

    it('gives a reason for anything not on the chrome primitive', () => {
        // The list is the handoff. An entry left off the primitive with no
        // reason is a screen someone skipped without saying so.
        for (const surface of screenChromeSurfaces) {
            if (surface.material === 'chrome') continue;
            expect(surface.reason, surface.name).toBeTruthy();
        }
    });

    it('leaves no floating control on a flat material without one', () => {
        const floatingFlat = screenChromeSurfaces.filter(
            (surface) => surface.floating && (surface.material === 'writing' || surface.material === 'content'),
        );
        for (const surface of floatingFlat) {
            expect(surface.reason, surface.name).toBeTruthy();
        }
    });

    it('covers the header once, because the header is one component', () => {
        // The reach fix is what makes this true: every phone screen renders
        // components/navigation/Header.tsx now, so converting it converts the
        // agent screen, settings, the sessions list, session info, files, the
        // file view, the reader, artifacts, machines, gates and the rest.
        const headers = screenChromeSurfaces.filter((surface) => surface.source.endsWith('navigation/Header.tsx'));
        expect(headers).toHaveLength(1);
        expect(headers[0].material).toBe('chrome');
    });
});

describe('nothing is left claiming a material it does not get', () => {
    const files = walk(sourcesRoot);
    const offenders = files
        .filter((file) => drawsFlatMaterial(readFileSync(file, 'utf8')))
        .map((file) => relative(sourcesRoot, file));
    const exempt = flatChromeExemptions.map((exemption) => exemption.source);

    it('finds the flat materials only where a reason is written down', () => {
        // `material="static"` and `material="frosted"` are expo-blur with a
        // flat colour painted over, and `glassEffectStyle="clear"` draws close
        // to nothing over a dark screen. Scanned rather than reviewed, because
        // the fault this ticket fixes is a surface that reads as converted in
        // a diff and is not.
        expect(offenders.sort()).toEqual(exempt.slice().sort());
    });

    it('keeps no reason alive for code that stopped drawing one', () => {
        for (const exemption of flatChromeExemptions) {
            expect(offenders, exemption.source).toContain(exemption.source);
            expect(exemption.reason.length).toBeGreaterThan(20);
        }
    });

    it('has taken the shared navigation header off the flat path entirely', () => {
        const header = readFileSync(join(sourcesRoot, 'components/navigation/Header.tsx'), 'utf8');
        // The name still appears in the comment explaining what it used to
        // draw. What must be gone is the element.
        expect(header).not.toContain('<MobileGlassSurface');
        expect(header).toContain('<GlassChromeSurface');
        expect(header).toContain('<GlassChromeButton');
    });

    it('routes every phone through that header rather than UIKit’s bar', () => {
        // The material fix on its own changed nothing on the screen Clay
        // photographed, because iPhones were not rendering this component.
        const layout = readFileSync(join(sourcesRoot, 'app/(app)/_layout.tsx'), 'utf8');
        expect(layout).toContain("Platform.OS !== 'ios' || isRunningOnMac() || !isTablet");
    });
});

describe('the fallback still draws a control, on every screen', () => {
    // The one requirement with no room in it, restated for the screens this
    // ticket reaches: a floating button that degrades to nothing over a list
    // is worse than one that never looked like glass.
    const base = {
        platform: 'ios',
        glassApiAvailable: true,
        runningOnMac: false,
        reduceTransparency: false,
    };

    it.each([
        ['an iOS below 26, where UIGlassEffect is absent', { glassApiAvailable: false }],
        ['Android', { platform: 'android' }],
        ['a user who turned Reduce Transparency on', { reduceTransparency: true }],
    ])('falls back to a flat surface on %s', (_case, override) => {
        expect(resolveGlassChromeMaterial({ ...base, ...override })).toBe('fallback');
    });

    it('leaves no converted control painting its own transparent background', () => {
        // This is the bug the conversion removes, not a hypothetical. The old
        // header styles carried `backgroundColor: Platform.select({ ios:
        // 'transparent' })`, and a style prop wins over the fallback's own
        // fill, so an iPhone without the material got an INVISIBLE back
        // button rather than a plain one. The fill belongs to
        // GlassChromeSurface and to nothing else.
        for (const source of [
            'components/navigation/Header.tsx',
            'components/FAB.tsx',
            'components/VoiceAssistantStatusBar.tsx',
        ]) {
            const text = readFileSync(join(sourcesRoot, source), 'utf8');
            const glassStyleBlocks = text.match(/\n {4}[a-zA-Z]*[Gg]lass[a-zA-Z]*: \{[\s\S]*?\n {4}\},/g) ?? [];
            for (const block of glassStyleBlocks) {
                expect(block, `${source} ${block.slice(0, 40)}`).not.toContain('backgroundColor');
            }
        }
    });
});

describe('legibility on these screens, measured over both backdrops and both themes', () => {
    // Same arithmetic as DROVE-153: WCAG 2.1 sRGB relative luminance and
    // contrast, at 1.4.11's 3:1 bar for a non-text user interface component.
    //
    // THE STACK, stated so the numbers can be argued with. A glyph on one of
    // these controls sits on: whatever the screen is showing, then
    // MobileHeaderScrim's gradient where there is one, then the control's own
    // fill. The claim is about that stack, not about UIGlassEffect's private
    // adaptation, which is Apple's to change.
    const glyphOnDark = '#ffffff'; // theme.dark colors.header.tint
    const glyphOnLight = '#18171C'; // theme.light colors.header.tint
    const darkFallbackFill = '#1E1E1E'; // theme.dark colors.surfaceHigh
    const lightFallbackFill = '#F8F8F8'; // theme.light colors.surfaceHigh

    // MobileHeaderScrim's strong variant at its resting strength: peak 0.55
    // black on the dark theme and 0.76 white on the light one, times the 0.80
    // the header holds it at until content underlaps.
    const darkScrim = `rgba(0, 0, 0, ${0.55 * 0.8})`;
    const lightScrim = `rgba(255, 255, 255, ${0.76 * 0.8})`;

    it.each(CHROME_BACKDROP_EXTREMES)(
        'holds the floor for the dark theme’s header glyph on the fallback over a %s screen',
        (backdrop) => {
            expect(glyphContrast(glyphOnDark, backdrop, [darkScrim, darkFallbackFill]))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        },
    );

    it.each(CHROME_BACKDROP_EXTREMES)(
        'holds the floor for the light theme’s header glyph on the fallback over a %s screen',
        (backdrop) => {
            expect(glyphContrast(glyphOnLight, backdrop, [lightScrim, lightFallbackFill]))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        },
    );

    it('holds the floor on the scrim alone, which is the layer the app controls', () => {
        // The harder case, and the one that decides whether these screens are
        // safe. On the material the control has no opaque fill to hide behind,
        // so the scrim is the only layer between a white settings list and a
        // white glyph. UIGlassEffect's own fill sits on top of this and can
        // only help; it is not modelled, because what `regular` paints is
        // Apple's and it changes between releases.
        for (const backdrop of CHROME_BACKDROP_EXTREMES) {
            expect(glyphContrast(glyphOnDark, backdrop, [darkScrim]))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
            expect(glyphContrast(glyphOnLight, backdrop, [lightScrim]))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        }
    });

    it.each([
        ['light', '#000000', '#FFFFFF'],
        ['dark', '#FFFFFF', '#000000'],
    ])('keeps the floating add button legible on the %s theme by carrying its own tint', (_theme, fill, glyph) => {
        // colors.fab.background / colors.fab.icon. The button is a prominent
        // action with a colour of its own, so the colour travels on to the
        // material as UIGlassEffect.tintColor and becomes the fallback's fill.
        // Without it the light theme drew a WHITE glyph on the shared chrome
        // fill, which is the second measurement below.
        for (const backdrop of CHROME_BACKDROP_EXTREMES) {
            expect(glyphContrast(glyph, backdrop, [fill]))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        }
    });

    it('records the two white-on-white glyphs this ticket had to repaint', () => {
        // Both were already invisible before the conversion and stayed
        // invisible through it, which is why they are measured rather than
        // looked at. The voice pill's mic was a hardcoded #FFFFFF with no
        // plate under it, and the friends header button used
        // colors.button.primary.tint, which is #FFFFFF on BOTH themes because
        // it is the colour of text on a black filled button.
        expect(glyphContrast('#FFFFFF', '#FFFFFF', [lightFallbackFill]))
            .toBeLessThan(CHROME_CONTRAST_FLOOR);
        // Both carry colors.header.tint now, which clears the floor over the
        // fallback and over the scrim alike.
        for (const backdrop of CHROME_BACKDROP_EXTREMES) {
            expect(glyphContrast(glyphOnLight, backdrop, [lightScrim, lightFallbackFill]))
                .toBeGreaterThanOrEqual(CHROME_CONTRAST_FLOOR);
        }
    });

    it('says why the scrim is strong enough, in the alpha the fill needs', () => {
        // The design constraint behind the assertion above, stated as a number
        // rather than as a pass. A dark-theme control needs its own layer at
        // this alpha before a white glyph is guaranteed 3:1 no matter what is
        // behind it; the strong scrim at rest lands above it with room to
        // spare, which is why the header does not need an opaque bar.
        expect(colorAlpha(darkScrim)).toBeGreaterThanOrEqual(
            minimumFillAlpha(glyphOnDark, '#000000'),
        );
        expect(colorAlpha(lightScrim)).toBeGreaterThanOrEqual(
            minimumFillAlpha(glyphOnLight, '#FFFFFF'),
        );
        // Both are the STRONG scrim at rest. The subtle variant is not enough
        // on its own, which is why the navigation header always asks for the
        // strong one.
        expect(colorAlpha(darkScrim)).toBeCloseTo(0.44, 3);
        expect(colorAlpha(lightScrim)).toBeCloseTo(0.608, 3);
    });
});

describe('the header, checked against DROVE-180 rather than changed by it', () => {
    // DROVE-180 asks for the same treatment on the header and the status strip
    // "wherever they mask content today". Measured, the header does not mask.
    // MobileHeaderScrim is a dim gradient over a live BlurView: content behind
    // it is blurred and dimmed, never erased, which is already what the ticket
    // asks the composer to become. So nothing was inverted here. What follows
    // is the measurement that says so, and the reason it must not be lowered.
    const darkPeak = 0.55;
    const lightPeak = 0.76;

    it('never reaches opaque at any strength, so content is always behind it', () => {
        for (const peak of [darkPeak, lightPeak]) {
            for (const strength of [
                MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY,
                MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY,
                MOBILE_HOME_SCRIM_OVERLAY_OPACITY,
            ]) {
                expect(peak * strength).toBeLessThan(1);
            }
        }
    });

    it('lets more than a quarter of the content through even at its strongest', () => {
        // Resting: 56% through on dark, 39% on light. Underlapped, when a
        // message is actually sliding beneath it: 47% and 27%. Those are the
        // numbers behind "the header already sees through".
        const through = (peak: number, strength: number) => 1 - peak * strength;
        expect(through(darkPeak, MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY)).toBeCloseTo(0.56, 2);
        expect(through(lightPeak, MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY)).toBeCloseTo(0.392, 3);
        expect(through(darkPeak, MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY)).toBeCloseTo(0.472, 3);
        expect(through(lightPeak, MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY)).toBeCloseTo(0.27, 2);
    });

    it('is load-bearing for the header glyphs, so it is not the composer’s tint', () => {
        // The one reason not to take the header down to the composer's
        // TRANSCRIPT_GLASS_ALPHA and be done. The header has no card of its
        // own under the pill and the back chevron, so this scrim IS the layer
        // that carries them; it already sits exactly at the fill floor. Lower
        // it and the glyphs go, which is the DROVE-153 measurement.
        const darkScrim = darkPeak * MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY;
        const lightScrim = lightPeak * MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY;
        expect(darkScrim).toBeGreaterThanOrEqual(minimumFillAlpha('#ffffff', '#000000'));
        expect(lightScrim).toBeGreaterThanOrEqual(minimumFillAlpha('#18171C', '#FFFFFF'));
    });

    it('feathers over 36pt, which is why the edge does not read as a bar', () => {
        // The header's own "softening at the material edge", and it predates
        // the ticket. Longer than the composer's 12pt rim ramp because the
        // header has no capsule to land on: the gradient IS its edge.
        expect(MOBILE_HEADER_EDGE_RAMP_POINTS).toBe(36);
    });
});
