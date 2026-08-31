import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { BubblePressable } from './BubblePressable';
import { ComposerSheet } from './ComposerSheet';
import { useComposerSheetNavigate } from './composerSheetNavigation';
import { t } from '@/text';

/**
 * What the composer's plus opens (DROVE-128).
 *
 * Clay, with the Claude iOS app's own sheet as the reference: "when you go to
 * add a file it should open a sheet that shows something like this, of course
 * not the Show recent photos or Connectors, but would have camera, photos and
 * files." So three tiles and a heading, and deliberately none of that sheet's
 * other two rows.
 *
 * On ComposerSheet, which is the fourth thing to use it after the
 * quota (DROVE-117), the channel sheet (DROVE-123) and the agent tree
 * (DROVE-111). The plus used to jump straight into the photo library, which is
 * still exactly what the Photos tile does, so nothing it reached before became
 * harder to reach: it is one more tap to the library and two new destinations
 * that had none.
 */

/** Three across, whatever the sheet's width turns out to be. */
export type AddContextSource = 'camera' | 'photos' | 'files';

const tiles: { key: AddContextSource; icon: React.ComponentProps<typeof Ionicons>['name']; label: () => string }[] = [
    { key: 'camera', icon: 'camera-outline', label: () => t('imageUpload.sourceCamera') },
    { key: 'photos', icon: 'images-outline', label: () => t('imageUpload.sourcePhotos') },
    { key: 'files', icon: 'document-outline', label: () => t('imageUpload.sourceFiles') },
];

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 14,
        paddingTop: 2,
        paddingBottom: 6,
    },
    heading: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 10,
        ...Typography.default('semiBold'),
    },
    row: {
        flexDirection: 'row',
        gap: 10,
    },
    // flex 1 each rather than a fixed width: the sheet is inset from a screen
    // whose width we do not get to assume, and three equal tiles divide
    // whatever is left without any arithmetic to keep in sync.
    tile: {
        flex: 1,
        minWidth: 0,
        height: 88,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: theme.colors.surfaceHigh,
    },
    tileLabel: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
}));

/**
 * The tiles, INSIDE the sheet, which is what lets them use its exit.
 *
 * Closing first was right, but calling onSelect in the same tick was not: the
 * sheet is a react-native Modal that stays mounted for the length of its slide
 * down, and the camera, photo library and document browser are all system
 * modals that cannot present while it is up. Clay got a tap that did nothing.
 * DROVE-158 banked the tile in a ref here and fired it from `onClosed`;
 * DROVE-183 made that the shell's rule, so this hands the action over and the
 * banking, the reopen case and the timing are the sheet's problem again.
 */
function AddContextTiles(props: {
    shown: typeof tiles;
    onSelect: (source: AddContextSource) => void;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const leave = useComposerSheetNavigate();
    const { onSelect } = props;
    return (
        <View style={styles.body}>
            <Text style={styles.heading}>{t('imageUpload.addContextTitle')}</Text>
            <View style={styles.row}>
                {props.shown.map((tile) => (
                    <BubblePressable
                        key={tile.key}
                        onPress={() => leave(() => onSelect(tile.key))}
                        style={(p) => [styles.tile, { opacity: p.pressed ? 0.7 : 1 }]}
                        accessibilityRole="button"
                        accessibilityLabel={tile.label()}
                    >
                        <Ionicons name={tile.icon} size={24} color={theme.colors.text} />
                        <Text style={styles.tileLabel} numberOfLines={1}>{tile.label()}</Text>
                    </BubblePressable>
                ))}
            </View>
        </View>
    );
}

export function AddContextSheet(props: {
    open: boolean;
    onClose: () => void;
    onSelect: (source: AddContextSource) => void;
    /** A tile with nothing behind it is not drawn; see AgentInput. */
    available?: Record<AddContextSource, boolean>;
}) {
    const { onClose, onSelect } = props;
    const shown = tiles.filter((tile) => props.available?.[tile.key] !== false);
    return (
        <ComposerSheet
            open={props.open && shown.length > 0}
            onClose={onClose}
        >
            <AddContextTiles shown={shown} onSelect={onSelect} />
        </ComposerSheet>
    );
}
