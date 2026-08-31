/**
 * The channel sheet (DROVE-72): the mode picker above the three switches.
 *
 * Opened by a long-press on the composer's primary button (DROVE-83 put the
 * audio switch there because this sheet did not exist yet) and rendered in
 * full on Settings > Channels. Same model both places: the phone's switches
 * out of the synced settings, the bus's read on open and adopted when they
 * differ, and every write mirrored to each connected Mac.
 *
 * IT SLIDES UP (DROVE-123). It used to be one branch of the composer's shared
 * floating panel, which is the third popup Clay has asked to be a sheet, so
 * it is a rule and not three requests: anything that opens from the composer
 * strip is a bottom sheet. The mechanism is DROVE-117's, and since DROVE-128
 * it is literally DROVE-117's: this file carried a character-for-character
 * copy of the backdrop, the grabber and the drag until ComposerSheet
 * was extracted, and four copies of a gesture is three too many. Dismissed by
 * dragging the grabber down on the gate overlay's thresholds, or by tapping
 * outside, identically to the quota sheet, because it IS the quota sheet's
 * shell.
 *
 * The AUDIO section is two rows, not one (DROVE-100). Speaking a prompt when
 * it arrives and reading replies aloud are separate settings that both read
 * "Audio" until now, which is why turning one on looked broken. droverChannels
 * audioRows() names them and pins the order; each row writes its own key.
 *
 * Modes are ROWS, not code paths. Picking one sets the four switches; moving
 * any switch by hand is a combination with no name, and the picker shows
 * none selected rather than a label that lies.
 */

import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

import { Typography } from '@/constants/Typography';
import { BubblePressable } from './BubblePressable';
import { ComposerSheet } from './ComposerSheet';
import { ComposerSheetRow } from './ComposerSheetRow';
import { hapticsLight } from './haptics';
import { useDroverChannels } from '@/hooks/useDroverChannels';
import { audioRows, MODE_COPY, modeTitle } from '@/sync/droverChannels';
import { useLocalSettingMutable } from '@/sync/storage';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    // The composer's own section metrics, copied here rather than passed in,
    // so the sheet no longer needs styles handed down from AgentInput.
    section: {
        paddingVertical: 8,
    },
    sectionTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },
}));

export interface DroverChannelsSheetProps {
    open: boolean;
    onClose: () => void;
    /** Side inset, matching the composer's other sheets. */
}

export const DroverChannelsSheet = React.memo(function DroverChannelsSheet(props: DroverChannelsSheetProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const channels = useDroverChannels();
    // Stream-talk lives on this device, not on the bus, so it is read here
    // rather than through the channels hook (DROVE-100). The composer's
    // speaker button and Settings > Voice write the same local key.
    const [readAloudEnabled, setReadAloudEnabled] = useLocalSettingMutable('readAloudEnabled');
    const rows = audioRows({ announceAudio: channels.toggles.announceAudio, readAloudEnabled });

    return (
        <ComposerSheet
            open={props.open}
            onClose={props.onClose}
            // The switches are one tap, and a keyboard on its way out would
            // otherwise eat it.
            keyboardShouldPersistTaps="always"
        >
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>MODE</Text>
                {channels.modes.map(({ name }) => {
                    const isSelected = channels.mode === name;
                    const copy = MODE_COPY[name];
                    return (
                        <BubblePressable
                            key={name}
                            onPress={() => {
                                hapticsLight();
                                void channels.pickMode(name);
                            }}
                            style={({ pressed }) => ({
                                flexDirection: 'row',
                                alignItems: 'flex-start',
                                paddingHorizontal: 16,
                                paddingVertical: 8,
                                marginHorizontal: 8,
                                borderRadius: 14,
                                backgroundColor: pressed
                                    ? theme.colors.surfacePressedOverlay
                                    : isSelected
                                        ? theme.colors.glass.backgroundSubtle
                                        : 'transparent',
                            })}
                            accessibilityRole="radio"
                            accessibilityState={{ selected: isSelected }}
                            accessibilityLabel={modeTitle(name)}
                        >
                            <View style={{
                                width: 16,
                                height: 16,
                                borderRadius: 8,
                                borderWidth: 2,
                                borderColor: isSelected ? theme.colors.radio.active : theme.colors.radio.inactive,
                                alignItems: 'center',
                                justifyContent: 'center',
                                marginRight: 12,
                                marginTop: 2,
                            }}>
                                {isSelected && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.radio.dot }} />}
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={{
                                    fontSize: 14,
                                    color: isSelected ? theme.colors.radio.active : theme.colors.text,
                                    ...Typography.default(),
                                }}>
                                    {modeTitle(name)}
                                </Text>
                                {!!copy?.subtitle && (
                                    <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                                        {copy.subtitle}
                                    </Text>
                                )}
                            </View>
                        </BubblePressable>
                    );
                })}
            </View>
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('agentInput.channels.title')}</Text>
                <ComposerSheetRow
                    kind="toggle"
                    icon={channels.toggles.announceVisual ? 'phone-portrait-outline' : 'eye-off-outline'}
                    title="Visual"
                    value={channels.toggles.announceVisual}
                    onValueChange={(value) => {
                        hapticsLight();
                        void channels.setToggle('announceVisual', value);
                    }}
                />
                <ComposerSheetRow
                    kind="toggle"
                    icon={channels.toggles.announceHaptic ? 'watch-outline' : 'remove-circle-outline'}
                    title="Haptic"
                    value={channels.toggles.announceHaptic}
                    onValueChange={(value) => {
                        hapticsLight();
                        void channels.setToggle('announceHaptic', value);
                    }}
                />
            </View>
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('agentInput.channels.audioTitle')}</Text>
                {rows.map((row) => (
                    <ComposerSheetRow
                        key={row.key}
                        kind="toggle"
                        icon={row.icon}
                        title={t(row.labelKey)}
                        value={row.value}
                        onValueChange={(value) => {
                            hapticsLight();
                            if (row.setting === 'readAloudEnabled') setReadAloudEnabled(value);
                            else void channels.setToggle('announceAudio', value);
                        }}
                    />
                ))}
                {(channels.error || channels.mirroredTo) && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingTop: 6 }}>
                        <Ionicons
                            name={channels.error ? 'warning-outline' : 'desktop-outline'}
                            size={12}
                            color={channels.error ? '#FF9500' : theme.colors.textSecondary}
                        />
                        <Text style={{ fontSize: 11, color: channels.error ? '#FF9500' : theme.colors.textSecondary, ...Typography.default() }} numberOfLines={2}>
                            {channels.error ?? channels.mirroredTo}
                        </Text>
                    </View>
                )}
            </View>
        </ComposerSheet>
    );
});
