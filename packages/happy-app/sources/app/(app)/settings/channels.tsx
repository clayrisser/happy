/**
 * Settings > Channels (DROVE-72): the three feedback channels and the four
 * ways of working, in full.
 *
 * The composer's long-press sheet is the shortcut; this is the page. Same
 * hook, same rows, plus the one setting the sheet leaves out: how audio may
 * ANSWER, which a mode sets and which DROVE-73 measured before anyone built
 * the listener for it.
 */

import * as React from 'react';
import { Platform, Switch } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { useDroverChannels } from '@/hooks/useDroverChannels';
import { audioRows, MODE_COPY, modeTitle } from '@/sync/droverChannels';
import type { DroverAnswerAudio } from '@/sync/settings';
import { useLocalSettingMutable } from '@/sync/storage';
import { t } from '@/text';

const answerAudioChoices: { value: DroverAnswerAudio; title: string; subtitle: string }[] = [
    { value: 'off', title: 'Only a screen answers', subtitle: 'Tap or type. Audio never resolves a prompt.' },
    { value: 'click', title: 'Headphone click', subtitle: 'Single press picks, double press next, triple press back. Needs a listening session the app starts in the foreground (DROVE-73).' },
    { value: 'speech', title: 'Dictation', subtitle: 'Say the option. Matched against the labels read out.' },
    { value: 'both', title: 'Click or dictation', subtitle: 'Whichever comes first.' },
];

export default function ChannelsScreen() {
    const channels = useDroverChannels();
    // Stream-talk is local to this handset; the drover audio channel is
    // synced. Two settings, one Audio group, one row each (DROVE-100).
    const [readAloudEnabled, setReadAloudEnabled] = useLocalSettingMutable('readAloudEnabled');
    // Device-local and off by default (DROVE-190): the wrist taps him, the
    // phone does not.
    const [phoneHaptics, setPhoneHaptics] = useLocalSettingMutable('phoneHaptics');
    const rows = audioRows({ announceAudio: channels.toggles.announceAudio, readAloudEnabled });

    return (
        <>
            <Stack.Screen options={{ title: 'Channels' }} />
            <ItemList containerStyle={{ paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0 }}>
                {channels.error && (
                    <ItemGroup>
                        <Item
                            title="The Mac refused that"
                            subtitle={channels.error}
                            subtitleLines={0}
                            icon={<Ionicons name="warning-outline" size={29} color="#FF9500" />}
                            showChevron={false}
                        />
                    </ItemGroup>
                )}

                <ItemGroup
                    title="Mode"
                    footer={channels.mode
                        ? `${modeTitle(channels.mode)}: ${MODE_COPY[channels.mode]?.subtitle ?? 'a combination saved on the Mac.'}`
                        : 'The switches below spell no saved mode. Pick one to set all of them at once, or leave them as they are.'}
                >
                    {channels.modes.map(({ name }) => (
                        <Item
                            key={name}
                            title={modeTitle(name)}
                            subtitle={MODE_COPY[name]?.subtitle}
                            subtitleLines={0}
                            selected={channels.mode === name}
                            loading={channels.busy && channels.mode !== name}
                            showChevron={false}
                            onPress={() => { void channels.pickMode(name); }}
                        />
                    ))}
                </ItemGroup>

                <ItemGroup
                    title="Announce"
                    footer="Any combination. Mirrored to every Mac."
                >
                    <Item
                        title="Visual"
                        subtitle="The alert push, the card, the watch face"
                        icon={<Ionicons name="phone-portrait-outline" size={29} color="#007AFF" />}
                        showChevron={false}
                        rightElement={(
                            <Switch
                                value={channels.toggles.announceVisual}
                                onValueChange={(value) => { void channels.setToggle('announceVisual', value); }}
                                accessibilityLabel="Visual"
                            />
                        )}
                    />
                    <Item
                        title="Haptic"
                        subtitle="A tap on the phone, a buzz on the wrist"
                        icon={<Ionicons name="watch-outline" size={29} color="#FF9500" />}
                        showChevron={false}
                        rightElement={(
                            <Switch
                                value={channels.toggles.announceHaptic}
                                onValueChange={(value) => { void channels.setToggle('announceHaptic', value); }}
                                accessibilityLabel="Haptic"
                            />
                        )}
                    />
                </ItemGroup>

                {/*
                    DROVE-190. The row above is the CHANNEL: whether a prompt
                    is announced by buzz at all, mirrored to every Mac and
                    read by the wrist. This one is THIS HANDSET, device-local,
                    and it ships off. With the channel on and this off the
                    watch buzzes and the phone does not, which is what Clay
                    asked for in one sentence and its follow-up.
                */}
                <ItemGroup
                    title={t('agentInput.channels.phoneHapticsTitle')}
                    footer={t('agentInput.channels.phoneHapticsFooter')}
                >
                    <Item
                        title={t('agentInput.channels.phoneHaptics')}
                        subtitle={t('agentInput.channels.phoneHapticsSubtitle')}
                        icon={<Ionicons name={phoneHaptics ? 'phone-portrait-outline' : 'notifications-off-outline'} size={29} color="#FF9500" />}
                        showChevron={false}
                        rightElement={(
                            <Switch
                                value={phoneHaptics}
                                onValueChange={setPhoneHaptics}
                                accessibilityLabel={t('agentInput.channels.phoneHaptics')}
                            />
                        )}
                    />
                </ItemGroup>

                <ItemGroup
                    title={t('agentInput.channels.audioTitle')}
                    footer="The channel is mirrored; stream-talk is not."
                >
                    {rows.map((row) => (
                        <Item
                            key={row.key}
                            title={t(row.labelKey)}
                            subtitle={t(row.subtitleKey)}
                            subtitleLines={0}
                            icon={<Ionicons name={row.icon} size={29} color="#34C759" />}
                            showChevron={false}
                            rightElement={(
                                <Switch
                                    value={row.value}
                                    onValueChange={(value) => {
                                        if (row.setting === 'readAloudEnabled') setReadAloudEnabled(value);
                                        else void channels.setToggle('announceAudio', value);
                                    }}
                                    accessibilityLabel={t(row.labelKey)}
                                />
                            )}
                        />
                    ))}
                </ItemGroup>

                <ItemGroup
                    title="Answer by audio"
                    footer="A screen can always answer."
                >
                    {answerAudioChoices.map((choice) => (
                        <Item
                            key={choice.value}
                            title={choice.title}
                            subtitle={choice.subtitle}
                            subtitleLines={0}
                            selected={channels.toggles.answerAudio === choice.value}
                            loading={channels.busy && channels.toggles.answerAudio !== choice.value}
                            showChevron={false}
                            onPress={() => { void channels.setToggle('answerAudio', choice.value); }}
                        />
                    ))}
                </ItemGroup>

                <ItemGroup footer={channels.mirroredTo ? `Changes are ${channels.mirroredTo}.` : 'No Mac is online. Saved on this phone.'}>
                    <Item
                        title="Boss mode is the other axis"
                        subtitle="combines with any mode here"
                        icon={<Ionicons name="megaphone-outline" size={29} color="#AF52DE" />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}
