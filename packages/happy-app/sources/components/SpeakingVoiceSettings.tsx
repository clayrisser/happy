import React from 'react';
import { Linking, Platform, Pressable, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { speakUtterance, stopSpeaking, type SpeechVoice } from 'drover-speech';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { useSetting, useSettingMutable } from '@/sync/storage';
import {
    resolveStreamTalk,
    streamTalkLagRange,
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
 * which installed voice reads replies, with a Preview per voice, then speed,
 * pitch and the skip-ahead threshold, and a pointer to Settings when only
 * the compact voice is installed for the language.
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
}

function SliderRow(props: SliderRowProps) {
    const { theme } = useUnistyles();
    return (
        <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ fontSize: 16, color: theme.colors.text }}>{props.label}</Text>
                <Text style={{ fontSize: 15, color: theme.colors.textSecondary }}>{props.display}</Text>
            </View>
            <Slider
                value={props.value}
                minimumValue={props.min}
                maximumValue={props.max}
                step={props.step}
                onValueChange={props.onChange}
                onSlidingComplete={props.onCommit}
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
    const [pitch, setPitch] = React.useState(talk.pitch);
    const [lag, setLag] = React.useState(talk.maxLagSeconds);

    React.useEffect(() => {
        setRate(talk.rate);
        setPitch(talk.pitch);
        setLag(talk.maxLagSeconds);
    }, [talk.rate, talk.pitch, talk.maxLagSeconds]);

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

    const preview = React.useCallback(async (voiceId: string | null, key: string) => {
        // The reader must not be mid-reply under a preview, and a second tap
        // on the same row stops rather than restarts.
        readAloud.interrupt('typed');
        await stopSpeaking();
        if (previewing === key) {
            setPreviewing(null);
            return;
        }
        setPreviewing(key);
        try {
            await speakUtterance(t('settingsVoice.speaking.previewSentence'), {
                rate,
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
                <SliderRow
                    label={t('settingsVoice.speaking.rate')}
                    value={rate}
                    display={`${Math.round((rate / 0.5) * 100)}%`}
                    min={streamTalkRateRange.min}
                    max={streamTalkRateRange.max}
                    step={0.01}
                    onChange={setRate}
                    onCommit={(value) => commit({ rate: value })}
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
                    label={t('settingsVoice.speaking.lag')}
                    value={lag}
                    display={t('settingsVoice.speaking.seconds', { seconds: Math.round(lag) })}
                    min={streamTalkLagRange.min}
                    max={streamTalkLagRange.max}
                    step={1}
                    onChange={setLag}
                    onCommit={(value) => commit({ maxLagSeconds: Math.round(value) })}
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
