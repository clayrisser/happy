import React from 'react';
import { Platform, Pressable, Switch, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { useBackSwipeLock } from '@/hooks/useBackSwipeLock';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { useSettingMutable } from '@/sync/storage';
import {
    audioCueOffsetRange,
    audioCueRateRange,
    audioCueTitlesPerRunRange,
    audioCueVolumeRange,
    audioCueWaitingIntervalRange,
    audioCueWorkingIntervalRange,
    resolveAudioCues,
    type AudioCues,
} from '@/sync/settings';
import { isWorkingCue, workingCueFor, audioCues as cueTable } from '@/voice/audioCues';
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
    // UISlider is a native control on a pushed settings screen, so its drag
    // races the same swipe-back the effort slider lost to (DROVE-216).
    const backSwipe = useBackSwipeLock();
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
    const [vsVoice, setVsVoice] = React.useState(cues.volumeVsVoiceDb);
    const [workingEvery, setWorkingEvery] = React.useState(cues.workingIntervalSeconds);
    const [waitingEvery, setWaitingEvery] = React.useState(cues.waitingIntervalSeconds);
    const [perRun, setPerRun] = React.useState(cues.titlesPerRun);
    const [toolCap, setToolCap] = React.useState(cues.toolCuesPerMinute);
    const [agentCap, setAgentCap] = React.useState(cues.agentCuesPerMinute);

    React.useEffect(() => {
        setVolume(cues.volume);
        setVsVoice(cues.volumeVsVoiceDb);
        setWorkingEvery(cues.workingIntervalSeconds);
        setWaitingEvery(cues.waitingIntervalSeconds);
        setPerRun(cues.titlesPerRun);
        setToolCap(cues.toolCuesPerMinute);
        setAgentCap(cues.agentCuesPerMinute);
    }, [
        cues.volume,
        cues.volumeVsVoiceDb,
        cues.workingIntervalSeconds,
        cues.waitingIntervalSeconds,
        cues.titlesPerRun,
        cues.toolCuesPerMinute,
        cues.agentCuesPerMinute,
    ]);

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
                {/*
                  * THE TRIM, and the one row that plays itself (DROVE-385).
                  *
                  * Clay: "please boost the audio more so that the beeps are
                  * basically the same level of loudness as the voice." The
                  * table in cueLoudness.ts is calibrated against a measured
                  * voice, and a measurement on a build machine is not his ear
                  * in his pocket; this is the dB either side of it, so the next
                  * "a bit more" is a drag rather than a release.
                  *
                  * It previews the HEARTBEAT because the heartbeat is the sound
                  * he named, and it previews at the level the thumb is
                  * currently at rather than at the stored one -- `commit` runs
                  * on release, so pressing play here is asking "what does THIS
                  * setting sound like".
                  */}
                <SliderRow
                    label={t('settingsVoice.cues.vsVoice')}
                    value={vsVoice}
                    display={`${vsVoice > 0 ? '+' : ''}${Math.round(vsVoice)} dB`}
                    min={audioCueOffsetRange.min}
                    max={audioCueOffsetRange.max}
                    step={1}
                    onChange={setVsVoice}
                    onCommit={(value) => {
                        const next = Math.round(value);
                        commit({ volumeVsVoiceDb: next });
                        cueService.preview(workingCueFor(0), next);
                    }}
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
                <Item
                    title="Read thinking"
                    subtitle="read in place, lower and slower"
                    icon={<Ionicons name="bulb-outline" size={29} color="#FFCC00" />}
                    rightElement={
                        <Switch
                            value={cues.speakThinking}
                            onValueChange={(speakThinking) => commit({ speakThinking })}
                        />
                    }
                />
                <Item
                    title="Read questions and permissions"
                    subtitle="spoken ahead of the transcript"
                    icon={<Ionicons name="help-circle-outline" size={29} color="#FF3B30" />}
                    rightElement={
                        <Switch
                            value={cues.speakGates}
                            onValueChange={(speakGates) => commit({ speakGates })}
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

            {/*
              * The caps, visible rather than silent (DROVE-174). They used to
              * be hardcoded at 6 and 12 a minute with the excess dropped in
              * silence, which is what swallowed most of a tool burst. Zero is
              * off and zero is the default; a cue is still dropped when it
              * cannot be heard within four seconds of the thing it is about.
              */}
            <ItemGroup
                title="Sound rate"
                footer="Off means every event sounds."
            >
                <SliderRow
                    label="Tool ticks a minute"
                    value={toolCap}
                    display={toolCap <= 0 ? 'Off' : String(Math.round(toolCap))}
                    min={audioCueRateRange.min}
                    max={audioCueRateRange.max}
                    step={5}
                    onChange={setToolCap}
                    onCommit={(value) => commit({ toolCuesPerMinute: Math.round(value) })}
                />
                <SliderRow
                    label="Agent and reply sounds a minute"
                    value={agentCap}
                    display={agentCap <= 0 ? 'Off' : String(Math.round(agentCap))}
                    min={audioCueRateRange.min}
                    max={audioCueRateRange.max}
                    step={5}
                    onChange={setAgentCap}
                    onCommit={(value) => commit({ agentCuesPerMinute: Math.round(value) })}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsVoice.cues.tableTitle')} footer={t('settingsVoice.cues.tableFooter')}>
                {/*
                  * The working heartbeat has a variant per subagent count
                  * (DROVE-182), and they are ONE row: the sound is the same
                  * sound with a different rhythm, and a row per count would
                  * be a dozen ways to half-mute a heartbeat.
                  */}
                {cueTable.filter((cue) => cue.id === 'working' || !isWorkingCue(cue.id)).map((cue) => {
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
