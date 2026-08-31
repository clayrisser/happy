import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusDot } from './StatusDot';
import { MicWaveform } from './MicWaveform';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { DictationCaptureState } from '@/voice/dictationCapture';

/**
 * The indicator a live microphone cannot be without (DROVE-30, DROVE-74,
 * DROVE-105).
 *
 * A latched mic is a hot mic until something stops it, and the thing that
 * has to stop it most often is the person who forgot it was on. So this is
 * red, it pulses, it shows the level moving as you speak, and it counts.
 * Drawn for hold-to-talk as well, where it says release to send, because one
 * indicator that always means "you are being recorded" is worth more than
 * two that mean it sometimes. The words themselves land in the composer
 * underneath, revised in place, so the banner does not repeat them.
 *
 * It is an INDICATOR and not a control (DROVE-105): the Stop it used to
 * carry did the same thing as a second tap on the mic and sent, which is now
 * the one thing the latch must never do. The mic button is the only control.
 *
 * The one thing it does say back is which way a lift will go. With the
 * finger slid off the button it turns graphite and says release to cancel,
 * so the outcome is readable before it happens rather than after.
 */
interface LiveMicBannerProps {
    talk: DictationCaptureState;
    /** The finger is down but off the button: this lift throws it away. */
    cancelArmed?: boolean;
}

function formatElapsed(since: number, now: number): string {
    const total = Math.max(0, Math.floor((now - since) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const red = '#FF3B30';
/**
 * Cancel is graphite, not a second red: red already means "recording" here,
 * and a warning drawn in the colour of the thing it warns about says
 * nothing. The whole banner changes, not a word in it, so it reads at a
 * glance with a thumb over the button.
 */
const graphite = '#48484A';

export const LiveMicBanner = React.memo(({ talk, cancelArmed = false }: LiveMicBannerProps) => {
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (!talk.active) return;
        setNow(Date.now());
        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, [talk.active]);

    if (!talk.active || talk.since === null) return null;

    const latched = talk.mode === 'latch';
    const title = latched ? t('agentInput.dictate.latched') : t('agentInput.dictate.listening');
    // What the next lift will do, in the same slot the send hint lives in.
    const hint = cancelArmed
        ? t('agentInput.dictate.releaseToCancel')
        : latched
            ? t('agentInput.dictate.tapToStop')
            : t('agentInput.dictate.releaseToSend');

    return (
        <View
            style={[styles.banner, cancelArmed && styles.bannerCancel]}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            accessibilityLabel={`${title}. ${hint}`}
        >
            <View style={styles.dot}>
                <StatusDot color="#FFFFFF" isPulsing size={10} />
            </View>
            <View style={styles.words}>
                <Text style={styles.title} numberOfLines={1}>
                    {title}
                </Text>
                <Text style={styles.elapsed}>{formatElapsed(talk.since, now)}</Text>
            </View>
            <MicWaveform active={talk.active} color="#FFFFFF" height={22} />
            <Text style={styles.hint} numberOfLines={1}>{hint}</Text>
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
    bannerCancel: {
        backgroundColor: graphite,
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
    hint: {
        color: 'rgba(255,255,255,0.85)',
        fontSize: 11,
        ...Typography.default(),
    },
});
