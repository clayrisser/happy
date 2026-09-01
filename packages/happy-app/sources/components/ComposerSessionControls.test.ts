/**
 * The composer's session capsule, mounted (DROVE-153, DROVE-176, DROVE-178,
 * DROVE-215).
 *
 * composerControlColour.spec.ts measures the colours and sessionPillLabel.spec.ts
 * pins the model's width budget. This is the render: that the three segments
 * come out in the order Clay asked for, that each opens its own picker on the
 * first tap and never a menu of the three (DROVE-111), and that the colour
 * each glyph is drawn in is the one the rule says it should be. The colour
 * half is the one that has to be a RENDER: the module can only say what it
 * hands out, and the call site is where a tint gets put back.
 *
 * The model's three assertions moved here from AgentInputStatusRow.test.ts
 * when DROVE-178 moved the segment.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => {
    vi.restoreAllMocks();
});

const { host } = vi.hoisted(() => ({
    host: (name: string) => (props: any) => React.createElement(name, props, props.children),
}));

vi.mock('react-native', () => ({
    StyleSheet: { hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View'),
}));

vi.mock('react-native-svg', () => ({
    default: host('Svg'),
    Circle: host('Circle'),
    Line: host('Line'),
    Path: host('Path'),
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: host('Ionicons') }));

// The theme is a knob, not a constant: the colour rule has to be shown on the
// light theme too, where "white" is #000000 (DROVE-215).
const { themeState } = vi.hoisted(() => ({ themeState: { dark: true } }));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { dark: themeState.dark, colors: { text: 'text', divider: 'divider', glass: {} } } }),
    StyleSheet: { create: (factory: any) => factory({ colors: { text: 'text', divider: 'divider', glass: {} } }) },
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./BubblePressable', () => ({ BubblePressable: host('BubblePressable') }));

const { ComposerSessionControls } = await import('./ComposerSessionControls');
const {
    COMPOSER_CONTROL_PALETTE,
    composerCapsuleDivider,
    composerGaugeTrack,
    composerSessionCapsuleFill,
} = await import('./composerControlColour');

const palette = COMPOSER_CONTROL_PALETTE.dark;

/** Last colour wins, the way RN flattens a style array. */
function flatColour(style: any): string | undefined {
    const parts = Array.isArray(style) ? style : [style];
    let colour: string | undefined;
    for (const part of parts) if (part && part.color !== undefined) colour = part.color;
    return colour;
}
function mount(overrides: Record<string, unknown> = {}) {
    let renderer: any;
    act(() => {
        renderer = create(React.createElement(ComposerSessionControls, {
            label: { mode: 'Yolo', model: 'Opus 5 1M', effort: 'High', text: '' },
            modeKind: 'yolo',
            effortIndex: 3,
            effortCount: 6,
            onPress: () => {},
            ...overrides,
        } as any));
    });
    return renderer;
}

function press(renderer: any, label: string) {
    return renderer.root.findAll(
        (node: any) => typeof node.type === 'string' && node.props?.accessibilityLabel === label,
    )[0];
}

describe('the session capsule', () => {
    it('is mode, effort and model in that order, inside one surface (DROVE-178)', () => {
        const renderer = mount();
        const labels = renderer.root.findAll(
            (node: any) => typeof node.type === 'string' && !!node.props?.accessibilityLabel,
        ).map((node: any) => node.props.accessibilityLabel);
        expect(labels).toEqual(['Permission mode', 'Reasoning effort', 'Model']);
    });

    /**
     * THE CAPSULE IS AN OPAQUE FILL, NOT GLASS (DROVE-254).
     *
     * DROVE-153 gave it a `GlassChromeSurface`, which was right while it sat
     * outside the bubble on the dock scrim. DROVE-236 moved it inside the
     * bubble, which is itself a `UIGlassEffect`, and glass nested in glass has
     * nothing left to refract. Clay: "This blends in which is annoying."
     * composerControlColour.spec.ts measures the value; this is the half only
     * a render can show, that the call site does not put the glass back.
     */
    it('draws itself on the row\u2019s own fill rather than on a second glass surface', () => {
        const renderer = mount();
        expect(renderer.root.findAllByType('GlassChromeSurface' as any)).toEqual([]);
        const capsule = renderer.root.findAllByType('View' as any)
            .find((node: any) => {
                const parts = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
                return parts.some((part: any) => part?.backgroundColor === composerSessionCapsuleFill(true));
            });
        expect(capsule).toBeTruthy();
    });

    it('draws its dividers in the measured hairline, never the list rule (DROVE-254)', () => {
        // `theme.colors.glass.divider` measures 1.28:1 on that fill, which is
        // DROVE-227's gauge track again: not a dim line, no line.
        const renderer = mount();
        const rules = renderer.root.findAllByType('View' as any)
            .filter((node: any) => (Array.isArray(node.props.style) ? node.props.style : [node.props.style])
                .some((part: any) => part?.width === 1));
        expect(rules).toHaveLength(2);
        for (const rule of rules) {
            const parts = Array.isArray(rule.props.style) ? rule.props.style : [rule.props.style];
            const colour = parts.reduce((found: any, part: any) => part?.backgroundColor ?? found, undefined);
            expect(colour).toBe(composerCapsuleDivider(true));
        }
    });

    it('spells the model out in full, and never gains an ellipsis (DROVE-138, DROVE-178)', () => {
        const renderer = mount({ label: { mode: 'Yolo', model: 'Opus 5 1M', effort: 'High', text: '' } });
        const text = renderer.root.findAllByType('Text' as any)
            .find((node: any) => node.props.children === 'Opus 5 1M');
        expect(text).toBeTruthy();
        expect(text.props.ellipsizeMode).toBeUndefined();
        // Smaller before shorter: the failure DROVE-138 was filed about was
        // `Opus 5...`, so the segment scales the type instead of cutting it.
        expect(text.props.adjustsFontSizeToFit).toBe(true);
        // 0.80 since DROVE-236 moved the capsule into the bubble and took 33pt
        // off the name's budget. The floor is derived, not chosen: it is what
        // `Opus 4.8 1M` needs to draw WHOLE at 320. sessionPillLabel.spec.ts
        // runs the arithmetic.
        expect(text.props.minimumFontScale).toBe(0.8);
    });

    /**
     * THE CAPSULE TAKES ITS SIZE FROM THE ROW IT IS ON (DROVE-236).
     *
     * 44 on a row of its own, which is what Home draws. 36 inside the chat
     * bubble's button row, so it is the same height as the discs either side
     * of it and the bubble does not grow to hold it.
     */
    it('sizes to the row it is drawn on, and slops vertically only', () => {
        const at = (size?: number) => {
            const renderer = mount(size === undefined ? {} : { size, verticalSlop: 6 });
            const pressables = renderer.root.findAllByProps({ accessibilityRole: 'button' })
                .filter((node: any) => typeof node.type !== 'string');
            return pressables;
        };
        // Default: the 44 it has always been.
        const wide = at();
        expect(wide.length).toBeGreaterThan(0);
        // In the bubble: 36, with slop on the vertical axis and NONE on the
        // horizontal, because these segments sit against each other inside one
        // capsule and a segment claiming horizontal slop would be claiming its
        // neighbour's ink.
        const narrow = at(36);
        for (const node of narrow) {
            expect(node.props.hitSlop).toEqual({ top: 6, bottom: 6, left: 0, right: 0 });
        }
    });

    it('opens the model picker on the first tap, never a menu of the three (DROVE-111)', () => {
        const opened: string[] = [];
        const renderer = mount({ onPress: (picker: string) => opened.push(picker) });
        act(() => {
            press(renderer, 'Model').props.onPress();
        });
        expect(opened).toEqual(['model']);
    });

    it('opens all three as sheets, and anchors nothing as a native menu (DROVE-242)', () => {
        // Clay, with the mode menu open: "Shouldn't these show in sheets like
        // the effort does". Mode and model were SwiftUI menus here on iOS, so
        // a press never reached `onPress` and composerPicker.ts never knew
        // they were up, which is why a second tap on the control could not
        // close them. Every segment reports its picker now, and the file has
        // no platform test left to make it do otherwise.
        const opened: string[] = [];
        const renderer = mount({ onPress: (picker: string) => opened.push(picker) });
        for (const label of ['Permission mode', 'Reasoning effort', 'Model']) {
            act(() => {
                press(renderer, label).props.onPress();
            });
        }
        expect(opened).toEqual(['permission', 'effort', 'model']);
        expect(renderer.root.findAllByType('NativeSettingsMenu' as any)).toEqual([]);
    });

    it('keeps the pressed control reading as open while its sheet is up', () => {
        // The one thing the native menu could not do: the control had no idea
        // it was open, because UIKit owned the presentation. `openPicker` is
        // the same state the sheet is drawn from, so both halves agree.
        for (const [picker, label] of [['permission', 'Permission mode'], ['model', 'Model']] as const) {
            const renderer = mount({ openPicker: picker });
            expect(press(renderer, label).props.accessibilityState?.expanded, picker).toBe(true);
        }
    });

    it('reads a mode or a model pick as pending until the pane confirms it (DROVE-217)', () => {
        // The sheet writes through the same `onPermissionModeChange` and
        // `onModelModeChange` the native menu called, so the wait is unchanged
        // by DROVE-242. But the wait is the half Clay sees, and mode and model
        // lag exactly as effort does, so it is pinned for all three here rather
        // than for effort alone.
        const glyph = (pending: any) => mount({ pending }).root.findByType('Ionicons' as any).props.color;
        expect(glyph({ permission: true })).toBe(palette.pending);
        expect(glyph(null)).toBe(palette.foreground);
        const name = (pending: any) => flatColour(mount({ pending }).root.findAllByType('Text' as any)
            .find((node: any) => node.props.children === 'Opus 5 1M').props.style);
        expect(name({ model: true })).toBe(palette.pending);
        expect(name(null)).toBe('text');
        // And VoiceOver is told, since the colour reaches nobody there.
        const renderer = mount({ pending: { permission: true, model: true } });
        expect(press(renderer, 'Permission mode').props.accessibilityValue.text)
            .toBe('Yolo, not confirmed by the terminal yet');
        expect(press(renderer, 'Model').props.accessibilityValue.text)
            .toBe('Opus 5 1M, not confirmed by the terminal yet');
    });

    it('does not press a field this session will not take a pick for', () => {
        // A segment with no handler behind it is drawn and inert, which is how
        // a rig that fixes its model still shows which one it is running.
        const renderer = mount({ canOpen: { permission: true, effort: true, model: false } });
        expect(press(renderer, 'Model').props.onPress).toBeUndefined();
        expect(press(renderer, 'Permission mode').props.onPress).toBeTypeOf('function');
    });

    it('draws the capsule without the model when the session has no name for one', () => {
        const renderer = mount({ label: { mode: 'Yolo', model: null, effort: 'High', text: '' } });
        expect(press(renderer, 'Model')).toBeUndefined();
        // Two segments and the one hairline between them, never a divider
        // floating at the end where a third used to be.
        expect(renderer.root.findAllByType('View' as any)
            .filter((node: any) => (Array.isArray(node.props.style) ? node.props.style : [node.props.style])
                .some((part: any) => part?.width === 1))).toHaveLength(1);
    });
});

/**
 * The RENDERED colour of every glyph in the capsule (DROVE-176, DROVE-215).
 *
 * This is where the rule is actually pinned. composerControlColour.spec.ts can
 * say the module hands out the foreground; only a render can say the row does,
 * because the row is where a tint would be put back.
 */
describe('the colour each glyph is drawn in (DROVE-176, DROVE-215)', () => {
    it('draws the padlock, the shield and the eye in the row’s foreground, whatever the mode', () => {
        // Clay: "I told you to do white for the color of all the icons." The
        // mode is a value the session holds, not a thing it is doing, so it
        // buys no colour. The SHAPE still separates them, which is the trade
        // DROVE-141 made and DROVE-176 promised to keep good for.
        const glyph = (modeKind: string) => mount({ modeKind }).root.findByType('Ionicons' as any).props;
        expect(glyph('yolo').name).toBe('lock-open-outline');
        expect(glyph('default').name).toBe('lock-closed-outline');
        expect(glyph('safe-yolo').name).toBe('shield-checkmark-outline');
        expect(glyph('read-only').name).toBe('eye-outline');
        for (const mode of ['yolo', 'bypassPermissions', 'safe-yolo', 'read-only', 'plan', 'acceptEdits', 'default']) {
            expect(glyph(mode).color, mode).toBe(palette.foreground);
        }
    });

    /**
     * AUTO-ACCEPT IS THE ONE STATE THAT COLOURS THE PADLOCK (DROVE-277), and
     * pinning it in a RENDER matters more here than anywhere else on the row:
     * the colour is the only sighted carrier of a state whose cost of being
     * missed is a command running unasked.
     */
    it('draws the padlock in the accent while auto-accept is on, and keeps the mode’s own shape', () => {
        const glyph = (modeKind: string, autoAccept: boolean) =>
            mount({ modeKind, autoAccept }).root.findByType('Ionicons' as any).props;
        for (const mode of ['yolo', 'safe-yolo', 'read-only', 'plan', 'acceptEdits', 'default']) {
            // Off is unchanged: DROVE-215's rule still holds for the mode.
            expect(glyph(mode, false).color, mode).toBe(palette.foreground);
            expect(glyph(mode, true).color, mode).toBe(palette.accent);
            // And the SILHOUETTE is the same either way, so the row never
            // misreports which mode the session is in to say it is auto-
            // accepting.
            expect(glyph(mode, true).name, mode).toBe(glyph(mode, false).name);
        }
    });

    it('says auto-accept in words as well as in colour, for the reader the hue never reaches', () => {
        const value = (autoAccept: boolean) => mount({ modeKind: 'yolo', autoAccept })
            .root.findAll((node: any) => node.props?.accessibilityLabel === 'Permission mode')[0]
            .props.accessibilityValue;
        // The mode is still the subject of the announcement; auto-accept
        // qualifies it rather than replacing it, so VoiceOver reads
        // "Permission mode, Yolo, auto-accept on" and not a bare state with
        // nothing to attach it to.
        const mode = value(false);
        expect(mode).toBeTruthy();
        expect(value(true)).toBe(`${mode}, auto-accept on`);
    });

    it('draws the needle in the foreground at every level, so nothing is a ramp any more', () => {
        const needle = (index: number) => mount({ effortIndex: index }).root
            .findByType('Line' as any).props.stroke;
        for (let level = 0; level < 6; level += 1) {
            expect(needle(level), `level ${level}`).toBe(palette.foreground);
        }
    });

    it('draws the dial’s arc under the needle at every level, not in the list divider', () => {
        // DROVE-227. The needle was already the foreground; the TRACK was
        // `theme.colors.divider`, which measures 1.05:1 on this glass, so the
        // gauge read as a lone diagonal. composerControlColour.spec.ts holds
        // the two contrast floors; this is the half only a render can show,
        // that the call site actually passes the token.
        const arc = (index: number) => mount({ effortIndex: index }).root
            .findByType('Path' as any).props.stroke;
        for (let level = 0; level < 6; level += 1) {
            expect(arc(level), `level ${level}`).toBe(composerGaugeTrack(true));
            expect(arc(level), `level ${level}`).not.toBe('divider');
            // And it is not the needle's own colour, which is the other way
            // this breaks: one solid shape with no mark in it.
            expect(arc(level), `level ${level}`).not.toBe(palette.foreground);
        }
    });

    it('leaves the model on the foreground too, because a name is not a state', () => {
        // The style is an ARRAY since DROVE-217: the base style, then the
        // pending colour when a pick is in flight. Flattened, so this keeps
        // asserting the resting colour rather than the array's shape.
        const text = mount().root.findAllByType('Text' as any)
            .find((node: any) => node.props.children === 'Opus 5 1M');
        expect(flatColour(text.props.style)).toBe('text');
    });

    it('does the same on the light theme, where the foreground is #000000 rather than white', () => {
        // Same rule, other theme. The token is the row's FOREGROUND, so light
        // gets the theme's own text colour instead of a literal white that
        // would vanish on it.
        themeState.dark = false;
        try {
            const light = COMPOSER_CONTROL_PALETTE.light;
            expect(light.foreground).toBe('#000000');
            for (const mode of ['yolo', 'safe-yolo', 'read-only', 'default']) {
                expect(mount({ modeKind: mode }).root.findByType('Ionicons' as any).props.color, mode)
                    .toBe(light.foreground);
            }
            for (let level = 0; level < 6; level += 1) {
                const gauge = mount({ effortIndex: level }).root;
                expect(gauge.findByType('Line' as any).props.stroke, `level ${level}`)
                    .toBe(light.foreground);
                // The arc follows the theme too, at the light theme's own
                // alpha over its own glass (DROVE-227).
                expect(gauge.findByType('Path' as any).props.stroke, `level ${level}`)
                    .toBe(composerGaugeTrack(false));
            }
        } finally {
            themeState.dark = true;
        }
    });

    it('draws the whole capsule in one colour, which is what Clay asked for', () => {
        // The capsule the ticket was filed against had a purple shield and a
        // pink needle a few points from three plain white glyphs. One assertion
        // that the two capsules now speak the same vocabulary.
        const renderer = mount({ modeKind: 'safe-yolo', effortIndex: 5 });
        const shield = renderer.root.findByType('Ionicons' as any).props.color;
        const stroke = renderer.root.findByType('Line' as any).props.stroke;
        expect(new Set([shield, stroke, palette.foreground]).size).toBe(1);
    });
});

/**
 * The effort segment is a PRESS, like the two beside it (DROVE-242).
 *
 * DROVE-200 made it a raw JS responder driving a drag, and DROVE-229 left that
 * drag alongside the sheet a tap opened. Clay, with a screenshot of the drag's
 * readout over his field: "Why does it show the old shitty slider when I hold
 * down effort?" The responder entered its drag on touch-DOWN, so a hold raised
 * it. It is deleted; what a render can show is that nothing of it is left.
 */
describe('the effort segment after the drag was deleted', () => {
    it('opens the sheet on a press, exactly as the mode and the model do', () => {
        const opened: string[] = [];
        const renderer = mount({ onPress: (picker: string) => opened.push(picker) });
        act(() => {
            press(renderer, 'Reasoning effort').props.onPress();
        });
        expect(opened).toEqual(['effort']);
    });

    it('has no responder left, so no gesture can raise a second surface', () => {
        // The exact handlers that made a hold draw the readout. A press cannot
        // raise anything now, which is the guarantee the whole ticket rests on:
        // no gesture on any picker leaves a surface up that a second press
        // cannot dismiss.
        const segment = press(mount(), 'Reasoning effort');
        for (const handler of [
            'onResponderGrant',
            'onResponderMove',
            'onResponderRelease',
            'onResponderTerminate',
            'onResponderTerminationRequest',
            'onStartShouldSetResponder',
            'onMoveShouldSetResponder',
            'onAccessibilityAction',
        ]) {
            expect(segment.props[handler], handler).toBeUndefined();
        }
        // A button, not an adjustable: there is no slider to adjust, and the
        // levels are radio rows on the sheet (AgentInput).
        expect(segment.props.accessibilityRole).toBe('button');
    });

    it('draws no readout of its own, and there is none left to draw', () => {
        // DROVE-229 moved the readout out to the control row because it spans
        // the composer; DROVE-242 deleted it there. Neither surface has one.
        const renderer = mount();
        expect(renderer.root.findAllByType('EffortSliderPopover' as any)).toEqual([]);
    });

    it('points the needle at the session\u2019s own level, with no thumb to follow', () => {
        // The dial was never the slider. It still reads the level as an ANGLE
        // (DROVE-101, DROVE-141), and it no longer has a live drag index that
        // could disagree with it.
        const needle = (index: number) => mount({ effortIndex: index }).root.findByType('Line' as any).props;
        expect(needle(5).x2).toBeGreaterThan(needle(0).x2);
    });

    it('draws a pending effort as pending, with no drag left to outrank it', () => {
        // This used to be conditional: a finger on the slider outranked the
        // wait, because the thumb was a value nobody had asked for yet. With
        // no drag there is one rule, the same one mode and model follow.
        const needle = (pending: any) => mount({ pending }).root.findByType('Line' as any).props.stroke;
        expect(needle({ effort: true })).toBe(palette.pending);
        expect(needle(null)).toBe(palette.foreground);
    });
});
