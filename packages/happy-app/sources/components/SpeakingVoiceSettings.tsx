import React from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { useBackSwipeLock } from '@/hooks/useBackSwipeLock';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { speakUtterance, stopSpeaking, type SpeechVoice } from 'drover-speech';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { useSetting, useSettingMutable } from '@/sync/storage';
import {
    resolveStreamTalk,
    streamTalkBacklogRange,
    streamTalkCatchUpRateRange,
    streamTalkJumpRange,
    streamTalkPitchRange,
    streamTalkRateRange,
    type StreamTalk,
} from '@/sync/settings';
import { installedVoices, speechLanguage } from '@/voice/speechEngine';
import { hasNaturalVoice, pickVoice, sortVoicesByQuality, voicesForLanguage } from '@/voice/voicePick';
import { readAloud } from '@/voice/readAloudService';
import { t } from '@/text';

/**
 * The stream-talk voice controls on the voice settings screen (DROVE-97):
 * which installed voice reads replies, with a Preview per voice, then the
 * delivery, and a pointer to Settings when only the compact voice is installed
 * for the language.
 *
 * The delivery is four plain statements since DROVE-116 — the normal speed,
 * the fast speed, when to speed up, and when to jump — plus pitch. Clay: "you
 * pick the speed you want it normally but then as it gets behind you pick the
 * fast speed", and "we can also set when it jumps". Each pair is kept in order
 * as it is dragged: the fast speed can never be set slower than the normal
 * one, and the jump can never happen before the speed-up. The two speed rows
 * each carry their own preview, because the fast one is only judgeable
 * against the normal one.
 *
 * The pick itself is pickVoice in sources/voice/voicePick.ts; this screen
 * shows the same list it picks from so "Automatic" says which voice it means.
 */

function qualityLabel(voice: SpeechVoice): string {
    if (voice.personal) return t('settingsVoice.speaking.personal');
    if (voice.quality === 'premium') return t('settingsVoice.speaking.qualityPremium');
    if (voice.quality === 'enhanced') return t('settingsVoice.speaking.qualityEnhanced');
    return t('settingsVoice.speaking.qualityDefault');
}

function PreviewButton(props: { active: boolean; onPress: () => void }) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={props.onPress}
            hitSlop={8}
            accessibilityLabel={t('settingsVoice.speaking.preview')}
            style={{ paddingHorizontal: 6 }}
        >
            <Ionicons
                name={props.active ? 'stop-circle' : 'play-circle-outline'}
                size={26}
                color={theme.colors.button.primary.background}
            />
        </Pressable>
    );
}

interface SliderRowProps {
    label: string;
    value: number;
    display: string;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
    onCommit: (value: number) => void;
    /**
     * Hear THIS slider (DROVE-116). A row that sets a speaking rate carries
     * its own preview, because two speeds a screen apart cannot be judged
     * against one shared play button: the point of the fast one is how it
     * sounds compared with the normal one.
     */
    onPreview?: () => void;
    previewing?: boolean;
}

function SliderRow(props: SliderRowProps) {
    const { theme } = useUnistyles();
    // UISlider is a native control on a pushed settings screen, so its drag
    // races the same swipe-back the effort slider lost to (DROVE-216).
    const backSwipe = useBackSwipeLock();
    return (
        <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Text style={{ fontSize: 16, color: theme.colors.text }}>{props.label}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={{ fontSize: 15, color: theme.colors.textSecondary }}>{props.display}</Text>
                    {props.onPreview ? (
                        <PreviewButton active={props.previewing === true} onPress={props.onPreview} />
                    ) : null}
                </View>
            </View>
            <Slider
                value={props.value}
                minimumValue={props.min}
                maximumValue={props.max}
                step={props.step}
                onValueChange={props.onChange}
                onSlidingStart={backSwipe.begin}
                onSlidingComplete={(value) => {
                    backSwipe.end();
                    props.onCommit(value);
                }}
                minimumTrackTintColor={theme.colors.button.primary.background}
                maximumTrackTintColor={theme.colors.divider}
                style={{ width: '100%', height: Platform.select({ ios: 32, default: 40 }) }}
            />
        </View>
    );
}

export const SpeakingVoiceSettings = React.memo(function SpeakingVoiceSettings() {
    const { theme } = useUnistyles();
    const [stored, setStored] = useSettingMutable('streamTalk');
    // Re-render when the assistant language changes: the list is per language.
    const assistantLanguage = useSetting('voiceAssistantLanguage');
    const talk = React.useMemo(() => resolveStreamTalk({ streamTalk: stored }), [stored]);
    const language = React.useMemo(() => speechLanguage(), [assistantLanguage]);

    const [voices, setVoices] = React.useState<SpeechVoice[]>([]);
    const [previewing, setPreviewing] = React.useState<string | null>(null);
    // Slider positions while the thumb is down; settings are written on release
    // so a drag does not push a sync per pixel.
    const [rate, setRate] = React.useState(talk.rate);
    const [catchUpRate, setCatchUpRate] = React.useState(talk.catchUpRate);
    const [pitch, setPitch] = React.useState(talk.pitch);
    const [backlog, setBacklog] = React.useState(talk.maxBacklogSeconds);
    const [jump, setJump] = React.useState(talk.jumpBacklogSeconds);

    React.useEffect(() => {
        setRate(talk.rate);
        setCatchUpRate(talk.catchUpRate);
        setPitch(talk.pitch);
        setBacklog(talk.maxBacklogSeconds);
        setJump(talk.jumpBacklogSeconds);
    }, [talk.rate, talk.catchUpRate, talk.pitch, talk.maxBacklogSeconds, talk.jumpBacklogSeconds]);

    React.useEffect(() => {
        let cancelled = false;
        // Refreshed on every visit: the user may have just downloaded a voice.
        void installedVoices(true).then((list) => {
            if (!cancelled) setVoices(list);
        });
        return () => {
            cancelled = true;
            void stopSpeaking();
        };
    }, []);

    const candidates = React.useMemo(
        () => sortVoicesByQuality(voicesForLanguage(voices, language)),
        [voices, language],
    );
    const automatic = React.useMemo(() => pickVoice(voices, language, null), [voices, language]);
    const natural = React.useMemo(() => hasNaturalVoice(voices, language), [voices, language]);
    const chosenInstalled = talk.voiceId !== null && voices.some((voice) => voice.identifier === talk.voiceId);

    const commit = React.useCallback((patch: Partial<StreamTalk>) => {
        setStored({ ...talk, ...patch });
    }, [talk, setStored]);

    const preview = React.useCallback(async (voiceId: string | null, key: string, atRate?: number) => {
        // The reader must not be mid-reply under a preview, and a second tap
        // on the same row stops rather than restarts. Its own reason since
        // DROVE-162: this is the last place that really does want the voice
        // stopped, and calling it 'typed' would have kept the name alive for
        // something typing no longer does.
        readAloud.interrupt('preview');
        await stopSpeaking();
        if (previewing === key) {
            setPreviewing(null);
            return;
        }
        setPreviewing(key);
        try {
            await speakUtterance(t('settingsVoice.speaking.previewSentence'), {
                // Whichever slider is being adjusted, at the speed it is set
                // to right now rather than the one in settings (DROVE-116).
                rate: atRate ?? rate,
                pitch,
                voiceId: voiceId ?? pickVoice(voices, language, null)?.identifier ?? null,
                language,
            });
        } finally {
            setPreviewing((current) => (current === key ? null : current));
            await stopSpeaking();
        }
    }, [previewing, rate, pitch, voices, language]);

    const openSettings = React.useCallback(() => {
        // Accessibility > Spoken Content > Voices has no deep link; the app's
        // own settings page is as close as iOS lets a third party get.
        void Linking.openURL('app-settings:').catch(() => Linking.openSettings());
    }, []);

    const check = <Ionicons name="checkmark-circle" size={24} color={theme.colors.button.primary.background} />;

    return (
        <>
            <ItemGroup
                title={t('settingsVoice.speaking.title')}
                footer={t('settingsVoice.speaking.footer')}
            >
                <Item
                    title={t('settingsVoice.speaking.automatic')}
                    subtitle={automatic
                        ? t('settingsVoice.speaking.automaticSubtitle', { name: `${automatic.name} (${qualityLabel(automatic)})` })
                        : t('settingsVoice.speaking.automaticNone')}
                    icon={<Ionicons name="sparkles-outline" size={29} color="#34C759" />}
                    showChevron={false}
                    onPress={() => commit({ voiceId: null })}
                    rightElement={
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <PreviewButton active={previewing === 'auto'} onPress={() => { void preview(null, 'auto'); }} />
                            {!chosenInstalled ? check : null}
                        </View>
                    }
                />
                {candidates.map((voice) => (
                    <Item
                        key={voice.identifier}
                        title={voice.name}
                        subtitle={`${qualityLabel(voice)} · ${voice.language}`}
                        icon={<Ionicons name="person-circle-outline" size={29} color="#5856D6" />}
                        showChevron={false}
                        onPress={() => commit({ voiceId: voice.identifier })}
                        rightElement={
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <PreviewButton
                                    active={previewing === voice.identifier}
                                    onPress={() => { void preview(voice.identifier, voice.identifier); }}
                                />
                                {talk.voiceId === voice.identifier ? check : null}
                            </View>
                        }
                    />
                ))}
                {!natural ? (
                    <Item
                        title={t('settingsVoice.speaking.openSettings')}
                        subtitle={t('settingsVoice.speaking.noNaturalVoice', { language })}
                        subtitleLines={0}
                        icon={<Ionicons name="cloud-download-outline" size={29} color="#FF9500" />}
                        onPress={openSettings}
                    />
                ) : null}
            </ItemGroup>

            <ItemGroup
                title={t('settingsVoice.speaking.deliveryTitle')}
                footer={t('settingsVoice.speaking.deliveryFooter')}
            >
                {/* Four plain statements (DROVE-116): the normal speed, the
                    fast speed, when to speed up, and when to jump. Each pair
                    is kept in order as it is dragged, so the fast speed can
                    never end up slower than the normal one and the jump can
                    never happen before the speed-up. */}
                <SliderRow
                    label={t('settingsVoice.speaking.rate')}
                    value={rate}
                    display={`${Math.round((rate / 0.5) * 100)}%`}
                    min={streamTalkRateRange.min}
                    max={streamTalkRateRange.max}
                    step={0.01}
                    onChange={(value) => {
                        setRate(value);
                        setCatchUpRate((fast) => Math.max(fast, value));
                    }}
                    onCommit={(value) => commit({ rate: value, catchUpRate: Math.max(catchUpRate, value) })}
                    previewing={previewing === 'rate'}
                    onPreview={() => { void preview(chosenInstalled ? talk.voiceId : null, 'rate', rate); }}
                />
                <SliderRow
                    label={t('settingsVoice.speaking.catchUpRate')}
                    value={catchUpRate}
                    display={`${Math.round((catchUpRate / 0.5) * 100)}%`}
                    min={rate}
                    max={streamTalkCatchUpRateRange.max}
                    step={0.01}
                    onChange={setCatchUpRate}
                    onCommit={(value) => commit({ catchUpRate: Math.max(rate, value) })}
                    previewing={previewing === 'catchUpRate'}
                    onPreview={() => { void preview(chosenInstalled ? talk.voiceId : null, 'catchUpRate', catchUpRate); }}
                />
                <SliderRow
                    label={t('settingsVoice.speaking.pitch')}
                    value={pitch}
                    display={`${pitch.toFixed(2)}×`}
                    min={streamTalkPitchRange.min}
                    max={streamTalkPitchRange.max}
                    step={0.05}
                    onChange={setPitch}
                    onCommit={(value) => commit({ pitch: value })}
                />
                <SliderRow
                    label={t('settingsVoice.speaking.backlog')}
                    value={backlog}
                    display={t('settingsVoice.speaking.seconds', { seconds: Math.round(backlog) })}
                    min={streamTalkBacklogRange.min}
                    max={streamTalkBacklogRange.max}
                    step={1}
                    onChange={(value) => {
                        setBacklog(value);
                        setJump((at) => Math.max(at, Math.round(value) + 1));
                    }}
                    onCommit={(value) => commit({
                        maxBacklogSeconds: Math.round(value),
                        jumpBacklogSeconds: Math.max(jump, Math.round(value) + 1),
                    })}
                />
                <SliderRow
                    label={t('settingsVoice.speaking.jump')}
                    value={jump}
                    display={t('settingsVoice.speaking.seconds', { seconds: Math.round(jump) })}
                    min={Math.round(backlog) + 1}
                    max={streamTalkJumpRange.max}
                    step={1}
                    onChange={setJump}
                    onCommit={(value) => commit({ jumpBacklogSeconds: Math.max(Math.round(backlog) + 1, Math.round(value)) })}
                />
                <Item
                    title={t('settingsVoice.speaking.preview')}
                    subtitle={t('settingsVoice.speaking.previewSentence')}
                    subtitleLines={0}
                    icon={<Ionicons name="play-outline" size={29} color="#007AFF" />}
                    showChevron={false}
                    onPress={() => { void preview(chosenInstalled ? talk.voiceId : null, 'delivery'); }}
                    rightElement={<PreviewButton active={previewing === 'delivery'} onPress={() => { void preview(chosenInstalled ? talk.voiceId : null, 'delivery'); }} />}
                />
            </ItemGroup>
        </>
    );
});
