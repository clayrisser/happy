import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { addDictationLevelListener } from 'drover-speech';
import {
    BASELINE_BAR_HEIGHT,
    flatWaveform,
    levelToHeight,
    pushLevel,
    rmsToLevel,
    WAVEFORM_BARS,
} from '@/voice/micLevel';

/**
 * The scrolling level strip beside a live mic (DROVE-74, DROVE-383).
 *
 * Driven by the REAL input level: the native tap reports an RMS per buffer
 * and each one becomes the newest bar on the right. A clock pushes a zero
 * whenever no level has arrived for a while, so the strip keeps scrolling
 * in silence and on a build that has no level event at all it is a flat,
 * moving line, which is what "the mic is open but nothing is being
 * measured" honestly looks like. A dead mic is visible: the line never
 * moves off the floor while you speak.
 *
 * Owns its own subscription and state so that twenty updates a second touch
 * this component and nothing above it.
 *
 * BARS, NOT DOTS (DROVE-383). Clay's words were "the little white Fourier
 * transforms are so tiny", and they were: a 2pt floor on a 12pt canvas left
 * ordinary speech drawing four to seven points, so the strip read as a row of
 * identical dots that flickered. The height mapping moved into `micLevel` and
 * spends the range properly; here the strip simply got the pill's inner
 * height instead of a number that fit twice over.
 *
 * WHY SCALEY AND NOT HEIGHT. A bar is a fixed-height view scaled about its
 * centre, so a level update is a transform and not a layout prop. Twenty of
 * those a second used to re-measure forty-eight views; now Yoga is not
 * involved at all, and the centred scaling is what gives the strip a
 * waveform's symmetry about a midline rather than a bar chart's baseline.
 */
interface MicWaveformProps {
    active: boolean;
    color: string;
    height?: number;
    width?: number;
}

/** No level for this long is treated as silence and scrolls a zero in. */
const SILENCE_TICK_MS = 100;

/**
 * The ceiling on commits: one a frame at 60fps, never more. The native tap is
 * already throttled to twenty a second (`DroverSpeechModule.swift`), so today
 * this never fires; it is here so a faster emitter tomorrow cannot turn the
 * strip into a render loop.
 */
const FRAME_MS = 16;

/** Every bar but the newest. The live one is full white, so the edge leads. */
const TRAIL_OPACITY = 0.9;

const BAR_WIDTH = 2;
const BAR_GAP = 2;

export const MicWaveform = React.memo(({ active, color, height = 16, width }: MicWaveformProps) => {
    const [levels, setLevels] = React.useState<number[]>(() => flatWaveform());
    const lastLevelAt = React.useRef(0);
    const lastCommitAt = React.useRef(0);

    React.useEffect(() => {
        if (!active) {
            setLevels(flatWaveform());
            return;
        }
        const subscription = addDictationLevelListener((rms) => {
            const now = Date.now();
            lastLevelAt.current = now;
            if (now - lastCommitAt.current < FRAME_MS) return;
            lastCommitAt.current = now;
            setLevels((prev) => pushLevel(prev, rmsToLevel(rms)));
        });
        const clock = setInterval(() => {
            const now = Date.now();
            if (now - lastLevelAt.current < SILENCE_TICK_MS) return;
            lastCommitAt.current = now;
            setLevels((prev) => pushLevel(prev, 0));
        }, SILENCE_TICK_MS);
        return () => {
            subscription.remove();
            clearInterval(clock);
        };
    }, [active]);

    const newest = levels.length - 1;
    return (
        <View
            style={[styles.strip, { height, width }]}
            pointerEvents="none"
            accessible={false}
            importantForAccessibility="no-hide-descendants"
        >
            {levels.map((level, index) => (
                <View
                    key={index}
                    style={[
                        styles.bar,
                        {
                            backgroundColor: color,
                            height,
                            opacity: index === newest ? 1 : TRAIL_OPACITY,
                            transform: [{ scaleY: levelToHeight(level, height) / height }],
                        },
                    ]}
                />
            ))}
        </View>
    );
});

const styles = StyleSheet.create({
    strip: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: BAR_GAP,
        overflow: 'hidden',
        minWidth: WAVEFORM_BARS * (BAR_WIDTH + BAR_GAP),
    },
    bar: {
        width: BAR_WIDTH,
        // A bar scaled down to the baseline is a rounded cap, not a rectangle,
        // so silence still reads as a line rather than a row of ticks.
        borderRadius: BASELINE_BAR_HEIGHT / 2,
    },
});
