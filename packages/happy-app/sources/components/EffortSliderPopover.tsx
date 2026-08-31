import * as React from 'react';
import { StyleSheet as RNStyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from './haptics';
import { BubblePressable } from './BubblePressable';
import { GlassChromeSurface } from './GlassChromeControl';
import { composerControlPalette, effortColour } from './composerControlColour';
import { MOBILE_COMPOSER_METRICS } from './agentInputLayout';
import { COMPOSER_SESSION_CONTROL_SIZE } from './sessionPillLabel';
import {
    EFFORT_AUTO_INDEX,
    EFFORT_SLIDER_METRICS,
    effortCommitKey,
    effortSliderAccessibility,
    effortSliderClosed,
    effortSliderIndex,
    effortSliderPlacement,
    effortSliderReduce,
    effortSliderStopName,
    effortStopX,
    type EffortSliderPlacement,
    type EffortSliderScale,
    type EffortSliderState,
    type EffortSliderStep,
} from './effortSlider';

/**
 * The effort slider itself: the popover above the composer row, and the hook
 * that drives it (DROVE-200).
 *
 * The rules — where it lives, why it is not the dial, why the drag is a delta,
 * why `auto` is off the line, and why a write only ever happens on release —
 * are all in effortSlider.ts, which is pure and specced. This file draws them.
 *
 * WHAT IT REUSES RATHER THAN REDECIDES. The thumb takes DROVE-176's ramp
 * through `effortColour`, so the slider and the dial beside it agree about
 * what a position looks like. The material is DROVE-153's chrome glass, and
 * the popover is 44pt tall for the same reason every other control is. The
 * detent tick is `hapticsSelection`, which is an INTERACTION haptic and is
 * therefore silent while the phone's haptics switch is off — its default
 * (DROVE-190). Nothing here reaches expo-haptics, so there is no way around
 * that switch.
 *
 * THE LATCH. A press that never moved is a tap, and a tap used to open a
 * picker, so it must not be a dead gesture. It leaves the popover up with its
 * stops tappable. That state times out rather than waiting for a tap outside,
 * because a full-screen backdrop over the composer would have to fight the
 * chat's own scroll responder for touches, and losing that fight leaves the
 * app with a modal nobody can dismiss.
 */

/** How long a latched popover stays up before it puts itself away. */
const LATCH_TIMEOUT_MS = 5000;

/** The caption above the thumb, and the air around the popover. */
const CAPTION_HEIGHT = 22;
const CAPTION_GAP = 6;
/** Wide enough for `Ultracode`, the longest word on any scale. */
const CAPTION_WIDTH = 88;
const THUMB_SIZE = 26;

export const EFFORT_SLIDER_POPOVER_HEIGHT =
    EFFORT_SLIDER_METRICS.height + CAPTION_GAP + CAPTION_HEIGHT;

export interface EffortSliderHandle {
    /** The popover is up: dragging, or latched open after a tap. */
    active: boolean;
    /** The stop the thumb is on, for the dial underneath to follow live. */
    index: number;
    onPressIn(pageX: number): void;
    onMove(pageX: number): void;
    onRelease(): void;
    /** Taps on a latched popover. */
    tapStop(index: number): void;
    tapAuto(): void;
    /** VoiceOver's increment and decrement, since a drag is not available there. */
    step(delta: number): void;
    dismiss(): void;
    state: EffortSliderState;
    placement: EffortSliderPlacement | null;
}

/**
 * The gesture, as a hook.
 *
 * `onCommit` is called at most once per gesture, with the wire value: a key
 * for a level, `null` for `auto`, which is the reset `/effort auto`
 * (paneModelSync). It goes to the same `sessionSetAgentModes` the picker used,
 * so it lands through the path DROVE-164 fixed rather than a second one.
 */
export function useEffortSlider(input: {
    scale: EffortSliderScale;
    currentKey: string | null | undefined;
    onCommit?: (key: string | null) => void;
    enabled?: boolean;
}): EffortSliderHandle {
    const { scale, currentKey, onCommit } = input;
    const enabled = input.enabled !== false && scale.keys.length > 0;
    const { width: screenWidth } = useWindowDimensions();
    const [state, setState] = React.useState<EffortSliderState>(effortSliderClosed);
    const [placement, setPlacement] = React.useState<EffortSliderPlacement | null>(null);
    const activeIndex = effortSliderIndex(scale, currentKey);

    // Handlers read the live gesture through refs rather than closing over
    // it, so a move arriving between renders is reduced against what the
    // finger actually did last, not a stale copy.
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const placementRef = React.useRef(placement);
    placementRef.current = placement;
    const commitRef = React.useRef(onCommit);
    commitRef.current = onCommit;
    const scaleRef = React.useRef(scale);
    scaleRef.current = scale;
    const latchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearLatch = React.useCallback(() => {
        if (latchTimer.current) {
            clearTimeout(latchTimer.current);
            latchTimer.current = null;
        }
    }, []);
    React.useEffect(() => clearLatch, [clearLatch]);

    /**
     * The one place a step is applied: the state lands, a crossed stop ticks,
     * and a commit — which only a release or a tap can produce — is written
     * once. This is where "one write on release" stops being a property of the
     * reducer and becomes a property of the control.
     */
    const apply = React.useCallback((stepped: EffortSliderStep) => {
        if (stepped.state !== stateRef.current) {
            stateRef.current = stepped.state;
            setState(stepped.state);
        }
        if (stepped.detent) hapticsSelection();
        if (stepped.commit) commitRef.current?.(effortCommitKey(scaleRef.current, stepped.commit));
        clearLatch();
        if (stepped.state.phase === 'open') {
            latchTimer.current = setTimeout(() => {
                stateRef.current = effortSliderClosed;
                setState(effortSliderClosed);
            }, LATCH_TIMEOUT_MS);
        }
    }, [clearLatch]);

    const dismiss = React.useCallback(() => {
        clearLatch();
        stateRef.current = effortSliderClosed;
        setState(effortSliderClosed);
    }, [clearLatch]);

    // The popover cannot outlive the scale it was drawn from: switching model
    // re-scales the line, and a thumb on a stop that no longer exists would be
    // a lie about what the session is on.
    const scaleSignature = scale.keys.join(' ');
    React.useEffect(() => {
        dismiss();
    }, [dismiss, scaleSignature]);

    const onPressIn = React.useCallback((pageX: number) => {
        if (!enabled) return;
        const next = effortSliderPlacement({
            screenWidth,
            anchorX: pageX,
            count: scaleRef.current.keys.length,
        });
        placementRef.current = next;
        setPlacement(next);
        apply(effortSliderReduce(
            effortSliderClosed,
            { type: 'press-in', x: pageX, index: activeIndex },
            next,
        ));
    }, [activeIndex, apply, enabled, screenWidth]);

    const onMove = React.useCallback((pageX: number) => {
        apply(effortSliderReduce(stateRef.current, { type: 'move', x: pageX }, placementRef.current));
    }, [apply]);

    const onRelease = React.useCallback(() => {
        apply(effortSliderReduce(stateRef.current, { type: 'press-out' }, placementRef.current));
    }, [apply]);

    const tapStop = React.useCallback((index: number) => {
        apply(effortSliderReduce(stateRef.current, { type: 'tap-stop', index }, placementRef.current));
    }, [apply]);

    const tapAuto = React.useCallback(() => {
        apply(effortSliderReduce(stateRef.current, { type: 'tap-auto' }, placementRef.current));
    }, [apply]);

    /**
     * VoiceOver moves the value a notch at a time, because there is no drag to
     * make there. An increment IS the release, so it commits straight away.
     */
    const step = React.useCallback((delta: number) => {
        if (!enabled) return;
        const keys = scaleRef.current.keys;
        const from = activeIndex === EFFORT_AUTO_INDEX ? 0 : activeIndex;
        const next = Math.max(0, Math.min(keys.length - 1, from + delta));
        if (next === activeIndex) return;
        hapticsSelection();
        commitRef.current?.(keys[next] ?? null);
    }, [activeIndex, enabled]);

    return React.useMemo<EffortSliderHandle>(() => ({
        active: state.phase !== 'closed',
        index: state.phase === 'closed' ? activeIndex : state.index,
        onPressIn,
        onMove,
        onRelease,
        tapStop,
        tapAuto,
        step,
        dismiss,
        state,
        placement,
    }), [activeIndex, dismiss, onMove, onPressIn, onRelease, placement, state, step, tapAuto, tapStop]);
}

const styles = StyleSheet.create((theme) => ({
    /**
     * The page-coordinate frame the popover is placed in.
     *
     * The capsule is the FIRST thing in the control row, so the row's own
     * gutter is all that stands between this wrapper and the screen's left
     * edge: `left: -shellInset` puts x=0 here at x=0 on the screen. The WIDTH
     * is set by the component from the window rather than by `right`, because
     * `right` would measure from the capsule's edge — wherever the model's
     * name happens to end — and not from the screen's.
     *
     * It sits ABOVE the control row, which is the whole point: the finger
     * stays on the capsule and the readout is somewhere it does not cover.
     */
    layer: {
        position: 'absolute',
        left: -MOBILE_COMPOSER_METRICS.shellInset,
        bottom: COMPOSER_SESSION_CONTROL_SIZE + CAPTION_GAP,
        height: EFFORT_SLIDER_POPOVER_HEIGHT,
    },
    capsule: {
        position: 'absolute',
        bottom: 0,
        height: EFFORT_SLIDER_METRICS.height,
        flexDirection: 'row',
        alignItems: 'center',
    },
    auto: {
        width: EFFORT_SLIDER_METRICS.autoWidth,
        height: EFFORT_SLIDER_METRICS.height,
        alignItems: 'center',
        justifyContent: 'center',
    },
    autoLabel: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    /** The same hairline the capsule uses between its segments (DROVE-153). */
    divider: {
        width: RNStyleSheet.hairlineWidth,
        height: 20,
        marginLeft: EFFORT_SLIDER_METRICS.autoGap / 2,
        marginRight: EFFORT_SLIDER_METRICS.autoGap / 2,
        backgroundColor: theme.colors.glass.divider,
    },
    track: {
        flex: 1,
        height: EFFORT_SLIDER_METRICS.height,
        justifyContent: 'center',
    },
    rail: {
        position: 'absolute',
        left: EFFORT_SLIDER_METRICS.trackPadding,
        right: EFFORT_SLIDER_METRICS.trackPadding,
        top: (EFFORT_SLIDER_METRICS.height - 3) / 2,
        height: 3,
        borderRadius: 1.5,
        backgroundColor: theme.colors.divider,
    },
    pip: {
        position: 'absolute',
        top: (EFFORT_SLIDER_METRICS.height - 5) / 2,
        width: 5,
        height: 5,
        borderRadius: 2.5,
        backgroundColor: theme.colors.divider,
    },
    pipTarget: {
        position: 'absolute',
        width: EFFORT_SLIDER_METRICS.minStopSpacing,
        top: 0,
        bottom: 0,
    },
    thumb: {
        position: 'absolute',
        top: (EFFORT_SLIDER_METRICS.height - THUMB_SIZE) / 2,
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        borderRadius: THUMB_SIZE / 2,
        borderWidth: 2.5,
        backgroundColor: theme.colors.surface,
    },
    caption: {
        position: 'absolute',
        top: 0,
        height: CAPTION_HEIGHT,
        paddingHorizontal: 8,
        borderRadius: CAPTION_HEIGHT / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    captionText: {
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
}));

/**
 * The popover. Rendered by the composer's control row as an absolutely
 * positioned sibling of the capsule rather than a child of it: the glass
 * surface clips to its own rounded bounds on the fallback material, and a
 * readout that disappears on a device without Liquid Glass is worse than no
 * readout at all.
 */
export function EffortSliderPopover(props: {
    handle: EffortSliderHandle;
    scale: EffortSliderScale;
}) {
    const { theme } = useUnistyles();
    const { width: screenWidth } = useWindowDimensions();
    const { handle, scale } = props;
    const placement = handle.placement;
    if (!handle.active || !placement || scale.keys.length === 0) return null;

    const latched = handle.state.phase === 'open';
    const palette = composerControlPalette(theme.dark);
    const index = handle.state.index;
    // The LIVE pick, not the one the gesture started from: grabbing a stop
    // takes the session off auto before the finger has even lifted.
    const onAuto = index === EFFORT_AUTO_INDEX;
    const thumbColour = effortColour(palette, index, scale.keys.length);
    const accessibility = effortSliderAccessibility(scale, index);
    const captionX = effortStopX(index, placement) - placement.left;
    return (
        <View
            style={[styles.layer, { width: screenWidth }]}
            pointerEvents={latched ? 'box-none' : 'none'}
        >
            <GlassChromeSurface
                radius={EFFORT_SLIDER_METRICS.height / 2}
                style={[styles.capsule, { left: placement.left, width: placement.width }]}
            >
                <BubblePressable
                    onPress={latched ? () => handle.tapAuto() : undefined}
                    disabled={!latched}
                    style={styles.auto}
                    accessibilityRole="button"
                    accessibilityLabel="Effort chosen automatically"
                    accessibilityState={{ selected: onAuto }}
                >
                    <Text
                        style={[styles.autoLabel, { color: onAuto ? palette.accent : palette.neutral }]}
                        numberOfLines={1}
                    >
                        Auto
                    </Text>
                </BubblePressable>
                <View style={styles.divider} />
                <View
                    style={styles.track}
                    accessible
                    accessibilityRole="adjustable"
                    accessibilityLabel={accessibility.label}
                    accessibilityValue={{ text: accessibility.value }}
                >
                    <View style={styles.rail} />
                    {scale.keys.map((key, stop) => {
                        const x = effortStopX(stop, placement) - placement.trackLeft
                            + EFFORT_SLIDER_METRICS.trackPadding;
                        if (stop === index) return null;
                        return (
                            <React.Fragment key={key}>
                                <View style={[styles.pip, { left: x - 2.5 }]} />
                                {latched ? (
                                    <BubblePressable
                                        onPress={() => handle.tapStop(stop)}
                                        style={[
                                            styles.pipTarget,
                                            { left: x - EFFORT_SLIDER_METRICS.minStopSpacing / 2 },
                                        ]}
                                        accessibilityRole="button"
                                        accessibilityLabel={effortSliderStopName(scale, stop)}
                                    />
                                ) : null}
                            </React.Fragment>
                        );
                    })}
                    <View
                        style={[
                            styles.thumb,
                            {
                                left: effortStopX(index, placement) - placement.trackLeft
                                    + EFFORT_SLIDER_METRICS.trackPadding - THUMB_SIZE / 2,
                                borderColor: thumbColour,
                            },
                        ]}
                    />
                </View>
            </GlassChromeSurface>
            {/* The word, above the thumb, so the drag says which level it is
                on before the finger lifts. Clamped inside the popover so it
                cannot hang off the end at either extreme. */}
            <View
                style={[
                    styles.caption,
                    {
                        left: Math.max(
                            placement.left,
                            Math.min(
                                placement.left + placement.width - CAPTION_WIDTH,
                                placement.left + captionX - CAPTION_WIDTH / 2,
                            ),
                        ),
                        width: CAPTION_WIDTH,
                        backgroundColor: theme.colors.surfaceHigh,
                    },
                ]}
            >
                <Text style={styles.captionText} numberOfLines={1}>
                    {effortSliderStopName(scale, index)}
                </Text>
            </View>
        </View>
    );
}
