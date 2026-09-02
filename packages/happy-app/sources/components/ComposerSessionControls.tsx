import * as React from 'react';
import { StyleSheet as RNStyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { Typography } from '@/constants/Typography';
import { BubblePressable } from './BubblePressable';
import { GlassChromeSurface } from './GlassChromeControl';
import { useNativeGlassPress } from './glassPress';
import { shouldDrawPressedFallback } from './glassInteractionPolicy';
import {
    effortAccessibility,
    effortGaugeAngle,
    effortGaugePoint,
    effortGaugeTrackPath,
    permissionModeAccessibility,
    permissionModeGlyph,
} from './sessionControlGlyphs';
import {
    autoAcceptColour,
    composerAudioOutFill,
    composerAudioOutTint,
    composerCapsuleDivider,
    composerControlPalette,
    composerGaugeTrack,
    composerGlassTint,
    composerGlyphColour,
    composerSessionCapsuleFill,
    pendingOrSettled,
} from './composerControlColour';
import { permissionAccessibilityValue } from './autoAcceptRow';
import {
    MOBILE_COMPOSER_CAPSULE_GLYPH_SIZE,
    MOBILE_COMPOSER_SEGMENT_FILL_INSET,
} from './agentInputLayout';
import {
    COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY,
    COMPOSER_BUBBLE_SESSION_MODEL_SEGMENT_GEOMETRY,
} from './composerBubbleLayout';
import {
    COMPOSER_MODEL_SEGMENT,
    COMPOSER_SESSION_CONTROL_SIZE,
    type SessionPillLabel,
} from './sessionPillLabel';
import type { AudioOutFill, AudioOutGlyph } from './composerAudioOut';

/**
 * Permission mode, effort and model, folded into the composer's button row
 * (DROVE-111).
 *
 * DROVE-83 gave the three a row of their own, one pill reading
 * `Yolo · Opus 5 1M · High` that opened a sheet listing them again. Clay drew
 * an arrow from that row down into the button row, then said of the sheet:
 * "I don't like this extra menu, then I have to click twice." So the row is
 * the menu: each control opens its own picker on the first tap, and there is
 * no intermediate menu anywhere in the path.
 *
 * ONE CAPSULE (DROVE-153). Clay sent the Screenshot markup toolbar as a
 * reference and the thing to take from it is not the pixel size, it is that
 * related actions share ONE capsule rather than sitting in separate circles.
 * Mode and effort are the same idea twice over: how this session is being run.
 * So they are one capsule with a hairline between them, not two discs with air
 * between them. Each segment is its own 44pt-tall, 44pt-wide press target with
 * its own picker, so pressing effort cannot open the mode list.
 *
 * IT WAS AN OPAQUE FILL FROM DROVE-254 TO DROVE-343, AND IT IS GLASS AGAIN.
 * DROVE-153 gave it a `GlassChromeSurface` because it sat outside the bubble on
 * the dock scrim. DROVE-236 moved it inside the bubble, which is itself a
 * `UIGlassEffect`, and a glass effect nested in a glass effect has nothing left
 * to refract: Clay, "This blends in which is annoying." So 254 made it a plain
 * view wearing the discs' fill.
 *
 * DROVE-266 then made those discs REAL glass buttons inside the same bubble,
 * spending their opaque fills as `UIGlassEffect.tintColor`, and Clay's verdict
 * on the result is the one that settles this: "I love the liquid glass
 * experience I'm getting with the plus button, but the group of buttons should
 * also have that same glass thing." The tint is what 254 was missing — an
 * opaque `tintColor` draws a prominent glass control rather than a translucent
 * smear over another material — so the capsule takes the same route the discs
 * took, with the same fill, through the same `composerGlassTint` guard.
 * composerControlColour.ts still holds the fill and the hairlines measured
 * against it; only the layer they are spent on changed.
 *
 * AND THE MODEL IS THE THIRD SEGMENT (DROVE-178). It was here, DROVE-138 took
 * it to the status row because six 63pt buttons were cutting `Opus 5 1M` to
 * `Opus 5...`, and DROVE-153 then collapsed the row to three objects and freed
 * the gap Clay drew his arrow into. The history is written out in
 * sessionPillLabel.ts so nobody flips it a fourth time. Here it is one more
 * segment inside the same capsule and the same interactive surface: mode,
 * effort, model, in that order, each its own picker on the first tap. The name
 * is drawn smaller before it is ever cut.
 *
 * AND ALL THREE ARE SHEETS (DROVE-242). Mode and model were iOS native menus
 * here until Clay, with one of them open: "Shouldn't these show in sheets like
 * the effort does". They were left as menus deliberately, on the grounds that
 * they were system-owned, and that is exactly what was wrong with them: a
 * menu UIKit places and UIKit dismisses is outside composerPicker.ts's
 * placement rule and outside its dismissal state machine, so a second tap on
 * the control could not close it because the control never saw the tap. This
 * file no longer knows what platform it is on. Every segment is a press that
 * reports its picker, and the sheet is what draws it.
 *
 * AND EFFORT IS ONE OF THE THREE AGAIN (DROVE-242). DROVE-200 made this
 * segment a raw JS responder driving a drag: a press raised a horizontal
 * readout above the row and the same touch slid along it. DROVE-229 then made
 * a TAP open the sheet and left the readout for the drag. Clay, with a
 * screenshot of it over his field: "Why does it show the old shitty slider
 * when I hold down effort?" The responder entered its drag on touch-DOWN, so
 * resting a finger raised the surface the sheet had just replaced.
 *
 * The drag is deleted, not narrowed to a real move. Nothing announced it, and
 * a press, the only thing anyone tries, opens a sheet, so the fast path was
 * reachable only by a gesture nobody was told about. What is left here is a
 * 44pt press like its two neighbours. effortSlider.ts holds the reasoning and
 * what is left of that file.
 *
 * COLOUR CARRIES THE STATE TOO (DROVE-176). The padlock is the warning amber
 * when open, the shield and the eye have their own hues, and the dial's needle
 * warms from the floor to the ceiling. The model's name stays neutral, because
 * a name is not a state and a coloured word beside coloured glyphs would
 * compete with the state they carry. composerControlColour.ts decides and
 * measures every one of those; nothing here picks a colour.
 *
 * AND A PICK THAT HAS NOT LANDED IS DRAWN AS ONE (DROVE-217). The value moves
 * the instant it is tapped, and the control takes the `pending` colour until
 * the terminal confirms it. Clay: "It seems that the effort is actually
 * updating now but there's like a huge delay so it feels weird." It is a median
 * of about two seconds and a tail past a minute, measured off his own logs, and
 * a two-second change and a sixty-second change used to look identical. All
 * three segments, one rule — model and permission mode lag exactly as effort
 * does. The rule for WHEN a pick is pending is in sync/agentModeRequests.ts;
 * this file only draws it.
 *
 * AND THE AUTO-ACCEPT BOLT IS GONE AGAIN (DROVE-331). DROVE-281 drew it as a
 * fourth segment touching the padlock, on Clay's "add a button for toggling
 * auto accepting prompts", and kept the switch in the padlock's sheet for the
 * boundary wording a 39pt segment has no room for. Two controls for one bit.
 * Clay, with both on his phone: "because of the toggles in the sheet for
 * auto-accept, we don't need it also in the bar group." So the sheet's switch
 * is the one control and the capsule is lock, speaker, effort, model. The
 * 27pt the bolt held goes to the model's name through the budget in
 * sessionPillLabel.ts rather than to the segments beside it, and the padlock
 * wears the accent while auto-accept is on, which is DROVE-277's carrier back
 * for DROVE-277's reason: with no bolt, the padlock is again the one object on
 * the row that can show the state, and it is the control that opens the sheet
 * where the state is set.
 */

export type ComposerSessionPicker = 'permission' | 'model' | 'effort';

/**
 * What a segment does when it is pressed (DROVE-281, DROVE-284).
 *
 * Three of the four open a picker; read-aloud flips a state and opens
 * nothing. They share `Control` because they share a shape — a 39pt press
 * inside one capsule — and they are kept apart in the TYPE rather than by a
 * convention, so a toggle can never be handed to `onPress` and asked for a
 * sheet. `'autoAccept'` was a member from DROVE-281 until DROVE-331 took the
 * bolt off the row.
 */
export type ComposerSessionSegment = ComposerSessionPicker | 'readAloud';

/**
 * READ-ALOUD, AS A SEGMENT OF THIS CAPSULE (DROVE-284).
 *
 * Clay: "Add the reading mode whatever thing to the group and keep it all on
 * the same row as send and +." The control is unchanged — the state table is
 * still `audioOutButton` in composerAudioOut.ts, both gestures are still the
 * two handlers AgentInput has always wired — and only the box around it
 * changed, exactly as DROVE-236 said when it moved the other way.
 *
 * THE FILL COMES IN WITH IT. A disc could say its state with a coloured circle;
 * a segment says it with a coloured segment, which is the same carrier at a
 * different shape and is how `controlOpen` already washes a pressed segment.
 * The four faces are unchanged: no fill off, amber paused, accent reading,
 * recording red on a call.
 */
export interface ComposerReadAloudSegment {
    /** The glyph for the state, from `audioOutButton`. */
    glyph: AudioOutGlyph;
    /** Which of the four faces, from `audioOutButton`. */
    fill: AudioOutFill;
    /** Read-aloud is on, paused included. Drawn as toggled. */
    on: boolean;
    /** Already translated by the caller, which owns `t`. */
    accessibilityLabel: string;
    /** Start from off, stop while reading, RESUME from paused (DROVE-327). */
    onPress: () => void;
    /** Boss mode from off, pause while reading, off from paused (DROVE-233/236/327). */
    onLongPress?: () => void;
}

export interface ComposerSessionControlsProps {
    label: SessionPillLabel;
    /**
     * How tall the capsule is, and how wide each glyph segment (DROVE-236).
     *
     * 44 on a row of its own, which is where this started. 36 inside the chat
     * bubble's button row, because that row is 36 and a 44pt capsule wedged
     * between two 36pt discs is the one object on the row that does not
     * belong to it. The trade the smaller size makes on the touch target is
     * argued on `MOBILE_COMPOSER_BUBBLE_CONTROL_SIZE`.
     */
    size?: number;
    /**
     * How wide a GLYPH segment is, which is no longer how tall it is
     * (DROVE-284).
     *
     * Defaults to `size`, which is square and is what Home's 44pt capsule on a
     * row of its own still draws. The chat's capsule passes
     * `MOBILE_COMPOSER_CAPSULE_SEGMENT_WIDTH`, because four glyph segments at a
     * disc's width is 156pt of a 393pt phone and a segment bounded by hairlines
     * never needed a circle's diameter. The argument and the ink measurements
     * are on that constant; what it buys is on `COMPOSER_BUBBLE_ROW_GEOMETRY`.
     *
     * The MODEL segment ignores this: it is `wide` and sizes to its name.
     */
    segmentWidth?: number;
    /**
     * The capsule's own frame, handed in by the caller (DROVE-236).
     *
     * The chat draws this inside the bubble's button row, and that row's
     * geometry is exported so a spec can resolve it through the layout engine.
     * Taking the style from there rather than restating it here is the whole
     * lesson of DROVE-214: three green suites shipped a broken composer
     * because the spec asserted a model of the layout while the renderer's own
     * stylesheet quietly did something else.
     */
    style?: StyleProp<ViewStyle>;
    /**
     * Extra touch area around the capsule's segments, in points (DROVE-236).
     *
     * VERTICAL ONLY, and that is a fact about the shape rather than an
     * oversight: the segments sit against each other inside one capsule, so a
     * segment claiming horizontal slop would be claiming its neighbour's ink.
     */
    verticalSlop?: number;
    /** Which permission mode, for the glyph. Falls back to the mode's key. */
    modeKind?: string | null;
    modeKey?: string | null;
    /** Where the effort sits on the scale this model offers, and how long that scale is. */
    effortIndex?: number | null;
    effortCount?: number;
    /** Opens a picker directly. Absent means none of the three is settable here. */
    onPress?: (picker: ComposerSessionPicker) => void;
    /**
     * Which of the three the session will actually take a pick for
     * (DROVE-242).
     *
     * It used to be read off the native menu groups that were handed in, which
     * carried availability by accident of also carrying the rows. The rows are
     * the sheet's now, so this says the one thing the capsule needs: a segment
     * with no handler behind it is drawn and does not press. Absent, or absent
     * for one field, means that field opens.
     */
    canOpen?: { permission?: boolean; effort?: boolean; model?: boolean };
    /** Which picker is open, so the pressed control reads as open. */
    openPicker?: ComposerSessionPicker | null;
    /**
     * Which segments hold a pick the terminal has not confirmed yet
     * (DROVE-217). Absent means everything shown is what the session is
     * actually running, which is the ordinary state.
     */
    pending?: { permission?: boolean; effort?: boolean; model?: boolean } | null;
    /**
     * Whether this session is auto-accepting its boolean gates (DROVE-277).
     *
     * NOT A SEGMENT ANY MORE (DROVE-331). DROVE-281 gave it a bolt of its own
     * beside the padlock; Clay has since ruled the bolt redundant with the
     * switch in the padlock's sheet, so the switch is the one control and this
     * prop is what the PADLOCK reads: the accent while it is on
     * (`autoAcceptColour`), and "auto-accept on" in its accessibility value.
     * The padlock is the control that opens the sheet where the bit is set, so
     * it is the right object to wear the state, and it is the only one on the
     * row that can.
     *
     * Absent is off, which is what every session is at launch and after every
     * relaunch — `autoAcceptSessions.ts` holds why that is the security
     * property rather than a shortcut.
     */
    autoAccept?: boolean;
    /**
     * Read-aloud, drawn as a segment between the padlock and the effort gauge
     * (DROVE-284).
     *
     * Absent means there is no reader on this surface and the segment is not
     * drawn — absent rather than drawn-and-dead, because a speaker with nothing
     * behind it says only that something is missing, where a picker with
     * nothing to pick still says what the session is set to. `audioOutButton`'s
     * `shown` is what the caller reads to decide.
     */
    readAloud?: ComposerReadAloudSegment | null;
}

/** What VoiceOver adds while a pick is in flight, since colour reaches nobody there. */
export function unconfirmedAccessibilityValue(value: string | undefined, pending: boolean): string | undefined {
    if (!pending) return value;
    return value ? `${value}, not confirmed by the terminal yet` : 'not confirmed by the terminal yet';
}

/**
 * The effort as a dial, the needle at the level (DROVE-141).
 *
 * It was a bar meter, and the lane that built it already named the flaw: four
 * filled bars against five is a COUNT, and nobody counts at a glance, so the
 * two levels Clay moves between most were the two hardest to tell apart. A
 * needle is a POSITION. Hard left is the floor, hard right the ceiling, and
 * the angle between them is read rather than counted.
 *
 * The angle is interpolated across whatever scale the current model offers, so
 * a four-level Codex and a six-level Claude both use the whole dial and the
 * ends always mean the ends (DROVE-101). The exact word is one tap away in the
 * picker, and in the accessibility value without one.
 *
 * BOTH MARKS ARE THE FOREGROUND, at two strengths (DROVE-215, DROVE-227). The
 * needle is the foreground itself, because a level is a value and the angle
 * was always the reading the dial was chosen for. The track is the foreground
 * at a reduced opacity, which is a two-sided measurement rather than a taste:
 * it has to separate from the capsule it is drawn on AND stay under the needle
 * it is read against. `composerGaugeTrack` owns the number and
 * composerControlColour.spec.ts asserts both floors on both themes.
 *
 * It shipped once with the track at `theme.colors.divider`, which measures
 * 1.05:1 on the dark glass. Clay: "This icon isn't contrasting." That is the
 * whole of DROVE-227: a gauge with an invisible dial is a floating diagonal.
 */
export function EffortGauge(props: { index: number; count: number; color: string; track: string }) {
    // The capsule's one glyph size, from the metric the segment's width is
    // made out of rather than a third copy of the literal (DROVE-353).
    const size = MOBILE_COMPOSER_CAPSULE_GLYPH_SIZE;
    const strokeWidth = 2;
    const centre = size / 2;
    const angle = effortGaugeAngle(props.index, props.count);
    // Stops short of the track so the needle reads as pointing AT a position
    // rather than as another piece of the ring.
    const tip = effortGaugePoint(centre, (size - strokeWidth) / 2 - 3, angle);
    return (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <Path
                d={effortGaugeTrackPath(size, strokeWidth)}
                stroke={props.track}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                fill="none"
            />
            <Line
                x1={centre}
                y1={centre}
                x2={tip.x}
                y2={tip.y}
                stroke={props.color}
                strokeWidth={2.25}
                strokeLinecap="round"
            />
            <Circle cx={centre} cy={centre} r={1.8} fill={props.color} />
        </Svg>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The capsule the segments share. The material is the surface's, so this
    // carries only shape and flex. It shrinks only through the model segment,
    // which is the one part of it with a width of its own (DROVE-178); the
    // glyph segments keep their size whatever happens. The HEIGHT comes from
    // the caller (DROVE-236), because the chat draws this inside the bubble's
    // 36pt button row and Home draws it on a 44pt row of its own.
    capsule: {
        // THE FRAME THE RESOLVER MODELS, read from it rather than restated
        // (DROVE-214, DROVE-345). It was passed in as a `style` by the chat and
        // by nothing at all on Home, so the two screens drew the same control
        // in two shapes. The HEIGHT still comes from the caller's `size`,
        // because the chat's capsule is the bubble's 39 and Home's row-of-its-
        // own capsule was 44.
        ...COMPOSER_BUBBLE_SESSION_CAPSULE_GEOMETRY,
        minWidth: 0,
        // NO `overflow` HERE ANY MORE (DROVE-343). The capsule is an
        // interactive surface again, and an interactive surface is never
        // clipped (DROVE-202, DROVE-328) — `GlassChromeSurface` decides that
        // last, off `getGlassSurfaceOverflow`, so a style here could only put
        // the clip back. The clip is not missed: it was rounding the open
        // segment's wash to the capsule's ends, and the wash is an inset pill
        // now, which rounds itself.
        //
        // NO `backgroundColor` EITHER. The fill is the effect's `tintColor`,
        // which is how the system draws a prominent glass control and is the
        // same move the discs made in DROVE-266.
    },
    control: {
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    /**
     * The model's name: as wide as the name, and the only thing in the capsule
     * that can give way, after the spacer beside it has (DROVE-178).
     * `flexShrink: 1` with `minWidth: 0` is what lets the text inside scale
     * rather than push the audio button off the row — and, past the type
     * floor, be cut at its tail (DROVE-331). The glyph segments keep
     * `flexShrink: 0`, so a name that runs under never squeezes them.
     */
    modelSegment: {
        // THE REMAINDER, NOT THE NAME'S OWN WIDTH (DROVE-353). `flex: 1` read
        // off the resolver, so this segment is the capsule less the three
        // glyph segments and the three hairlines — which is
        // `composerModelBudget`, measured from the other end. It is what
        // deletes the row's spacer: there is no width left over anywhere for
        // one to hold.
        //
        // ONLY THE FLEX COMES FROM THERE, the same split the glyph segments
        // make: the resolver models the CHAT's 39pt capsule, and the height
        // here is the caller's `size`, because Home's capsule is 44.
        flex: COMPOSER_BUBBLE_SESSION_MODEL_SEGMENT_GEOMETRY.flex,
        // THE SEGMENT'S PADDING IS THE PILL'S INSET NOW (DROVE-343), and the
        // model's own air moved INSIDE the pill with the text. The drawn width
        // is unchanged — `MOBILE_COMPOSER_SEGMENT_FILL_INSET.horizontal` out
        // here plus `paddingHorizontal - horizontal` in there is still
        // `COMPOSER_MODEL_SEGMENT.paddingHorizontal` either side of the name —
        // so `composerModelBudget` and the 320 overflow measurement do not
        // move. What it buys is that this segment's open wash insets off the
        // capsule's rim exactly as every other segment's does, which is what
        // lets the capsule stop clipping.
        paddingHorizontal: MOBILE_COMPOSER_SEGMENT_FILL_INSET.horizontal,
        paddingVertical: MOBILE_COMPOSER_SEGMENT_FILL_INSET.vertical,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    model: {
        fontSize: COMPOSER_MODEL_SEGMENT.fontSize,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    /**
     * The hairline between segments. Apple's grouped capsules separate their
     * halves with a divider rather than a gap, which is what keeps the capsule
     * reading as one object while the halves stay obviously separate.
     *
     * KEPT, and re-measured (DROVE-254). `theme.colors.glass.divider` is a
     * list-row rule and measures 1.28:1 on the capsule's fill, which is not a
     * faint line, it is no line. The colour comes from the call site so it can
     * read the theme, exactly as the gauge's track does; the value and the
     * reason are on `composerCapsuleDivider`.
     */
    segmentDivider: {
        width: RNStyleSheet.hairlineWidth,
        height: 20,
    },
    /**
     * Read-aloud's fill, inset from the segment's box (DROVE-284 refinement).
     * Size, radius and colour come from the call site; this only centres the
     * glyph inside the pill the way the segment centres the pill.
     */
    fillPill: {
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

/**
 * THE OPEN SEGMENT'S WASH (DROVE-343).
 *
 * Open reads as a WASH over the capsule's fill rather than as a second fill, so
 * the segment lightens where its picker is instead of becoming a different
 * object. It was a full-bleed background on the pressable, square to the
 * capsule's rims and rounded only by the capsule's `overflow: 'hidden'`. The
 * capsule is interactive glass again and an interactive surface must not clip
 * (DROVE-202), so a full-bleed wash would have shown its square corners inside
 * the rounded ends. Read-aloud's fill already solved that shape at this scale
 * (DROVE-284), so the wash borrows the same inset pill rather than inventing a
 * second answer.
 *
 * Read here rather than through a stylesheet entry, because the pill's colour
 * has three sources — a fill, this wash, or nothing — and one object deciding
 * between them is what keeps the pill a single style a render can read.
 */
function segmentPillFill(theme: { colors: { glass: { backgroundSubtle: string } } },
    fill: string | null | undefined, open: boolean): string {
    return fill ?? (open ? theme.colors.glass.backgroundSubtle : 'transparent');
}

function Control(props: {
    /** Identity, for reading a tree; the press is bound by the caller. */
    segment: ComposerSessionSegment;
    accessibilityLabel: string;
    accessibilityValue?: string;
    accessibilityHint?: string;
    open: boolean;
    /**
     * A switch rather than a disclosure, for a segment that opens nothing
     * (DROVE-281; read-aloud's alone since DROVE-331 took the bolt). It
     * changes `accessibilityRole` and drops `expanded`, so VoiceOver announces
     * a state instead of a sheet that is not there.
     */
    toggled?: boolean;
    /**
     * Already bound to what it does (DROVE-281).
     *
     * It took the segment id and handed it back to the caller's `onPress`,
     * which was fine while every segment did the same thing. Read-aloud flips
     * a state and never names a picker, so the binding moved to the call site
     * and this is a plain press.
     */
    onPress?: () => void;
    /**
     * The long press, on the one segment that has one (DROVE-284).
     *
     * Read-aloud's second gesture is Clay's own table: boss mode from off,
     * pause and resume while it is reading (DROVE-233/275). It survives the
     * move into the capsule because the press was never a property of the disc
     * — `BubblePressable` is a `Pressable` and takes both.
     */
    onLongPress?: () => void;
    /**
     * An OPAQUE fill behind this one segment, or nothing (DROVE-284).
     *
     * Read-aloud's live states. DROVE-284 bled it to the segment's whole box
     * and Clay's photo shows what that draws: a colour square to the capsule's
     * rims, sharp-cornered inside a rounded shell. It is an INSET PILL now —
     * `MOBILE_COMPOSER_SEGMENT_FILL_INSET` holds the numbers and the renders
     * that settled it — so the filled state nests inside the capsule the way
     * every other filled object on this row nests inside the bubble
     * (DROVE-214's argument for discs over bare glyphs, at segment scale). It
     * is also the disc the control wore before the move, kept at this size
     * rather than traded for a rectangle the disc never was.
     *
     * Opaque for DROVE-254's reason — a translucent fill inside the bubble's
     * own glass has no single value to measure — and every value handed here
     * is asserted at `colorAlpha === 1` in composerControlColour.spec.ts. The
     * pill moves where the fill STOPS, not what it is: the fills and tints are
     * the same measured values on the same capsule.
     *
     * `undefined` means this segment has no fill state at all; `null` means it
     * has one and it is off. The distinction is what keeps the pill MOUNTED on
     * every face (transparent when off), so the face swap under a finger never
     * changes the tree the press is riding on — DROVE-286's lesson, honoured
     * here before it can bite.
     */
    fill?: string | null;
    /** The glyph segment's own width by default; the model segment sizes to its name. */
    wide?: boolean;
    size: number;
    segmentWidth: number;
    verticalSlop: number;
    children: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const nativeGlassPress = useNativeGlassPress();
    const segmentStyle = props.wide
        ? [styles.modelSegment, { height: props.size }]
        : [styles.control, { width: props.segmentWidth, height: props.size }];
    /**
     * THE MATERIAL DRAWS THE PRESS AGAIN, AND THE FADE STANDS DOWN WHERE IT
     * DOES (DROVE-343).
     *
     * This used to say that an opaque capsule COVERS the bubble's glass, so
     * `UIGlassEffect.isInteractive` would lens under a view nothing shows
     * through, so a hand-rolled `opacity: 0.7` was the segment's only possible
     * response. Every step of that was true of an opaque capsule. The capsule
     * is not one any more: Clay, with the `+` mid-press, "the group of buttons
     * should also have that same glass thing", which overrides DROVE-254 for
     * this control exactly as it overrode it for the discs in DROVE-266.
     *
     * So the answer is the context's again, not a constant written here.
     * `GlassChromeSurface` publishes whether the material is drawing the press
     * (`GlassPressProvider`), `shouldDrawPressedFallback` turns that into
     * whether a glyph fade is still wanted, and off the material — an older
     * phone, Reduce Transparency — the fade is still the only pressed state
     * there is, so it stays. That is DROVE-169's rule reaching the last control
     * on the row that was reasoning around it.
     */
    const pressable = !!props.onPress;
    /**
     * THE FILL IS A PILL INSIDE THE SEGMENT, NOT THE SEGMENT'S OWN BACKGROUND
     * (DROVE-284 refinement). The numbers and the side-by-side renders that
     * settled it are on `MOBILE_COMPOSER_SEGMENT_FILL_INSET`.
     *
     * The pill is a CHILD of the pressable and is mounted on every face —
     * transparent when the state is off — so a face swap recolours a view that
     * is already there rather than mounting one. The gesture stays on the one
     * BubblePressable for the life of the control, which is DROVE-286's rule:
     * the press stream must never ride a view the state can unmount.
     */
    /**
     * THE PILL, ON EVERY SEGMENT (DROVE-343).
     *
     * It was read-aloud's alone, mounted only where `fill` was passed. It is
     * every segment's now, because the open wash needs the same shape and the
     * capsule has stopped clipping: a pill rounds itself, a full-bleed
     * background needed the clip to be rounded for it. Mounted on every face,
     * transparent when there is neither a fill nor an open picker, so a state
     * change recolours a view rather than mounting one under a finger
     * (DROVE-286).
     *
     * A GLYPH segment's pill is its box less the inset, which is what
     * DROVE-284's renders settled. The MODEL segment has no width of its own —
     * it is the one thing in the composer that sizes to its content — so its
     * pill takes the segment's interior instead (`flexGrow` down the padded
     * box, `alignSelf: 'stretch'` across it) and carries the name's air as its
     * own padding. Same drawn inset, same stadium, one mechanism.
     */
    const pillHeight = props.size - 2 * MOBILE_COMPOSER_SEGMENT_FILL_INSET.vertical;
    const pillFill = segmentPillFill(theme as never, props.fill, props.open);
    const pill: Record<string, unknown> = props.wide
        ? {
            backgroundColor: pillFill,
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            alignSelf: 'stretch',
            paddingHorizontal: COMPOSER_MODEL_SEGMENT.paddingHorizontal
                - MOBILE_COMPOSER_SEGMENT_FILL_INSET.horizontal,
            // A stadium, off the one axis this segment knows.
            borderRadius: pillHeight / 2,
        }
        : {
            backgroundColor: pillFill,
            width: props.segmentWidth - 2 * MOBILE_COMPOSER_SEGMENT_FILL_INSET.horizontal,
            height: pillHeight,
            // A stadium at every segment width: half the pill's narrower side.
            borderRadius: Math.min(
                props.segmentWidth - 2 * MOBILE_COMPOSER_SEGMENT_FILL_INSET.horizontal,
                pillHeight,
            ) / 2,
        };
    return (
        <BubblePressable
            onPress={props.onPress}
            onLongPress={props.onLongPress}
            disabled={!pressable}
            // Vertical only. See `verticalSlop` on the props for why the other
            // axis is not available inside a shared capsule.
            hitSlop={{ top: props.verticalSlop, bottom: props.verticalSlop, left: 0, right: 0 }}
            style={(p) => [
                ...segmentStyle,
                {
                    opacity: shouldDrawPressedFallback(nativeGlassPress, pressable && p.pressed, !pressable)
                        ? 0.7
                        : 1,
                },
            ]}
            accessibilityRole={props.toggled === undefined ? 'button' : 'switch'}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            accessibilityValue={props.accessibilityValue ? { text: props.accessibilityValue } : undefined}
            accessibilityState={props.toggled === undefined
                ? { expanded: props.open, disabled: !pressable }
                : { checked: props.toggled, disabled: !pressable }}
        >
            <View style={[styles.fillPill, pill]}>
                {props.children}
            </View>
        </BubblePressable>
    );
}

export const ComposerSessionControls = React.memo(function ComposerSessionControls(
    props: ComposerSessionControlsProps,
) {
    const { theme } = useUnistyles();
    const {
        label,
        modeKind,
        modeKey,
        effortIndex,
        effortCount = 0,
        onPress,
        canOpen,
        openPicker,
        pending,
        autoAccept = false,
        readAloud,
        size = COMPOSER_SESSION_CONTROL_SIZE,
        // Square unless the caller says otherwise, which is Home's 44pt capsule
        // on a row of its own. The chat's is narrower (DROVE-284).
        segmentWidth = size,
        verticalSlop = 0,
        style,
    } = props;
    const palette = composerControlPalette(theme.dark);
    const permissionPending = !!pending?.permission;
    const modelPending = !!pending?.model;
    const effortPending = !!pending?.effort;
    const showMode = !!label.mode;
    // Drawn where there is a reader, absent where there is not (DROVE-284).
    const showReadAloud = !!readAloud;
    const showEffort = !!label.effort && effortCount > 0 && effortIndex != null && effortIndex >= 0;
    const showModel = !!label.model;
    const canOpenMode = canOpen?.permission !== false;
    const canOpenEffort = canOpen?.effort !== false;
    const canOpenModel = canOpen?.model !== false;
    if (!showMode && !showReadAloud && !showEffort && !showModel) {
        return null;
    }
    const mode = permissionModeAccessibility(label.mode);
    const effort = effortAccessibility(label.effort, effortIndex ?? 0, effortCount);
    // A divider goes between two drawn segments, never at either end, so a
    // session with no effort scale does not leave a hairline floating in the
    // capsule.
    //
    // ONE BETWEEN EVERY PAIR SINCE DROVE-331. The padlock and the bolt were
    // the one pair that touched (DROVE-281: a hairline in this capsule says "a
    // separate thing to press", and those two were the permission pair). The
    // bolt is gone, so every boundary left is a change of subject —
    // permission -> read-aloud -> effort -> the model's name — and every one
    // gets its rule. `dividers` in the budget is still 3, for four segments
    // now rather than five.
    const readAloudNeedsDivider = showReadAloud && showMode;
    const effortNeedsDivider = showEffort && (showMode || showReadAloud);
    const modelNeedsDivider = showModel && (showMode || showReadAloud || showEffort);
    const readAloudFill = readAloud ? composerAudioOutFill(theme.dark, readAloud.fill) : null;
    // One interactive surface for the capsule, not one per segment
    // (DROVE-169). UIGlassEffect follows the touch inside the effect view it
    // is on, so the segment under the finger brightens and its neighbours
    // answer with it, which is how the system draws a grouped control. The
    // model segment is inside the same surface, so it takes part rather than
    // needing a press animation of its own (DROVE-178).
    const divider = composerCapsuleDivider(theme.dark);
    return (
        // ONE INTERACTIVE GLASS SURFACE, THE SAME MATERIAL THE `+` IS
        // (DROVE-343). Clay, with the `+` mid-press: "I love the liquid glass
        // experience I'm getting with the plus button, but the group of buttons
        // should also have that same glass thing."
        //
        // THAT REVERSES DROVE-254, DELIBERATELY, AND ON THE SAME AUTHORITY THAT
        // REVERSED IT FOR THE DISCS. 254 filed this control as a glass effect
        // nested in the bubble's own — "this blends in which is annoying" — and
        // the fix was to stop it being one. DROVE-266 then made the four discs
        // real glass buttons inside the same bubble, tinted with their opaque
        // fills, and Clay loves those. The tint is what answers 254: a
        // `UIGlassEffect` with an opaque `tintColor` is a PROMINENT glass
        // control, not a translucent smear over another material, so it reads
        // as its own object and still deforms under a finger. `composerGlassTint`
        // refuses anything translucent on the way in, which is the step that
        // was missing when 254's bug got in.
        //
        // AND THE SURFACE IS THE CAPSULE, NOT THE SEGMENT (DROVE-169).
        // `UIGlassEffect` follows the touch inside the effect view it is on, so
        // one interactive capsule is how the system draws a grouped control:
        // the segment under the finger brightens and its neighbours answer with
        // it. Four surfaces would be four buttons that happen to touch.
        //
        // No rim: the fallback surface draws a hairline border and the discs on
        // this row do not. One separation mechanism, measured (DROVE-254).
        <GlassChromeSurface
            interactive
            rim={false}
            radius={size / 2}
            tintColor={composerGlassTint(composerSessionCapsuleFill(theme.dark))}
            style={[styles.capsule, { height: size }, style]}
        >
            {showMode ? (
                <Control
                    segment="permission"
                    accessibilityLabel={mode.label}
                    accessibilityValue={unconfirmedAccessibilityValue(
                        permissionAccessibilityValue(mode.value, autoAccept),
                        permissionPending,
                    )}
                    open={openPicker === 'permission'}
                    onPress={canOpenMode && onPress ? () => onPress('permission') : undefined}
                    size={size}
                    segmentWidth={segmentWidth}
                    verticalSlop={verticalSlop}
                >
                    {/* The foreground in every mode (DROVE-215), and the
                        accent while auto-accept is on (DROVE-277, back since
                        DROVE-331). The mode is a value the session holds, not
                        a thing it is doing, so under the rule it earns no
                        colour, and the padlock, shield, eye and map already
                        separate the modes on their own (DROVE-141).

                        Auto-accept IS a thing the app is doing, and it is the
                        one state on this row whose cost of being missed is a
                        command running unasked. DROVE-277 put its colour on
                        this glyph because the switch was inside this control's
                        sheet and nothing else on the row could wear it;
                        DROVE-281 moved the colour to a bolt beside it;
                        DROVE-331 took the bolt away on Clay's word, so the
                        padlock is the one carrier again, for the reason it was
                        the first time. `autoAcceptColour` carries the rule. The
                        SILHOUETTE never changes with it: a reader who cannot
                        tell accent from foreground still reads the mode, and
                        hears the state in the accessibility value. */}
                    <Ionicons
                        name={permissionModeGlyph(modeKind, modeKey)}
                        size={MOBILE_COMPOSER_CAPSULE_GLYPH_SIZE}
                        color={pendingOrSettled(palette, permissionPending, autoAcceptColour(palette, autoAccept))}
                    />
                </Control>
            ) : null}
            {/* NO BOLT HERE SINCE DROVE-331. DROVE-281 drew the auto-accept
                toggle as a segment touching the padlock; the switch in the
                padlock's sheet is the one control now. The state is still on
                the row: the padlock above wears it. */}
            {readAloudNeedsDivider ? <View style={[styles.segmentDivider, { backgroundColor: divider }]} /> : null}
            {/* READ-ALOUD, IN THE GROUP (DROVE-284).

                Clay, rejecting the second row DROVE-281 bought: "Add the
                reading mode whatever thing to the group and keep it all on the
                same row as send and +." It sits second, after the padlock and
                before the effort gauge — third while DROVE-281's bolt was on
                the row — with a rule either side because the subject changes
                at both: permission -> how the agent talks back -> how hard it
                thinks -> which model.

                IT IS THE SAME CONTROL. `audioOutButton` still decides all four
                faces, `handleAudioOutPress` and `handleAudioOutLongPress` are
                still the two handlers, and DROVE-233/275's long press — boss
                mode from off, pause and resume while reading — comes with it,
                because a press was never a property of the disc.

                THE FILL IS AN INSET PILL AND SAYS THE SAME THING. Off it
                wears the capsule like the padlock does; paused it is the
                palette's amber (DROVE-258), reading the accent, on a call the
                recording red. DROVE-284 first drew it as the segment's own
                rectangle, square to the capsule's rims; Clay's photo showed
                the sharp corners inside the rounded shell, and the pill —
                `MOBILE_COMPOSER_SEGMENT_FILL_INSET`, with the renders that
                settled it — is the disc's vocabulary kept at segment scale.
                The glyph is `composerFillTint`'s answer over whichever fill
                it is on, which is white everywhere except the amber, where
                white measures about 2:1 and the tint flips — the same rule
                the disc used, reached through the same function. */}
            {readAloud ? (
                <Control
                    segment="readAloud"
                    accessibilityLabel={readAloud.accessibilityLabel}
                    toggled={readAloud.on}
                    open={false}
                    onPress={readAloud.onPress}
                    onLongPress={readAloud.onLongPress}
                    fill={readAloudFill}
                    size={size}
                    segmentWidth={segmentWidth}
                    verticalSlop={verticalSlop}
                >
                    <Ionicons
                        name={readAloud.glyph}
                        size={MOBILE_COMPOSER_CAPSULE_GLYPH_SIZE}
                        color={composerAudioOutTint(theme.dark, readAloud.fill)}
                    />
                </Control>
            ) : null}
            {effortNeedsDivider ? <View style={[styles.segmentDivider, { backgroundColor: divider }]} /> : null}
            {showEffort ? (
                <Control
                    segment="effort"
                    accessibilityLabel={effort.label}
                    accessibilityValue={unconfirmedAccessibilityValue(effort.value, effortPending)}
                    open={openPicker === 'effort'}
                    onPress={canOpenEffort && onPress ? () => onPress('effort') : undefined}
                    size={size}
                    segmentWidth={segmentWidth}
                    verticalSlop={verticalSlop}
                >
                    {/* The dial is DROVE-141's resting glyph, unchanged by the
                        drag's removal: it was never the slider, and the level
                        is still read as an ANGLE rather than counted
                        (DROVE-101). The colour is the foreground at every
                        level (DROVE-215), because a level is a value the
                        session holds and not something it is doing. The track
                        under it is that same foreground at a reduced opacity,
                        held off the capsule and under the needle (DROVE-227). */}
                    <EffortGauge
                        index={effortIndex!}
                        count={effortCount}
                        color={pendingOrSettled(palette, effortPending, composerGlyphColour(palette))}
                        track={composerGaugeTrack(theme.dark)}
                    />
                </Control>
            ) : null}
            {modelNeedsDivider ? <View style={[styles.segmentDivider, { backgroundColor: divider }]} /> : null}
            {showModel ? (
                <Control
                    segment="model"
                    accessibilityLabel="Model"
                    accessibilityValue={unconfirmedAccessibilityValue(label.model!, modelPending)}
                    open={openPicker === 'model'}
                    onPress={canOpenModel && onPress ? () => onPress('model') : undefined}
                    size={size}
                    segmentWidth={segmentWidth}
                    verticalSlop={verticalSlop}
                    wide
                >
                    <Text
                        style={[styles.model, modelPending && { color: palette.pending }]}
                        numberOfLines={1}
                        // Smaller before shorter: the name scales rather than
                        // gaining an ellipsis, because `Opus 5...` is the
                        // failure DROVE-138 was filed about (DROVE-178).
                        adjustsFontSizeToFit
                        minimumFontScale={COMPOSER_MODEL_SEGMENT.minimumFontScale}
                        // AND SHORTER LAST (DROVE-331). Clay, with the bolt's
                        // width in hand: "you can even make the model text a
                        // bit smaller and truncate if it ends up running
                        // under." At the floor a name that still does not fit
                        // is cut at its tail rather than pushing send off the
                        // rim or squeezing the three glyph segments, which
                        // keep their width (`flexShrink: 0`); this segment is
                        // the one that gives (`flexShrink: 1, minWidth: 0`).
                        // Stated, though it is the platform's default, so the
                        // ruling is on the control and the render test holds
                        // it. `composerModelPresentation` says which of whole
                        // / scaled / truncated a phone draws, and on every
                        // supported width it is whole.
                        ellipsizeMode="tail"
                    >
                        {label.model}
                    </Text>
                </Control>
            ) : null}
        </GlassChromeSurface>
    );
});
