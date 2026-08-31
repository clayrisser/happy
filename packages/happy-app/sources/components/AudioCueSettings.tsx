import React from 'react';
import { Platform, Pressable, Switch, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { useSettingMutable } from '@/sync/storage';
import {
    audioCueTitlesPerRunRange,
    audioCueVolumeRange,
    audioCueWaitingIntervalRange,
    audioCueWorkingIntervalRange,
    resolveAudioCues,
    type AudioCues,
} from '@/sync/settings';
import { audioCues as cueTable } from '@/voice/audioCues';
import { audioCues as cueService } from '@/voice/audioCueService';
import { t } from '@/text';

/**
 * The eyes-free audio cue controls (DROVE-112).
 *
 * One screen for the whole vocabulary, because the whole point of the ticket
 * is that these sounds are one system with one mixer rather than a handful of
 * features that each learnt to make noise. Every cue can be silenced on its
 * own, and the lot with one switch, and every row plays itself so Clay can
 * learn the vocabulary sitting down rather than by waiting for a gate.
 */

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

function PlayButton(props: { onPress: () => void }) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            onPress={props.onPress}
            hitSlop={8}
            accessibilityLabel={t('settingsVoice.cues.play')}
            style={{ paddingHorizontal: 6 }}
        >
            <Ionicons name="play-circle-outline" size={26} color={theme.colors.button.primary.background} />
        </Pressable>
    );
}

export const AudioCueSettings = React.memo(function AudioCueSettings() {
    const [stored, setStored] = useSettingMutable('audioCues');
    const cues = React.useMemo(() => resolveAudioCues({ audioCues: stored }), [stored]);

    // Slider positions while the thumb is down; the setting is written on
    // release so a drag does not push a sync per pixel.
    const [volume, setVolume] = React.useState(cues.volume);
    const [workingEvery, setWorkingEvery] = React.useState(cues.workingIntervalSeconds);
    const [waitingEvery, setWaitingEvery] = React.useState(cues.waitingIntervalSeconds);
    const [perRun, setPerRun] = React.useState(cues.titlesPerRun);

    React.useEffect(() => {
        setVolume(cues.volume);
        setWorkingEvery(cues.workingIntervalSeconds);
        setWaitingEvery(cues.waitingIntervalSeconds);
        setPerRun(cues.titlesPerRun);
    }, [cues.volume, cues.workingIntervalSeconds, cues.waitingIntervalSeconds, cues.titlesPerRun]);

    const commit = React.useCallback((patch: Partial<AudioCues>) => {
        setStored({ ...cues, ...patch });
    }, [cues, setStored]);

    const toggleMute = React.useCallback((id: string, silenced: boolean) => {
        const next = silenced
            ? cues.muted.filter((entry) => entry !== id)
            : [...new Set([...cues.muted, id])];
        commit({ muted: next });
    }, [cues.muted, commit]);

    return (
        <>
            <ItemGroup title={t('settingsVoice.cues.title')} footer={t('settingsVoice.cues.footer')}>
                <Item
                    title={t('settingsVoice.cues.on')}
                    subtitle={t('settingsVoice.cues.onSubtitle')}
                    subtitleLines={0}
                    icon={<Ionicons name="pulse-outline" size={29} color="#FF2D55" />}
                    rightElement={<Switch value={cues.on} onValueChange={(on) => commit({ on })} />}
                />
                <Item
                    title={t('settingsVoice.cues.heartbeat')}
                    subtitle={t('settingsVoice.cues.heartbeatSubtitle')}
                    subtitleLines={0}
                    icon={<Ionicons name="heart-outline" size={29} color="#FF9500" />}
                    rightElement={
                        <Switch
                            value={cues.heartbeat}
                            disabled={!cues.on}
                            onValueChange={(heartbeat) => commit({ heartbeat })}
                        />
                    }
                />
                <SliderRow
                    label={t('settingsVoice.cues.volume')}
                    value={volume}
                    display={`${Math.round(volume * 100)}%`}
                    min={audioCueVolumeRange.min}
                    max={audioCueVolumeRange.max}
                    step={0.05}
                    onChange={setVolume}
                    onCommit={(value) => commit({ volume: value })}
                />
                <SliderRow
                    label={t('settingsVoice.cues.workingEvery')}
                    value={workingEvery}
                    display={t('settingsVoice.speaking.seconds', { seconds: Math.round(workingEvery) })}
                    min={audioCueWorkingIntervalRange.min}
                    max={audioCueWorkingIntervalRange.max}
                    step={1}
                    onChange={setWorkingEvery}
                    onCommit={(value) => commit({ workingIntervalSeconds: Math.round(value) })}
                />
                <SliderRow
                    label={t('settingsVoice.cues.waitingEvery')}
                    value={waitingEvery}
                    display={t('settingsVoice.speaking.seconds', { seconds: Math.round(waitingEvery) })}
                    min={audioCueWaitingIntervalRange.min}
                    max={audioCueWaitingIntervalRange.max}
                    step={1}
                    onChange={setWaitingEvery}
                    onCommit={(value) => commit({ waitingIntervalSeconds: Math.round(value) })}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsVoice.cues.titlesTitle')} footer={t('settingsVoice.cues.titlesFooter')}>
                <Item
                    title={t('settingsVoice.cues.speakTitles')}
                    icon={<Ionicons name="chatbox-ellipses-outline" size={29} color="#5856D6" />}
                    rightElement={
                        <Switch
                            value={cues.speakTitles}
                            onValueChange={(speakTitles) => commit({ speakTitles })}
                        />
                    }
                />
                <Item
                    title={t('settingsVoice.cues.agentTitles')}
                    subtitle={t('settingsVoice.cues.agentTitlesSubtitle')}
                    subtitleLines={0}
                    icon={<Ionicons name="git-branch-outline" size={29} color="#34C759" />}
                    rightElement={
                        <Switch
                            value={cues.speakAgentTitles}
                            disabled={!cues.speakTitles}
                            onValueChange={(speakAgentTitles) => commit({ speakAgentTitles })}
                        />
                    }
                />
                <Item
                    title={t('settingsVoice.cues.toolTitles')}
                    subtitle="Tool calls and terminal calls"
                    icon={<Ionicons name="terminal-outline" size={29} color="#007AFF" />}
                    rightElement={
                        <Switch
                            value={cues.speakToolTitles}
                            disabled={!cues.speakTitles}
                            onValueChange={(speakToolTitles) => commit({ speakToolTitles })}
                        />
                    }
                />
                <SliderRow
                    label={t('settingsVoice.cues.titlesPerRun')}
                    value={perRun}
                    display={String(Math.round(perRun))}
                    min={audioCueTitlesPerRunRange.min}
                    max={audioCueTitlesPerRunRange.max}
                    step={1}
                    onChange={setPerRun}
                    onCommit={(value) => commit({ titlesPerRun: Math.round(value) })}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsVoice.cues.tableTitle')} footer={t('settingsVoice.cues.tableFooter')}>
                {cueTable.map((cue) => {
                    const silenced = cues.muted.includes(cue.id);
                    return (
                        <Item
                            key={cue.id}
                            title={cue.title}
                            subtitle={cue.meaning}
                            subtitleLines={0}
                            icon={
                                <Ionicons
                                    name={cue.kind === 'ambient' ? 'radio-outline' : 'notifications-outline'}
                                    size={29}
                                    color={silenced ? '#8E8E93' : '#FF2D55'}
                                />
                            }
                            showChevron={false}
                            onPress={() => toggleMute(cue.id, silenced)}
                            rightElement={
                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                    <PlayButton onPress={() => cueService.preview(cue.id)} />
                                    <Switch
                                        value={!silenced}
                                        onValueChange={() => toggleMute(cue.id, silenced)}
                                    />
                                </View>
                            }
                        />
                    );
                })}
            </ItemGroup>
        </>
    );
});
