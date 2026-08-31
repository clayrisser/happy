import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { addDictationLevelListener } from 'drover-speech';
import { flatWaveform, pushLevel, rmsToLevel, WAVEFORM_BARS } from '@/voice/micLevel';

/**
 * The scrolling level strip beside a live mic (DROVE-74).
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
 */
interface MicWaveformProps {
    active: boolean;
    color: string;
    height?: number;
    width?: number;
}

/** No level for this long is treated as silence and scrolls a zero in. */
const SILENCE_TICK_MS = 100;

export const MicWaveform = React.memo(({ active, color, height = 22, width }: MicWaveformProps) => {
    const [levels, setLevels] = React.useState<number[]>(() => flatWaveform());
    const lastLevelAt = React.useRef(0);

    React.useEffect(() => {
        if (!active) {
            setLevels(flatWaveform());
            return;
        }
        const subscription = addDictationLevelListener((rms) => {
            lastLevelAt.current = Date.now();
            setLevels((prev) => pushLevel(prev, rmsToLevel(rms)));
        });
        const clock = setInterval(() => {
            if (Date.now() - lastLevelAt.current < SILENCE_TICK_MS) return;
            setLevels((prev) => pushLevel(prev, 0));
        }, SILENCE_TICK_MS);
        return () => {
            subscription.remove();
            clearInterval(clock);
        };
    }, [active]);

    // A bar is never shorter than a dot, so the flat line is still a line.
    const floor = 2;
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
                            height: Math.max(floor, Math.round(level * height)),
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
        gap: 2,
        overflow: 'hidden',
        minWidth: WAVEFORM_BARS * 4,
    },
    bar: {
        width: 2,
        borderRadius: 1,
    },
});
