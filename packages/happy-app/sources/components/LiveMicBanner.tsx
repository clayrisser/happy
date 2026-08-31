import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusDot } from './StatusDot';
import { MicWaveform } from './MicWaveform';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { DictationCaptureState } from '@/voice/dictationCapture';

/**
 * The indicator a live microphone cannot be without (DROVE-30, DROVE-74).
 *
 * A latched mic is a hot mic until something stops it, and the thing that
 * has to stop it most often is the person who forgot it was on. So this is
 * red, it pulses, it shows the level moving as you speak, it counts, and
 * under a latch it carries the Stop. Drawn for hold-to-talk as well, where
 * it says release to send, because one indicator that always means "you are
 * being recorded" is worth more than two that mean it sometimes. The words
 * themselves land in the composer underneath, revised in place, so the
 * banner does not repeat them.
 */
interface LiveMicBannerProps {
    talk: DictationCaptureState;
    onStop: () => void;
}

function formatElapsed(since: number, now: number): string {
    const total = Math.max(0, Math.floor((now - since) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const red = '#FF3B30';

export const LiveMicBanner = React.memo(({ talk, onStop }: LiveMicBannerProps) => {
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (!talk.active) return;
        setNow(Date.now());
        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, [talk.active]);

    if (!talk.active || talk.since === null) return null;

    const latched = talk.mode === 'latch';

    return (
        <View
            style={styles.banner}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            accessibilityLabel={latched ? t('agentInput.dictate.latched') : t('agentInput.dictate.listening')}
        >
            <View style={styles.dot}>
                <StatusDot color="#FFFFFF" isPulsing size={10} />
            </View>
            <View style={styles.words}>
                <Text style={styles.title} numberOfLines={1}>
                    {latched ? t('agentInput.dictate.latched') : t('agentInput.dictate.listening')}
                </Text>
                <Text style={styles.elapsed}>{formatElapsed(talk.since, now)}</Text>
            </View>
            <MicWaveform active={talk.active} color="#FFFFFF" height={22} />
            {latched ? (
                <Pressable
                    onPress={onStop}
                    hitSlop={8}
                    style={({ pressed }) => [styles.stop, pressed && { opacity: 0.7 }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('agentInput.dictate.tapToStop')}
                >
                    <Ionicons name="stop" size={14} color={red} />
                    <Text style={styles.stopText}>{t('agentInput.dictate.stop')}</Text>
                </Pressable>
            ) : (
                <Text style={styles.hint}>{t('agentInput.dictate.releaseToSend')}</Text>
            )}
        </View>
    );
});

const styles = StyleSheet.create({
    banner: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 10,
        marginTop: 8,
        marginBottom: 2,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 14,
        backgroundColor: red,
        gap: 8,
    },
    dot: {
        width: 14,
        alignItems: 'center',
    },
    words: {
        flexShrink: 1,
    },
    title: {
        color: '#FFFFFF',
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    elapsed: {
        color: 'rgba(255,255,255,0.85)',
        fontSize: 12,
        fontVariant: ['tabular-nums'],
        ...Typography.default(),
    },
    stop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 10,
        backgroundColor: '#FFFFFF',
    },
    stopText: {
        color: red,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    hint: {
        color: 'rgba(255,255,255,0.85)',
        fontSize: 11,
        ...Typography.default(),
    },
});
