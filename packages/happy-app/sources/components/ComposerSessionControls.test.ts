/**
 * The composer's session capsule, mounted (DROVE-153, DROVE-176, DROVE-178,
 * DROVE-215).
 *
 * composerControlColour.spec.ts measures the colours and sessionPillLabel.spec.ts
 * pins the model's width budget. This is the render: that the segments come
 * out in the order Clay asked for — lock, speaker, effort, model since
 * DROVE-331 sent the auto-accept bolt back to the sheet — that each of the
 * three pickers opens its own on the first tap and never a menu of them
 * (DROVE-111), that read-aloud opens nothing at all (DROVE-284), and that the
 * colour each glyph is drawn in is the one the rule says it should be. The
 * colour half is the one that has to be a RENDER: the module can only say
 * what it hands out, and the call site is where a tint gets put back.
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
const { MOBILE_COMPOSER_SEGMENT_FILL_INSET, MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH } = await import('./agentInputLayout');
const {
    COMPOSER_CONTROL_PALETTE,
    autoAcceptColour,
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

/**
 * The glyph inside ONE segment (DROVE-281).
 *
 * There can be two Ionicons in the capsule — the padlock's and read-aloud's —
 * so `findByType` on the root is ambiguous and every colour assertion has to
 * name the segment it is about.
 */
function iconIn(renderer: any, label: string) {
    return press(renderer, label).findByType('Ionicons' as any).props;
}

function press(renderer: any, label: string) {
    return renderer.root.findAll(
        (node: any) => typeof node.type === 'string' && node.props?.accessibilityLabel === label,
    )[0];
}

describe('the session capsule', () => {
    it('is mode, effort and model in that order, inside one surface (DROVE-178)', () => {
        const labels = (renderer: any) => renderer.root.findAll(
            (node: any) => typeof node.type === 'string' && !!node.props?.accessibilityLabel,
        ).map((node: any) => node.props.accessibilityLabel);
        expect(labels(mount())).toEqual(['Permission mode', 'Reasoning effort', 'Model']);
        // AND NO AUTO-ACCEPT SEGMENT, WHATEVER THE STATE (DROVE-331). DROVE-281
        // drew a bolt second, touching the padlock; Clay, with it and the
        // sheet's switch both on his phone: "because of the toggles in the
        // sheet for auto-accept, we don't need it also in the bar group." The
        // state is the padlock's to wear now, not a segment's.
        expect(labels(mount({ autoAccept: true }))).toEqual(['Permission mode', 'Reasoning effort', 'Model']);
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
        // TWO FOR THREE SEGMENTS, one between every pair. DROVE-281's bolt
        // joined without a rule because it touched the padlock; it is gone
        // (DROVE-331) and the state it carried does not add a segment, so
        // auto-accept ON draws the same two rules. The count is asserted
        // rather than the absence, because a third rule appearing is exactly
        // how a segment would come back without anything else failing.
        const withBolt = mount({ autoAccept: true });
        expect(withBolt.root.findAllByType('View' as any)
            .filter((node: any) => (Array.isArray(node.props.style) ? node.props.style : [node.props.style])
                .some((part: any) => part?.width === 1))).toHaveLength(2);
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
        // DROVE-141 made and DROVE-176 promised to keep good for. Auto-accept
        // is off here, which is every session at launch; on, the padlock is
        // the one exception (below).
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
     * AUTO-ACCEPT COLOURS THE PADLOCK AND NOTHING ELSE (DROVE-277, DROVE-331),
     * and pinning it in a RENDER matters more here than anywhere else on the
     * row: the colour is a sighted carrier of a state whose cost of being
     * missed is a command running unasked.
     *
     * DROVE-277 put this colour on the padlock because the switch was a row
     * inside the padlock's sheet and nothing else on the row could carry the
     * state. DROVE-281 moved it to a bolt segment beside the padlock. DROVE-331
     * took the bolt off the row on Clay's word — the sheet's switch is the one
     * control — so the padlock carries it again, for DROVE-277's reason: it is
     * the only object on the row that can, and it opens the sheet where the
     * bit is set.
     */
    it('draws the padlock in the accent while auto-accept is on, in every mode (DROVE-277, DROVE-331)', () => {
        for (const mode of ['yolo', 'safe-yolo', 'read-only', 'plan', 'acceptEdits', 'default']) {
            expect(iconIn(mount({ modeKind: mode, autoAccept: false }), 'Permission mode').color, `${mode}/off`)
                .toBe(palette.foreground);
            expect(iconIn(mount({ modeKind: mode, autoAccept: true }), 'Permission mode').color, `${mode}/on`)
                .toBe(palette.accent);
        }
        // NOT A NEW HUE: the same accent send wears with something to send.
        expect(iconIn(mount({ autoAccept: true }), 'Permission mode').color)
            .toBe(autoAcceptColour(palette, true));
        // The SILHOUETTE is the same either way, so the row never misreports
        // which mode the session is in to say it is auto-accepting; the words
        // carry the state for a reader the hue never reaches (below).
        const shape = (autoAccept: boolean) =>
            iconIn(mount({ modeKind: 'yolo', autoAccept }), 'Permission mode').name;
        expect(shape(true)).toBe(shape(false));
        // And a pending pick outranks it, as it does every colour on the row
        // (DROVE-217): the wait is the thing Clay sees.
        expect(iconIn(mount({ autoAccept: true, pending: { permission: true } }), 'Permission mode').color)
            .toBe(palette.pending);
        // Nothing else on the row takes the state: the gauge stays on the
        // foreground while auto-accept is on.
        expect(mount({ autoAccept: true }).root.findByType('Line' as any).props.stroke)
            .toBe(palette.foreground);
    });

    it('draws no auto-accept segment at all, whatever it is handed (DROVE-331)', () => {
        // DROVE-281's bolt: a fourth segment touching the padlock, a switch to
        // a screen reader, one tap to flip. Gone, because the sheet behind the
        // padlock has the same switch and Clay does not want the bit in two
        // places. Absent rather than drawn-and-dead, and absent with the state
        // ON and with a stray toggle handler, which are the two things a
        // leftover branch would draw on.
        for (const overrides of [{}, { autoAccept: true }, { autoAccept: true, onToggleAutoAccept: () => {} }]) {
            expect(press(mount(overrides), 'Auto-accept')).toBeUndefined();
            expect(mount(overrides).root.findAll(
                (node: any) => typeof node.type === 'string' && node.props?.accessibilityRole === 'switch',
            )).toEqual([]);
            expect(mount(overrides).root.findAllByType('Ionicons' as any)
                .map((node: any) => node.props.name)
                .filter((name: string) => name.includes('flash'))).toEqual([]);
        }
        // The padlock is still a button that expands, not a switch: the state
        // it wears is not a state it flips.
        const lock = press(mount({ autoAccept: true }), 'Permission mode');
        expect(lock.props.accessibilityRole).toBe('button');
        expect(lock.props.accessibilityState.checked).toBeUndefined();
        expect(lock.props.accessibilityState.expanded).toBe(false);
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

/**
 * READ-ALOUD, MOVED INTO THE CAPSULE (DROVE-284).
 *
 * Clay, rejecting the second row DROVE-281 bought with: "Dude I don't like that
 * extra row. Add the reading mode whatever thing to the group and keep it all on
 * the same row as send and +."
 *
 * The arithmetic of the move is sessionPillLabel.spec.ts's. This is the half
 * only a render can show: that the control arrived with EVERYTHING it had on
 * the row — four faces on two carriers, the amber pause DROVE-258 built, and
 * the long press DROVE-233/275 gave it — rather than arriving as a glyph that
 * happens to sit in the right place.
 */
describe('read-aloud as a capsule segment', () => {
    /**
     * The segment's style is a FUNCTION of the press state, the way
     * `BubblePressable` takes it, so a test that read `props.style` as an array
     * would silently see nothing. Resolved at rest, which is the face at issue.
     */
    const stylePartsOf = (node: any) => {
        const style = typeof node.props.style === 'function'
            ? node.props.style({ pressed: false })
            : node.props.style;
        return (Array.isArray(style) ? style : [style]).filter(Boolean);
    };

    const readAloud = (overrides: Record<string, unknown> = {}) => ({
        glyph: 'volume-high',
        fill: 'accent',
        on: true,
        accessibilityLabel: 'Read aloud',
        onPress: () => {},
        onLongPress: () => {},
        ...overrides,
    });

    it('sits second, between the padlock and the effort gauge', () => {
        // Third from DROVE-284 to DROVE-331, while the auto-accept bolt sat
        // between it and the padlock. Lock, speaker, effort, model now.
        const labels = mount({ autoAccept: true, readAloud: readAloud() })
            .root.findAll((node: any) => typeof node.type === 'string' && !!node.props?.accessibilityLabel)
            .map((node: any) => node.props.accessibilityLabel);
        expect(labels).toEqual([
            'Permission mode', 'Read aloud', 'Reasoning effort', 'Model',
        ]);
    });

    it('is absent where there is no reader, not drawn and dead', () => {
        // Absent rather than drawn-and-dead: a picker with nothing to pick
        // still SAYS what the session is set to, and a speaker with no reader
        // behind it says only that something is missing. An embedded or
        // disconnected chat has no reader.
        const labels = mount().root
            .findAll((node: any) => typeof node.type === 'string' && !!node.props?.accessibilityLabel)
            .map((node: any) => node.props.accessibilityLabel);
        expect(labels).not.toContain('Read aloud');
    });

    it('takes a THIRD hairline, one between every pair', () => {
        // Two rules became three, because the subject changes once more:
        // permission -> read-aloud -> effort -> the name. Four segments, three
        // rules, and nothing touching: the padlock and the bolt were the pair
        // that did (DROVE-281) and the bolt is gone (DROVE-331), so a segment
        // with no rule beside it would be the bolt coming back.
        const rules = (renderer: any) => renderer.root.findAllByType('View' as any)
            .filter((node: any) => (Array.isArray(node.props.style) ? node.props.style : [node.props.style])
                .some((part: any) => part?.width === 1));
        expect(rules(mount({ readAloud: readAloud() }))).toHaveLength(3);
        expect(rules(mount({ autoAccept: true, readAloud: readAloud() }))).toHaveLength(3);
        expect(rules(mount())).toHaveLength(2);
        // And a rule directly follows the padlock: segments and hairlines in
        // tree order alternate, starting and ending on a segment.
        const ordered = mount({ readAloud: readAloud() }).root
            .findAll((node: any) => typeof node.type === 'string' && (
                !!node.props?.accessibilityLabel
                || (Array.isArray(node.props.style) ? node.props.style : [node.props.style])
                    .some((part: any) => part?.width === 1)
            ))
            .map((node: any) => node.props.accessibilityLabel ?? '|');
        expect(ordered).toEqual(['Permission mode', '|', 'Read aloud', '|', 'Reasoning effort', '|', 'Model']);
    });

    /**
     * THE STATE TABLE, INTACT (DROVE-236, DROVE-258).
     *
     *    normal    slashed speaker, no fill
     *    paused    PAUSE BARS, amber fill
     *    reading   speaker with waves, accent fill
     *    boss      speaker, recording fill
     *
     * Every pair differs in both carriers except normal and boss, which differ
     * in the fill and are never confusable anyway: one is silent and the other
     * has a call up.
     */
    /**
     * THE FILL IS AN INSET PILL, NOT THE SEGMENT'S OWN BACKGROUND (DROVE-284
     * refinement). Clay's photo showed the shipped fill square to the
     * capsule's rims; the pill is the disc's vocabulary kept at segment
     * scale, and `MOBILE_COMPOSER_SEGMENT_FILL_INSET` carries the renders
     * that settled it. So the face's colour is read off the PILL — a child
     * View of the pressable — and the pressable itself must carry no
     * backgroundColor at all, which is asserted so the full-bleed fill
     * cannot quietly come back.
     */
    const pillOf = (segment: any) => segment.findAll((node: any) =>
        node.type === 'View'
        && (Array.isArray(node.props.style) ? node.props.style : [node.props.style])
            .some((part: any) => part?.borderRadius !== undefined && part?.backgroundColor !== undefined))[0];

    it('draws all four faces, glyph and pill, exactly as the disc did', () => {
        const faceOf = (fill: string, glyph: string) => {
            const renderer = mount({ readAloud: readAloud({ fill, glyph }) });
            const segment = press(renderer, 'Read aloud');
            const parts = stylePartsOf(segment);
            const pill = pillOf(segment);
            return {
                glyph: segment.findByType('Ionicons' as any).props.name,
                colour: segment.findByType('Ionicons' as any).props.color,
                fill: (Array.isArray(pill.props.style) ? pill.props.style : [pill.props.style])
                    .reduce((found: any, part: any) => part?.backgroundColor ?? found, undefined),
                // The PRESSABLE never wears the fill: that was the full-bleed
                // face Clay photographed, and it must fail here if it returns.
                pressableFill: parts.reduce((found: any, part: any) => part?.backgroundColor ?? found, undefined),
            };
        };
        // Off, the pill is MOUNTED and transparent rather than absent, so a
        // face swap under a finger recolours a view instead of mounting one —
        // DROVE-286's unmount-under-the-finger lesson, honoured before it can
        // bite on this segment.
        expect(faceOf('none', 'volume-mute'))
            .toEqual({ glyph: 'volume-mute', colour: palette.foreground,
                fill: 'transparent', pressableFill: undefined });
        expect(faceOf('accent', 'volume-high'))
            .toEqual({ glyph: 'volume-high', colour: '#FFFFFF',
                fill: palette.accent, pressableFill: undefined });
        expect(faceOf('recording', 'volume-high'))
            .toEqual({ glyph: 'volume-high', colour: '#FFFFFF',
                fill: palette.recording, pressableFill: undefined });
        // PAUSED IS THE ONE THAT HAD TO SURVIVE THE MOVE (DROVE-258). Clay:
        // "When I long press read and it pauses color it I dunno pause colour
        // maybe yellow or orange and show pause icon." Amber fill, pause bars,
        // and the tint FLIPS to black because white on the dark theme's amber
        // measures about 2:1 — the exact bug a copied ternary would have
        // shipped.
        expect(faceOf('paused', 'pause'))
            .toEqual({ glyph: 'pause', colour: '#000000',
                fill: palette.pending, pressableFill: undefined });
    });

    it('insets the pill 1 off each hairline and 3 off the rim, a stadium', () => {
        // The chat's segment, taken from the constant the chat actually hands
        // in rather than a literal beside it: 27 wide since DROVE-320, 39
        // tall, so the pill is 25 x 33 with a 13pt radius, and `volume-high`,
        // the widest everyday glyph, keeps 3.75pt of fill beyond its 17.5pt of
        // ink. A number typed here instead is how a green suite ends up
        // asserting a segment the row does not draw.
        const renderer = mount({
            size: 39,
            segmentWidth: MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
            readAloud: readAloud({ fill: 'accent' }),
        });
        const pill = pillOf(press(renderer, 'Read aloud'));
        const box = (Array.isArray(pill.props.style) ? pill.props.style : [pill.props.style])
            .reduce((found: any, part: any) => ({
                width: part?.width ?? found.width,
                height: part?.height ?? found.height,
                borderRadius: part?.borderRadius ?? found.borderRadius,
            }), {});
        expect(box).toEqual({
            width: MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH
                - 2 * MOBILE_COMPOSER_SEGMENT_FILL_INSET.horizontal,
            height: 39 - 2 * MOBILE_COMPOSER_SEGMENT_FILL_INSET.vertical,
            // A stadium: half the SHORT axis, which the renderer derives as
            // `Math.min(pill.width, pill.height) / 2`. 12.5 at a 27pt segment
            // where it was 13 at 28 — it follows the segment rather than being
            // a number typed once.
            borderRadius: Math.min(
                MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH
                    - 2 * MOBILE_COMPOSER_SEGMENT_FILL_INSET.horizontal,
                39 - 2 * MOBILE_COMPOSER_SEGMENT_FILL_INSET.vertical,
            ) / 2,
        });
        expect(box.borderRadius).toBe(12.5);
        expect(box.width).toBe(25);
        // The fill still clears `volume-high`'s 17.5pt of ink on both sides.
        expect((box.width - 20 * 0.875) / 2).toBeCloseTo(3.75, 3);
        expect(MOBILE_COMPOSER_SEGMENT_FILL_INSET).toEqual({ horizontal: 1, vertical: 3 });
        // And the glyph is INSIDE the pill, so the pill centres it exactly as
        // the segment centred it — nothing moved but where the colour stops.
        expect(pill.findByType('Ionicons' as any).props.name).toBe('volume-high');
        // The three segments with no fill state mount no pill at all.
        for (const label of ['Permission mode', 'Reasoning effort', 'Model']) {
            expect(pillOf(press(renderer, label)), label).toBeUndefined();
        }
    });

    it('keeps the long press, which is pause, resume and boss mode', () => {
        // DROVE-233/275's second gesture, and the one thing a move like this
        // silently drops. The segment is a Pressable like the disc was, so the
        // handler is wired rather than reasoned about.
        const pressed: string[] = [];
        const renderer = mount({
            readAloud: readAloud({
                onPress: () => pressed.push('press'),
                onLongPress: () => pressed.push('long'),
            }),
        });
        const segment = press(renderer, 'Read aloud');
        expect(typeof segment.props.onLongPress).toBe('function');
        act(() => { segment.props.onLongPress(); });
        act(() => { segment.props.onPress(); });
        expect(pressed).toEqual(['long', 'press']);
        // And the three pickers have no long press to confuse it with.
        expect(press(renderer, 'Permission mode').props.onLongPress).toBeUndefined();
        expect(press(renderer, 'Reasoning effort').props.onLongPress).toBeUndefined();
    });

    it('is a switch to a screen reader, unlike the pickers', () => {
        // A press that flips a state rather than raising a sheet, so VoiceOver
        // announces a state instead of an `expanded` it does not have.
        const segment = press(mount({ readAloud: readAloud({ on: true }) }), 'Read aloud');
        expect(segment.props.accessibilityRole).toBe('switch');
        expect(segment.props.accessibilityState.checked).toBe(true);
        const off = press(mount({ readAloud: readAloud({ on: false, fill: 'none' }) }), 'Read aloud');
        expect(off.props.accessibilityState.checked).toBe(false);
    });

    it('draws a glyph segment narrower than it is tall, and the model segment neither', () => {
        // DROVE-284's other half. `segmentWidth` defaults to `size`, which is
        // Home's square 44pt capsule; the chat hands in the narrower value and
        // the segments follow it on one axis only.
        const renderer = mount({
            size: 39,
            segmentWidth: MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH,
            readAloud: readAloud(),
        });
        for (const label of ['Permission mode', 'Read aloud', 'Reasoning effort']) {
            const box = stylePartsOf(press(renderer, label)).reduce((found: any, part: any) => ({
                width: part?.width ?? found.width, height: part?.height ?? found.height,
            }), { width: undefined, height: undefined });
            expect(box, label).toEqual({
                width: MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH, height: 39,
            });
        }
        expect(MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH).toBe(27);
        // The name sizes to itself and takes only the height.
        const modelParts = stylePartsOf(press(renderer, 'Model'));
        expect(modelParts.some((part: any) => (
            part?.width === MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH
        ))).toBe(false);
        expect(modelParts.some((part: any) => part?.height === 39)).toBe(true);
        // Square by default, which is what Home still draws.
        const homeParts = stylePartsOf(press(mount({ readAloud: readAloud() }), 'Read aloud'));
        expect(homeParts.some((part: any) => part?.width === 44 && part?.height === 44)).toBe(true);
    });
});
