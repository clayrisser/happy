/**
 * ONE COMPOSER, MOUNTED TWICE (DROVE-345).
 *
 * Clay, on the new-session sheet: "on the homepage it's not properly using
 * liquid glass and this input is not using our liquid glass input that we have
 * everywhere else."
 *
 * The screen he photographed was not missing a coat of paint, it was a SECOND
 * IMPLEMENTATION: `HomeDock` built its own surface, its own field, its own `+`,
 * three words for permission / model / effort and its own send disc, sharing
 * `agentInputLayout.ts`'s numbers with the chat and nothing else. That is why
 * DROVE-153, DROVE-266, DROVE-328, DROVE-331 and DROVE-343 each landed on the
 * chat's composer and left Home flat. A shared constant does not carry a
 * material.
 *
 * So this spec holds the SHAPE of the fix rather than any one of its pixels:
 * both screens mount `ComposerBubble`, and neither is allowed to reach past it
 * for the shell, the field's surface or the button row. It is a source scan for
 * the same reason `glassChromeScreens.test.ts` is one — the failure it exists
 * to catch is a call site quietly drawing its own version of a shared thing,
 * which no render of either screen in isolation can see.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = join(__dirname, '..');
const read = (relative: string) => readFileSync(join(sources, relative), 'utf8');

/** The two screens with a composer on them. */
const screens = {
    'the session screen': 'components/AgentInput.tsx',
    'the home screen': 'components/HomeDock.tsx',
} as const;

/**
 * What only the shared component may name.
 *
 * Each of these is a piece of the composer's SHAPE. A screen that imports one
 * is a screen that can draw a composer of its own, which is the state this
 * ticket is about.
 */
const sharedOnly = [
    // `COMPOSER_BUBBLE_TEXT_ROW_SURFACE` was here and is gone (DROVE-343,
    // second pass): the text row has no surface at all now, because one
    // mounted at rest draws at rest and Clay photographed it as a lighter
    // panel filling the field. What replaced it is the shell's press, scoped
    // in time by `resolveComposerShellInteractive`, and that is on the list.
    'resolveComposerShellInteractive',
    'COMPOSER_BUBBLE_TEXT_ROW_GEOMETRY',
    'COMPOSER_BUBBLE_ACTION_ROW_GEOMETRY',
    'COMPOSER_BUBBLE_SPACER_GEOMETRY',
    'COMPOSER_BUBBLE_GAP_GEOMETRY',
    'COMPOSER_BUBBLE_GEOMETRY',
    'resolveComposerBubbleSurfaceStyle',
];

describe('both screens render the one composer (DROVE-345)', () => {
    it('mounts `ComposerBubble` on each', () => {
        for (const [screen, file] of Object.entries(screens)) {
            expect(read(file), screen).toContain('<ComposerBubble');
        }
    });

    it('gives each the composer’s own controls, not a copy of them', () => {
        for (const [screen, file] of Object.entries(screens)) {
            const source = read(file);
            // The `+` and send: `GlassChromeButton` at the composer's size,
            // spending an opaque fill as `UIGlassEffect.tintColor` (DROVE-266).
            // Home drew a `BubblePressable` with a `backgroundColor`.
            expect(source, screen).toContain('<ComposerControlButton');
            // Permission, effort and the model: one interactive glass capsule
            // (DROVE-343), not three words in a row.
            expect(source, screen).toContain('<ComposerSessionControls');
        }
    });

    it('lets neither screen reach past it for the shape', () => {
        // The shell's geometry, the field's surface and the action row belong
        // to `ComposerBubble`. A screen that names one of them can draw a
        // composer of its own again, which is exactly how Home drifted.
        for (const [screen, file] of Object.entries(screens)) {
            const source = read(file);
            for (const name of sharedOnly) {
                expect(source.includes(name), `${screen} names ${name}`).toBe(false);
            }
        }
    });

    it('keeps the shape in the one file, so a change lands on both at once', () => {
        const shared = read('components/ComposerBubble.tsx');
        for (const name of sharedOnly) {
            expect(shared, name).toContain(name);
        }
    });

    /**
     * THE CAPSULE'S WIDTH RULE REACHES HOME FOR FREE (DROVE-353).
     *
     * Clay's complaint was photographed on the chat, and the fix is entirely in
     * the shared component and the shared resolver — the capsule takes the
     * row's slack, the spacer is mounted only where there is no capsule, and a
     * glyph segment is the `+` disc's own air. Home mounts the same
     * `ComposerBubble` and the same `ComposerSessionControls`, so it gets all
     * three without a line of its own. That is the claim, and this is it held:
     * neither screen may name the capsule's geometry, and both must take the
     * segment's width from the one constant.
     */
    it('gives Home the same capsule width rule as the chat, by mounting not copying', () => {
        for (const [screen, file] of Object.entries(screens)) {
            const source = read(file);
            // The segment's width from the shared constant, never a literal.
            expect(source, screen).toContain('MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH');
            expect(source, screen).toContain('segmentWidth={MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH}');
            // And the capsule's own flex belongs to the resolver, so a screen
            // cannot pin the capsule to its content again and put the band
            // back.
            for (const name of [
                'COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY',
                'COMPOSER_BUBBLE_SESSION_MODEL_SEGMENT_GEOMETRY',
            ]) {
                expect(source.includes(name), `${screen} names ${name}`).toBe(false);
            }
        }
        // The capsule is the row's flexible child and the spacer stands in for
        // it only when there is no capsule at all. Both facts live in the one
        // file, which is what makes them land on both screens at once.
        const shared = read('components/ComposerBubble.tsx');
        expect(shared).toContain('controls ? null : <View style={styles.spacer} />');
        const controls = read('components/ComposerSessionControls.tsx');
        expect(controls).toContain('COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY');
        expect(controls).toContain('COMPOSER_BUBBLE_SESSION_MODEL_SEGMENT_GEOMETRY');
    });

    /**
     * THE MATERIAL IS SPREAD, NEVER RESTATED.
     *
     * `COMPOSER_BUBBLE_SURFACE` may be named by a screen — Home's resting dock
     * pill wears it so the pill and the composer it opens into cannot drift —
     * but a screen writing `material="frosted"` for a composer is the failure
     * this ticket is about. `glassChromeScreens.test.ts` holds the registry of
     * every flat material left in the app and the reason each is allowed; this
     * is the narrower rule for the two screens with a composer on them.
     */
    it('leaves no composer on the flat material', () => {
        for (const [screen, file] of Object.entries(screens)) {
            expect(read(file), screen).not.toContain('material="frosted"');
        }
    });
});
