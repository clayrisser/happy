import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusDot } from './StatusDot';
import { MicWaveform } from './MicWaveform';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { DictationCaptureState } from '@/voice/dictationCapture';
import { micOutcome } from '@/voice/micButton';
import {
    RECORDING_BANNER_FRAME,
    RECORDING_BANNER_HEIGHT,
} from './composerStripLayout';

/**
 * The indicator a live microphone cannot be without (DROVE-30, DROVE-74,
 * DROVE-105, DROVE-142).
 *
 * A latched mic is a hot mic until something stops it, and the thing that
 * has to stop it most often is the person who forgot it was on. So this is
 * red, it pulses, it shows the level moving as you speak, and it counts. The
 * words themselves land in the composer underneath, revised in place, so the
 * banner does not repeat them.
 *
 * It is an INDICATOR and not a control (DROVE-105): the Stop it used to
 * carry did the same thing as a second tap on the mic and sent, which is now
 * the one thing the latch must never do. The mic button is the only control.
 *
 * NO WORDS ON IT (DROVE-142). It used to say `Listening…` on the left and
 * `Release to send` on the right, and Clay struck both out. He is right on
 * both counts: a full-width red bar with a running clock and a moving
 * waveform is not ambiguous, so the first label spent a word on what the
 * colour and the motion already said, and the second is an instruction, which
 * earns its place on the first use and is clutter on every use after. The
 * left-hand one did not even fit; it rendered as `List...`, which is its own
 * small proof the row never had room for it.
 *
 * WHAT THE WORDS WERE ACTUALLY DOING, and where it went instead. The
 * right-hand label was not only an instruction: it was the state readout for
 * slide-off-to-cancel, the thing that says which way a lift will go BEFORE it
 * goes. Deleting it would have made the very failure Clay keeps hitting, a
 * sentence lost to a lift he could not predict, easier rather than harder. So
 * the state moved into three signals that need no reading:
 *
 * - COLOUR. Recording is red; armed to cancel turns the whole bar graphite.
 *   Cancel is deliberately not a second red, because red already means
 *   "recording" here and a warning drawn in the colour of the thing it warns
 *   about says nothing.
 * - THE LEADING MARK. Recording pulses a dot. Armed to cancel it is a solid
 *   cross, which does not pulse: the bar stops breathing at the same moment
 *   it changes colour.
 * - THE TRAILING GLYPH. What the next action does: an up arrow when the lift
 *   will send, a stop square when a tap will end the latch, a crossed circle
 *   when the lift will throw it away. Nothing at all in the half-second
 *   before a press has resolved into a tap or a hold, because the outcome
 *   genuinely is not decided yet and inventing one there would be a lie.
 *
 * The words survive for anyone who cannot see any of that: the accessibility
 * label still says the state and the pending action in full.
 *
 * WHERE IT SITS (DROVE-157). Under the composer card, pinned over the status
 * row, not above the text field inside the card. It used to be a child of the
 * card, so opening the mic grew the card, grew the dock and shoved the
 * transcript up; Clay lost his place in the chat every time he spoke. The
 * frame comes from `composerStripLayout` and is absolute, so the banner
 * contributes no height at all and the composer cannot move. That also put it
 * on a 20pt budget instead of 38, hence the smaller dot, clock and level
 * strip here. None of DROVE-142's signalling was dropped to fit: the colour,
 * the mark and the trailing glyph are all still on the bar.
 */
interface LiveMicBannerProps {
    talk: DictationCaptureState;
    /** The finger is down but off the button: this lift throws it away. */
    cancelArmed?: boolean;
    /**
     * The press has been recognised as a hold, so this lift SENDS (DROVE-140).
     * False during the half-second where the press could still be a tap.
     */
    sendArmed?: boolean;
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
 * and a warning drawn in the colour of the thing it warns about says nothing.
 * The whole banner changes, not a word in it, so it reads at a glance with a
 * thumb over the button.
 */
const graphite = '#48484A';

/**
 * Which glyph each outcome draws. The decision itself is `micOutcome` in
 * micButton.ts, which is pure and has a spec; this is only its picture.
 */
const outcomeGlyph = {
    cancel: 'close-circle' as const,
    send: 'arrow-up-circle' as const,
    stop: 'stop-circle' as const,
    undecided: null,
};

export const LiveMicBanner = React.memo(({
    talk,
    cancelArmed = false,
    sendArmed = false,
}: LiveMicBannerProps) => {
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (!talk.active) return;
        setNow(Date.now());
        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, [talk.active]);

    if (!talk.active || talk.since === null) return null;

    const latched = talk.mode === 'latch';
    const outcome = micOutcome({ latched, cancelArmed, sendArmed });
    const glyph = outcomeGlyph[outcome];

    // The words the screen no longer shows are still said here, in full, for
    // anyone reading the row rather than looking at it (DROVE-142).
    const title = latched ? t('agentInput.dictate.latched') : t('agentInput.dictate.listening');
    const hint = outcome === 'cancel'
        ? t('agentInput.dictate.releaseToCancel')
        : outcome === 'stop'
            ? t('agentInput.dictate.tapToStop')
            : outcome === 'send'
                ? t('agentInput.dictate.releaseToSend')
                : '';

    return (
        <View
            style={[styles.banner, cancelArmed && styles.bannerCancel]}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            accessibilityLabel={hint.length > 0 ? `${title}. ${hint}` : title}
        >
            <View style={styles.mark}>
                {cancelArmed
                    ? (
                        <Ionicons name="close" size={12} color="#FFFFFF" />
                    )
                    : (
                        <StatusDot color="#FFFFFF" isPulsing size={8} />
                    )}
            </View>
            <Text style={styles.elapsed} numberOfLines={1}>{formatElapsed(talk.since, now)}</Text>
            <View style={styles.wave}>
                <MicWaveform active={talk.active} color="#FFFFFF" height={12} />
            </View>
            {/* The slot is always there so nothing shifts when the glyph
                appears half a second into a press. */}
            <View style={styles.outcome}>
                {glyph !== null && <Ionicons name={glyph} size={16} color="#FFFFFF" />}
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    /**
     * The strip under the card, not a row inside it (DROVE-157). The frame is
     * absolute and comes from one place, so the guarantee that a recording
     * never resizes the composer is a layout rule rather than an agreement
     * between two numbers.
     */
    banner: {
        ...RECORDING_BANNER_FRAME,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        borderRadius: RECORDING_BANNER_HEIGHT / 2,
        backgroundColor: red,
        gap: 8,
    },
    bannerCancel: {
        backgroundColor: graphite,
    },
    mark: {
        width: 12,
        alignItems: 'center',
    },
    /**
     * The clock is the one piece of text left, and it is a readout rather than
     * a label. Tabular figures and a floor wide enough for `0:00` keep it from
     * jittering the row every second, and it never shrinks, so it cannot be
     * the thing that truncates.
     */
    elapsed: {
        color: '#FFFFFF',
        fontSize: 12,
        minWidth: 32,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    // The waveform takes every pixel the fixed pieces do not, so the row has
    // no contended space left to truncate anything in.
    wave: {
        flex: 1,
        alignItems: 'flex-end',
        overflow: 'hidden',
    },
    outcome: {
        width: 16,
        alignItems: 'center',
    },
});
