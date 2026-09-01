import * as React from 'react';
import { StyleSheet as RNStyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { Typography } from '@/constants/Typography';
import { BubblePressable } from './BubblePressable';
import { getGlassSurfaceOverflow } from './glassInteractionPolicy';
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
    composerGlyphColour,
    composerSessionCapsuleFill,
    pendingOrSettled,
} from './composerControlColour';
import {
    AUTO_ACCEPT_SUBTITLE,
    AUTO_ACCEPT_TITLE,
    autoAcceptGlyph,
    autoAcceptSegmentValue,
    permissionAccessibilityValue,
} from './autoAcceptRow';
import { MOBILE_COMPOSER_SEGMENT_FILL_INSET } from './agentInputLayout';
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
 * AND SINCE DROVE-254 IT IS AN OPAQUE FILL RATHER THAN GLASS. DROVE-153 gave
 * it a `GlassChromeSurface` because it sat outside the bubble on the dock
 * scrim, where glass over the chat was the right material. DROVE-236 moved it
 * inside the bubble, which is itself a `UIGlassEffect`, and a glass effect
 * nested in a glass effect has nothing left to refract. Clay: "This blends in
 * which is annoying." It wears the same fill as the three discs on the row now
 * and the hairlines inside it are measured against that fill;
 * composerControlColour.ts holds both numbers and the argument.
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
 */

export type ComposerSessionPicker = 'permission' | 'model' | 'effort';

/**
 * What a segment does when it is pressed (DROVE-281).
 *
 * Three of the four open a picker; the fourth flips a boolean and opens
 * nothing. They share `Control` because they share a shape — a 39pt press
 * inside one capsule — and they are kept apart in the TYPE rather than by a
 * convention, so a toggle can never be handed to `onPress` and asked for a
 * sheet.
 */
export type ComposerSessionSegment = ComposerSessionPicker | 'autoAccept' | 'readAloud';

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
    /** Read-aloud is on, paused included: what a TAP will turn off. */
    on: boolean;
    /** Already translated by the caller, which owns `t`. */
    accessibilityLabel: string;
    onPress: () => void;
    /** Boss mode from off, pause/resume while on (DROVE-233/275). */
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
     * Whether this session is auto-accepting its boolean gates (DROVE-277,
     * moved onto the row by DROVE-281).
     *
     * ITS OWN SEGMENT NOW, second in the capsule, touching the padlock. It was
     * a switch inside the padlock's sheet, which made the padlock the only
     * object that could show the state and made changing it two taps. Clay:
     * "add a button for toggling auto accepting prompts". A toggle he flips
     * per session, mid-work, from behind a sheet is a toggle he does not flip.
     *
     * Absent is off, which is what every session is at launch and after every
     * relaunch — `autoAcceptSessions.ts` holds why that is the security
     * property rather than a shortcut.
     */
    autoAccept?: boolean;
    /**
     * Flips it. Absent means the segment is not drawn at all (DROVE-281).
     *
     * Drawn-and-dead is the wrong shape for this one, though it is the right
     * one for the three pickers: a picker with nothing to pick still SAYS what
     * the session is set to, and a bolt that cannot be pressed says only that
     * something is missing. A session with no id has no auto-accept to hold, so
     * there is nothing for the segment to say and it is absent.
     */
    onToggleAutoAccept?: () => void;
    /**
     * Read-aloud, drawn as a segment between the permission pair and the
     * effort gauge (DROVE-284).
     *
     * Absent means there is no reader on this surface and the segment is not
     * drawn — the same shape as the bolt's `onToggleAutoAccept`, and for the
     * same reason: a speaker with nothing behind it says only that something is
     * missing. `audioOutButton`'s `shown` is what the caller reads to decide.
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
    const size = 20;
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
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
        // An open segment's wash is clipped to the capsule's round ends, which
        // is what `GlassChromeSurface` did for this off the material
        // (`getGlassSurfaceOverflow(false)`). There is no press swell to clip
        // any more, because there is no material to swell (DROVE-202,
        // DROVE-254).
        overflow: getGlassSurfaceOverflow(false),
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
     * rather than push the audio button off the row.
     */
    modelSegment: {
        paddingHorizontal: COMPOSER_MODEL_SEGMENT.paddingHorizontal,
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
    // Pressed and open read as a WASH over the capsule's fill rather than as a
    // second fill, so the segment lightens where a finger is instead of
    // becoming a different object. Unchanged by DROVE-254 taking the glass
    // away: it composites over an opaque fill now, and the gauge's floors are
    // asserted on that washed surface too.
    controlOpen: {
        backgroundColor: theme.colors.glass.backgroundSubtle,
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

function Control(props: {
    /** Identity, for reading a tree; the press is bound by the caller. */
    segment: ComposerSessionSegment;
    accessibilityLabel: string;
    accessibilityValue?: string;
    accessibilityHint?: string;
    open: boolean;
    /**
     * A switch rather than a disclosure, for the one segment that opens
     * nothing (DROVE-281). It changes `accessibilityRole` and drops
     * `expanded`, so VoiceOver announces a state instead of a sheet that is
     * not there.
     */
    toggled?: boolean;
    /**
     * Already bound to what it does (DROVE-281).
     *
     * It took the segment id and handed it back to the caller's `onPress`,
     * which was fine while all four segments did the same thing. One of them
     * flips a boolean now and never names a picker, so the binding moved to
     * the call site and this is a plain press.
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
    const segmentStyle = props.wide
        ? [styles.modelSegment, { height: props.size }]
        : [styles.control, { width: props.segmentWidth, height: props.size }];
    /**
     * THE FADE IS THIS SEGMENT'S ONLY POSSIBLE RESPONSE, AND THAT FOLLOWS FROM
     * THE CAPSULE RATHER THAN FROM THE SURFACE (DROVE-266).
     *
     * `useNativeGlassPress()` answers a question about the SURFACE: is the
     * material under this control drawing the press. That was the right
     * question while the capsule was its own `GlassChromeSurface` (DROVE-153).
     * It stopped being the right one when DROVE-254 made the capsule an OPAQUE
     * fill, because an opaque capsule COVERS the bubble's glass and
     * `UIGlassEffect.isInteractive` then lenses underneath a view nothing shows
     * through. A segment that trusted the context would have no press response
     * at all, which was invisible only because the composer's bubble never
     * asked for interactive glass until DROVE-266's first half.
     *
     * SO WHY IS THE CAPSULE NOT A GLASS BUTTON LIKE THE DISCS NOW ARE. Because
     * DROVE-254 ruled on THIS control by name. Clay filed it on the capsule —
     * "this blends in which is annoying" — and the fix was to stop it being a
     * `UIGlassEffect` nested in the bubble's own. Re-glassing it is the one move
     * that would re-create that ticket, and it would cost the open segment's
     * wash its clip as well: an interactive surface must not clip (DROVE-202),
     * and the capsule's `overflow: hidden` is what rounds that wash to its ends.
     * The discs have neither problem, which is why they moved and this did not.
     *
     * No `useNativeGlassPress` and no policy call, then: an opaque capsule is
     * never on the material, so the answer is constant and is written here.
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
    const pill = props.fill !== undefined
        ? {
            width: props.segmentWidth - 2 * MOBILE_COMPOSER_SEGMENT_FILL_INSET.horizontal,
            height: props.size - 2 * MOBILE_COMPOSER_SEGMENT_FILL_INSET.vertical,
        }
        : null;
    return (
        <BubblePressable
            onPress={props.onPress}
            onLongPress={props.onLongPress}
            disabled={!pressable}
            nativeGlassPress={false}
            // Vertical only. See `verticalSlop` on the props for why the other
            // axis is not available inside a shared capsule.
            hitSlop={{ top: props.verticalSlop, bottom: props.verticalSlop, left: 0, right: 0 }}
            style={(p) => [
                ...segmentStyle,
                props.open && styles.controlOpen,
                { opacity: pressable && p.pressed ? 0.7 : 1 },
            ]}
            accessibilityRole={props.toggled === undefined ? 'button' : 'switch'}
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            accessibilityValue={props.accessibilityValue ? { text: props.accessibilityValue } : undefined}
            accessibilityState={props.toggled === undefined
                ? { expanded: props.open, disabled: !pressable }
                : { checked: props.toggled, disabled: !pressable }}
        >
            {pill ? (
                <View
                    style={[
                        styles.fillPill,
                        {
                            width: pill.width,
                            height: pill.height,
                            // A stadium at every segment width: half the
                            // pill's narrower side.
                            borderRadius: Math.min(pill.width, pill.height) / 2,
                            backgroundColor: props.fill ?? 'transparent',
                        },
                    ]}
                >
                    {props.children}
                </View>
            ) : props.children}
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
        onToggleAutoAccept,
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
    // The bolt is drawn when there is something to flip, and not otherwise
    // (DROVE-281). See `onToggleAutoAccept` for why this one is absent rather
    // than dead while the three pickers are dead rather than absent.
    const showAutoAccept = !!onToggleAutoAccept;
    // Drawn where there is a reader, absent where there is not (DROVE-284).
    const showReadAloud = !!readAloud;
    const showEffort = !!label.effort && effortCount > 0 && effortIndex != null && effortIndex >= 0;
    const showModel = !!label.model;
    const canOpenMode = canOpen?.permission !== false;
    const canOpenEffort = canOpen?.effort !== false;
    const canOpenModel = canOpen?.model !== false;
    if (!showMode && !showAutoAccept && !showReadAloud && !showEffort && !showModel) {
        return null;
    }
    const mode = permissionModeAccessibility(label.mode);
    const effort = effortAccessibility(label.effort, effortIndex ?? 0, effortCount);
    // A divider goes between two drawn segments, never at either end, so a
    // session with no effort scale does not leave a hairline floating in the
    // capsule.
    //
    // AND NEVER BETWEEN THE PADLOCK AND THE BOLT (DROVE-281). Those two are the
    // capsule's permission PAIR and they touch, because a hairline in this
    // capsule says "a separate thing to press" and the grouping is the whole
    // answer to Clay's "put the mode button in the group with the rest". The
    // rules stay where the subject changes: permission -> effort, effort ->
    // the model's name. That is also why `dividers` in the budget stayed at 2
    // while `glyphSegments` went to 3.
    const permissionGroup = showMode || showAutoAccept;
    const readAloudNeedsDivider = showReadAloud && permissionGroup;
    const effortNeedsDivider = showEffort && (permissionGroup || showReadAloud);
    const modelNeedsDivider = showModel && (permissionGroup || showReadAloud || showEffort);
    const readAloudFill = readAloud ? composerAudioOutFill(theme.dark, readAloud.fill) : null;
    // One interactive surface for the capsule, not one per segment
    // (DROVE-169). UIGlassEffect follows the touch inside the effect view it
    // is on, so the segment under the finger brightens and its neighbours
    // answer with it, which is how the system draws a grouped control. The
    // model segment is inside the same surface, so it takes part rather than
    // needing a press animation of its own (DROVE-178).
    const divider = composerCapsuleDivider(theme.dark);
    return (
        // AN OPAQUE FILL, NOT GLASS (DROVE-254). It was a `GlassChromeSurface`
        // while it lived outside the bubble, which is where DROVE-153 put it.
        // Inside the bubble that is a glass effect nested in a glass effect,
        // and the inner one has nothing left to refract, which is Clay's "this
        // blends in". It is the same plain view with the same opaque fill the
        // three discs on this row already are, and the reasoning and the
        // measurement are on `COMPOSER_SESSION_CAPSULE_FILL`.
        //
        // AND IT STAYS ONE, THOUGH THE DISCS EITHER SIDE ARE GLASS BUTTONS NOW
        // (DROVE-266). Clay asked for the row's buttons to be smaller Liquid
        // Glass buttons and the four discs are; this is the one control that
        // does not follow them, because DROVE-254 was filed about THIS shape
        // being a glass effect inside the bubble's own. The argument is on
        // `Control` below, with what it would additionally cost the open wash.
        //
        // No rim either. The fallback surface drew a hairline border, and the
        // three discs on this row do not: one separation mechanism, measured,
        // rather than a fill plus an edge covering for it.
        <View
            style={[
                styles.capsule,
                { height: size, borderRadius: size / 2, backgroundColor: composerSessionCapsuleFill(theme.dark) },
                style,
            ]}
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
                    {/* The foreground in every mode (DROVE-215), with no
                        exception left (DROVE-281). The mode is a value the
                        session holds, not a thing it is doing, so under the
                        rule it earns no colour, and the padlock, shield, eye
                        and map already separate the modes on their own
                        (DROVE-141).

                        DROVE-277 made auto-accept the one state that coloured
                        it, because the switch was inside this control's sheet
                        and the padlock was the only object that could wear the
                        state. The bolt beside it wears it now, so the padlock
                        goes back to the plain rule. `autoAcceptColour` carries
                        the move and why both are not tinted. */}
                    <Ionicons
                        name={permissionModeGlyph(modeKind, modeKey)}
                        size={20}
                        color={pendingOrSettled(palette, permissionPending, composerGlyphColour(palette))}
                    />
                </Control>
            ) : null}
            {/* AUTO-ACCEPT, TOUCHING THE PADLOCK (DROVE-281).

                Clay, with the row photographed: "add a button for toggling
                auto accepting prompts" and "put the mode button in the group
                with the rest". The second reads two ways — the padlock leaving
                the capsule for the loose buttons, or the new control joining
                the padlock inside it — and the capsule settles it: it already
                groups the controls that say HOW this session runs, while the
                four discs below DO things. Answering prompts unasked is how it
                runs. Rendered side by side the other reading turns the action
                row into six undifferentiated glyphs with nothing saying which
                two are settings.

                IT OPENS NOTHING. All three of its neighbours are a press that
                raises a sheet (DROVE-242); this is a press that flips a
                boolean, which is the whole point of moving it here, and it is
                a `switch` to a screen reader rather than a button with an
                `expanded` state it does not have.

                NO PENDING FACE EITHER, and that is a fact about the state
                rather than an omission. The other three send a pick to the
                terminal and wait a median two seconds for it (DROVE-217); this
                one writes to a set in this process and is true before the
                finger leaves the glass. */}
            {showAutoAccept ? (
                <Control
                    segment="autoAccept"
                    accessibilityLabel={AUTO_ACCEPT_TITLE}
                    accessibilityValue={autoAcceptSegmentValue(autoAccept)}
                    accessibilityHint={AUTO_ACCEPT_SUBTITLE}
                    toggled={autoAccept}
                    open={false}
                    onPress={onToggleAutoAccept}
                    size={size}
                    segmentWidth={segmentWidth}
                    verticalSlop={verticalSlop}
                >
                    {/* The bolt FILLS as well as colouring, so the state has a
                        silhouette and does not rest on hue alone — the outline
                        and the solid are the same glyph at two weights, which
                        is how the row already draws the mic. */}
                    <Ionicons
                        name={autoAcceptGlyph(autoAccept)}
                        size={20}
                        color={autoAcceptColour(palette, autoAccept)}
                    />
                </Control>
            ) : null}
            {readAloudNeedsDivider ? <View style={[styles.segmentDivider, { backgroundColor: divider }]} /> : null}
            {/* READ-ALOUD, IN THE GROUP (DROVE-284).

                Clay, rejecting the second row DROVE-281 bought: "Add the
                reading mode whatever thing to the group and keep it all on the
                same row as send and +." It sits third, after the permission
                pair and before the effort gauge, with a rule either side
                because the subject changes at both: permission -> how the
                agent talks back -> how hard it thinks -> which model.

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
                        size={20}
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
                    >
                        {label.model}
                    </Text>
                </Control>
            ) : null}
        </View>
    );
});
