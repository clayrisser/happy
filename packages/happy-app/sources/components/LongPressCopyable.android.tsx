import * as React from 'react';
import {
    Modal as RNModal,
    Pressable,
    Text,
    View,
    useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { storeTempText } from '@/sync/persistence';
import { t } from '@/text';
import { hapticsLight } from './haptics';
import { AnimatedPopup } from './AnimatedOverlay';
import type { LongPressCopyableProps } from './LongPressCopyable';

type AnchorRect = {
    height: number;
    width: number;
    x: number;
    y: number;
};

// Wide enough for the longest translation of the second item on one line:
// 'Seleccionar texto' at 15pt, plus the icon, the gap and the padding.
const MENU_WIDTH = 200;
const MENU_ROW_HEIGHT = 44;
const MENU_ROWS = 2;
const MENU_HEIGHT = MENU_ROW_HEIGHT * MENU_ROWS;
const MENU_GAP = 8;
const SCREEN_MARGIN = 12;

/**
 * The anchored menu iOS no longer uses. Android has no context-menu primitive
 * in @expo/ui (jetpack-compose ships DropdownMenu, which opens on a tap and
 * would eat the message tap), so this is what the hold degrades to here rather
 * than degrading to no copy at all.
 *
 * TWO items, in this order (DROVE-282). Copy stays first and coarse: it is the
 * one Clay reaches for most and losing it to make room for a finer action
 * would be a bad trade. Select Text is the finer one, and it is the only route
 * to a word: this menu is what the hold raises on BOTH platforms, so until it
 * carried a second item the reader at `/text-selection` had no way in at all.
 * The parked SwiftUI menu beside this file has had the same two items all
 * along; only the anchored fallback everyone actually gets was missing one.
 */
export function LongPressCopyable(props: LongPressCopyableProps) {
    const containerRef = React.useRef<View>(null);
    const [anchor, setAnchor] = React.useState<AnchorRect | null>(null);
    const router = useRouter();

    const openMenu = React.useCallback(() => {
        const node = containerRef.current;
        if (!node) {
            return;
        }
        node.measureInWindow((x, y, width, height) => {
            setAnchor({ x, y, width, height });
            hapticsLight();
        });
    }, []);

    const closeMenu = React.useCallback(() => setAnchor(null), []);

    // LongPress through GestureDetector (rather than Pressable) so the chat list
    // still pans while a finger is down, matching MarkdownView's copy gesture.
    const gesture = React.useMemo(() => Gesture.LongPress()
        .minDuration(400)
        .onStart(openMenu)
        .runOnJS(true), [openMenu]);

    return (
        <>
            <GestureDetector gesture={gesture}>
                <View collapsable={false} ref={containerRef} style={props.style}>
                    {props.children}
                </View>
            </GestureDetector>
            {/* Mounted only while open. Rendering it unconditionally would
                subscribe every message in the list to window-size and theme
                changes through CopyMenu's hooks. */}
            {anchor ? <CopyMenu anchor={anchor} onClose={closeMenu} router={router} text={props.text} /> : null}
        </>
    );
}

function CopyMenu({ anchor, onClose, router, text }: {
    anchor: AnchorRect;
    onClose: () => void;
    router: { push: (href: string) => void };
    text: string;
}) {
    const { theme } = useUnistyles();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();

    const handleCopy = React.useCallback(async () => {
        onClose();
        try {
            await Clipboard.setStringAsync(text);
        } catch (error) {
            console.error('Failed to copy message:', error);
        }
    }, [onClose, text]);

    // The reader is where a WORD can be selected. It is a separate screen
    // rather than selection in place because `<Text selectable>` on iOS is not
    // a selection at all — see `textSelectionSurface.ts` for what RN actually
    // does there. Closed first, because pushing a route out from under an open
    // RN Modal leaves the modal on top of the screen it pushed.
    const handleSelectText = React.useCallback(() => {
        onClose();
        try {
            router.push(`/text-selection?textId=${storeTempText(text)}`);
        } catch (error) {
            console.error('Error storing text for selection:', error);
        }
    }, [onClose, router, text]);

    // Prefer sitting above the message; drop below when the message is close to
    // the top of the screen.
    const above = anchor.y - MENU_HEIGHT - MENU_GAP;
    const top = above >= SCREEN_MARGIN
        ? above
        : Math.min(anchor.y + anchor.height + MENU_GAP, windowHeight - MENU_HEIGHT - SCREEN_MARGIN);
    // User messages hug the right edge, so align the menu's right edge to theirs.
    const left = Math.max(
        SCREEN_MARGIN,
        Math.min(windowWidth - MENU_WIDTH - SCREEN_MARGIN, anchor.x + anchor.width - MENU_WIDTH),
    );

    return (
        <RNModal
            animationType="none"
            onRequestClose={onClose}
            transparent
            visible
        >
            <View style={styles.container}>
                <Pressable onPress={onClose} style={styles.backdrop} />
                <AnimatedPopup style={[styles.menu, { left, top }]}>
                    <Pressable
                        accessibilityLabel={t('common.copy')}
                        accessibilityRole="button"
                        onPress={handleCopy}
                        style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    >
                        <Ionicons color={theme.colors.text} name="copy-outline" size={17} />
                        <Text numberOfLines={1} style={styles.menuItemLabel}>{t('common.copy')}</Text>
                    </Pressable>
                    <Pressable
                        accessibilityLabel={t('textSelection.title')}
                        accessibilityRole="button"
                        onPress={handleSelectText}
                        style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    >
                        <Ionicons color={theme.colors.text} name="text-outline" size={17} />
                        <Text numberOfLines={1} style={styles.menuItemLabel}>{t('textSelection.title')}</Text>
                    </Pressable>
                </AnimatedPopup>
            </View>
        </RNModal>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
    },
    menu: {
        position: 'absolute',
        width: MENU_WIDTH,
        borderRadius: 14,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 16,
        shadowOffset: {
            width: 0,
            height: 6,
        },
        elevation: 8,
    },
    menuItem: {
        height: MENU_ROW_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        gap: 10,
    },
    menuItemPressed: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    menuItemLabel: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 20,
    },
}));
