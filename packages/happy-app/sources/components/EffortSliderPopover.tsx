import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { useBackSwipeLock } from '@/hooks/useBackSwipeLock';
import { hapticsSelection } from './haptics';
import { GlassChromeSurface } from './GlassChromeControl';
import { composerControlPalette, composerGlyphColour } from './composerControlColour';
import {
    EFFORT_AUTO_INDEX,
    EFFORT_POPOVER_DIVIDER_GEOMETRY,
    EFFORT_POPOVER_GEOMETRY,
    EFFORT_POPOVER_LABEL_GEOMETRY,
    EFFORT_POPOVER_PIP_GEOMETRY,
    EFFORT_POPOVER_RAIL_GEOMETRY,
    EFFORT_POPOVER_STOP_GEOMETRY,
    EFFORT_POPOVER_THUMB_GEOMETRY,
    EFFORT_POPOVER_THUMB_STOP_GEOMETRY,
    EFFORT_POPOVER_TRACK_GEOMETRY,
    EFFORT_SLIDER_METRICS,
    effortCommitKey,
    effortSliderAccessibility,
    effortSliderClosed,
    effortSliderIndex,
    effortSliderReduce,
    effortSliderStopName,
    type EffortSliderScale,
    type EffortSliderState,
    type EffortSliderStep,
} from './effortSlider';

/**
 * The effort readout: the strip above the composer row, and the hook that
 * drives it (DROVE-200, reworked by DROVE-229).
 *
 * The rules — where it lives, why it is not the dial, why the drag is a delta,
 * why `auto` is off the line, and why a write only ever happens on release —
 * are all in effortSlider.ts, which is pure and specced. This file draws them.
 *
 * IT IS A READOUT AND NOTHING ELSE NOW. DROVE-200 LATCHED it open on a tap,
 * with its stops tappable and a five second timer to put it away, so that a
 * tap was not a dead gesture. Clay: "Allow me to actually size this and
 * actually fully cover the width right when I click this. Or at least have it
 * centered. And if I click a second time it will go away." Every one of those
 * was the latch: it was narrow, it was anchored on his finger, a second tap
 * re-opened it and restarted its timer rather than dismissing it, and there
 * was no tap-outside and no back gesture either. So a tap opens the effort
 * SHEET instead — the same full-width shell the other pickers use — and this
 * surface lives exactly as long as the finger. It is `pointerEvents: 'none'`
 * throughout, which means there is no state anyone can be stuck in.
 *
 * AND IT SPANS THE COMPOSER, BY LAYOUT. The control stack hands it
 * `left: 0, right: 0` and its own gutter, so it is exactly as wide as the
 * bubble above it and nothing here computes an x. It used to draw itself in
 * page coordinates through a `left: -shellInset` frame, with the capsule
 * centred on the touch and clamped to the screen edges — a hand-placed anchor,
 * and the thing the ticket was filed about.
 *
 * WHAT IT REUSES RATHER THAN REDECIDES. The thumb reads the composer row's
 * foreground through `composerGlyphColour`, so the readout and the dial beside
 * it agree, and they agree on the foreground: DROVE-215 took the ramp off the
 * needle, and a thumb that stayed on a ramp would be the dial's colour
 * argument reopened one surface away. Its POSITION is what says which level
 * this is, and the word at the head says it in words. The material is
 * DROVE-153's chrome glass, and the strip is 44pt tall for the same reason
 * every other control is. The detent tick is `hapticsSelection`, which is an
 * INTERACTION haptic and is therefore silent while the phone's haptics switch
 * is off — its default (DROVE-190). Nothing here reaches expo-haptics, so
 * there is no way around that switch.
 */

export const EFFORT_SLIDER_POPOVER_HEIGHT = EFFORT_SLIDER_METRICS.height;

export interface EffortSliderHandle {
    /** A finger is on the segment and the readout is up. */
    active: boolean;
    /** The stop the thumb is on, for the dial underneath to follow live. */
    index: number;
    onPressIn(pageX: number): void;
    onMove(pageX: number): void;
    onRelease(): void;
    /** VoiceOver's increment and decrement, since a drag is not available there. */
    step(delta: number): void;
    dismiss(): void;
    state: EffortSliderState;
    /** How many stops the line has, which is what the drag is clamped to. */
    count: number;
}

/**
 * The gesture, as a hook.
 *
 * `onCommit` is called at most once per gesture, with the wire value: a key
 * for a level, `null` for `auto`, which is the reset `/effort auto`
 * (paneModelSync). It goes to the same `sessionSetAgentModes` the picker used,
 * so it lands through the path DROVE-164 fixed rather than a second one.
 *
 * `onTap` is a press that never moved. The caller opens the effort picker with
 * it, which is where every dismissal route lives (DROVE-229).
 */
export function useEffortSlider(input: {
    scale: EffortSliderScale;
    currentKey: string | null | undefined;
    onCommit?: (key: string | null) => void;
    onTap?: () => void;
    enabled?: boolean;
}): EffortSliderHandle {
    const { scale, currentKey, onCommit, onTap } = input;
    const enabled = input.enabled !== false && scale.keys.length > 0;
    // The screen's swipe-back, held for the drag (DROVE-216). Without it the
    // navigator takes the horizontal pan and the whole chat slides sideways
    // with the readout still up, which is what Clay photographed.
    const backSwipe = useBackSwipeLock();
    const [state, setState] = React.useState<EffortSliderState>(effortSliderClosed);
    const activeIndex = effortSliderIndex(scale, currentKey);
    const count = scale.keys.length;

    // Handlers read the live gesture through refs rather than closing over
    // it, so a move arriving between renders is reduced against what the
    // finger actually did last, not a stale copy.
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const commitRef = React.useRef(onCommit);
    commitRef.current = onCommit;
    const tapRef = React.useRef(onTap);
    tapRef.current = onTap;
    const scaleRef = React.useRef(scale);
    scaleRef.current = scale;

    /**
     * The one place a step is applied: the state lands, a crossed stop ticks,
     * and a commit — which only a release can produce — is written once. This
     * is where "one write on release" stops being a property of the reducer and
     * becomes a property of the control.
     */
    const apply = React.useCallback((stepped: EffortSliderStep) => {
        if (stepped.state !== stateRef.current) {
            stateRef.current = stepped.state;
            setState(stepped.state);
        }
        if (stepped.detent) hapticsSelection();
        if (stepped.commit) commitRef.current?.(effortCommitKey(scaleRef.current, stepped.commit));
        if (stepped.tap) tapRef.current?.();
    }, []);

    const dismiss = React.useCallback(() => {
        backSwipe.end();
        stateRef.current = effortSliderClosed;
        setState(effortSliderClosed);
    }, [backSwipe]);

    // The readout cannot outlive the scale it was drawn from: switching model
    // re-scales the line, and a thumb on a stop that no longer exists would be
    // a lie about what the session is on.
    const scaleSignature = scale.keys.join(' ');
    React.useEffect(() => {
        dismiss();
    }, [dismiss, scaleSignature]);

    const onPressIn = React.useCallback((pageX: number) => {
        if (!enabled) return;
        // Taken on touch-down, not on the first move: the pop recogniser
        // decides the moment the finger travels, so anything later is too late.
        backSwipe.begin();
        apply(effortSliderReduce(
            effortSliderClosed,
            { type: 'press-in', x: pageX, index: activeIndex },
            scaleRef.current.keys.length,
        ));
    }, [activeIndex, apply, backSwipe, enabled]);

    const onMove = React.useCallback((pageX: number) => {
        apply(effortSliderReduce(
            stateRef.current,
            { type: 'move', x: pageX },
            scaleRef.current.keys.length,
        ));
    }, [apply]);

    const onRelease = React.useCallback(() => {
        backSwipe.end();
        apply(effortSliderReduce(
            stateRef.current,
            { type: 'press-out' },
            scaleRef.current.keys.length,
        ));
    }, [apply, backSwipe]);

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
        step,
        dismiss,
        state,
        count,
    }), [activeIndex, count, dismiss, onMove, onPressIn, onRelease, state, step]);
}

const styles = StyleSheet.create((theme) => ({
    /**
     * The strip. It carries no width and no position of its own: the layer
     * around it is `left: 0, right: 0` inside the composer's gutter, and this
     * stretches to it. That is the whole placement rule (DROVE-229).
     */
    popover: EFFORT_POPOVER_GEOMETRY,
    label: {
        ...EFFORT_POPOVER_LABEL_GEOMETRY,
        alignItems: 'center',
        justifyContent: 'center',
    },
    labelText: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    /** The same rule the capsule draws between its own segments (DROVE-153). */
    divider: {
        ...EFFORT_POPOVER_DIVIDER_GEOMETRY,
        backgroundColor: theme.colors.glass.divider,
    },
    track: EFFORT_POPOVER_TRACK_GEOMETRY,
    rail: {
        ...EFFORT_POPOVER_RAIL_GEOMETRY,
        backgroundColor: theme.colors.divider,
    },
    stop: EFFORT_POPOVER_STOP_GEOMETRY,
    thumbStop: EFFORT_POPOVER_THUMB_STOP_GEOMETRY,
    pip: {
        ...EFFORT_POPOVER_PIP_GEOMETRY,
        backgroundColor: theme.colors.divider,
    },
    thumb: {
        ...EFFORT_POPOVER_THUMB_GEOMETRY,
        borderWidth: 2.5,
        backgroundColor: theme.colors.surface,
    },
}));

/**
 * The readout, drawn by the composer's control stack in a layer that spans the
 * composer's own gutter.
 *
 * It takes no touches at all. There is nothing to tap here since DROVE-229
 * moved `Auto` and the stops to the effort sheet, and a surface that takes no
 * touches cannot fight the chat's scroll responder for them either, which is
 * what the old latch's five second timer existed to avoid.
 */
export function EffortSliderPopover(props: {
    handle: EffortSliderHandle;
    scale: EffortSliderScale;
}) {
    const { theme } = useUnistyles();
    const { handle, scale } = props;
    if (!handle.active || scale.keys.length === 0) return null;

    const palette = composerControlPalette(theme.dark);
    // The LIVE pick, not the one the gesture started from: grabbing a stop
    // takes the session off auto before the finger has even lifted.
    const index = handle.state.index;
    const thumbAt = Math.max(0, Math.min(scale.keys.length - 1, index));
    const thumbColour = composerGlyphColour(palette);
    const accessibility = effortSliderAccessibility(scale, index);
    return (
        <GlassChromeSurface
            radius={EFFORT_SLIDER_METRICS.height / 2}
            style={styles.popover}
            pointerEvents="none"
        >
            {/* The word, in a slot of its own at the head. It was a caption
                floating over the thumb, clamped by hand so it could not hang
                off either end; one fixed slot cannot hang off anything, and
                the eye finds it in the same place every time. `Auto` reads
                here too, until the drag takes the session off it. */}
            <View style={styles.label}>
                <Text style={styles.labelText} numberOfLines={1}>
                    {effortSliderStopName(scale, index)}
                </Text>
            </View>
            <View style={styles.divider} />
            <View
                style={styles.track}
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel={accessibility.label}
                accessibilityValue={{ text: accessibility.value }}
            >
                <View style={styles.rail} />
                {scale.keys.map((key, stop) => (
                    <View key={key} style={stop === thumbAt ? styles.thumbStop : styles.stop}>
                        {stop === thumbAt ? (
                            <View style={[styles.thumb, { borderColor: thumbColour }]} />
                        ) : (
                            <View style={styles.pip} />
                        )}
                    </View>
                ))}
            </View>
        </GlassChromeSurface>
    );
}
