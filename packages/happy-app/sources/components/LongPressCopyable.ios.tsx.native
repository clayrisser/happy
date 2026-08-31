import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, ContextMenu, Host } from '@expo/ui/swift-ui';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { storeTempText } from '@/sync/persistence';
import { t } from '@/text';
import type { LongPressCopyableProps } from './LongPressCopyable';

const iosSymbol = (name: string) =>
    name as unknown as React.ComponentProps<typeof Button>['systemImage'];

/**
 * The real UIKit context menu, not a menu we draw. UIContextMenuInteraction
 * anchors it at the finger, lifts and blurs the pressed view, plays the system
 * haptic and dismisses the way every other iOS menu does. None of that is ours
 * to position, so there is no anchor measurement here at all.
 */
export function LongPressCopyable(props: LongPressCopyableProps) {
    const router = useRouter();
    const { text } = props;

    const copy = React.useCallback(() => {
        Clipboard.setStringAsync(text).catch((error) => {
            console.error('Failed to copy message:', error);
        });
    }, [text]);

    // The reader the markdown long press used to open. It has nowhere else to
    // be reached from a message now that the hold raises this menu.
    const selectText = React.useCallback(() => {
        try {
            router.push(`/text-selection?textId=${storeTempText(text)}`);
        } catch (error) {
            console.error('Error storing text for selection:', error);
        }
    }, [router, text]);

    return (
        <View style={props.style}>
            {/* A hosted SwiftUI view sizes itself to its content, which cannot
                resolve the agent turn's percentage width. Stretch it instead
                and measure only the height back. */}
            <Host
                matchContents={props.fill ? { vertical: true } : true}
                style={props.fill ? styles.fill : undefined}
            >
                <ContextMenu>
                    <ContextMenu.Items>
                        <Button label={t('common.copy')} onPress={copy} systemImage={iosSymbol('doc.on.doc')} />
                        <Button label={t('textSelection.title')} onPress={selectText} systemImage={iosSymbol('selection.pin.in.out')} />
                    </ContextMenu.Items>
                    {/* No ContextMenu.Preview: without one iOS lifts the pressed
                        view itself, which is the preview Clay is asking for. */}
                    <ContextMenu.Trigger>{props.children}</ContextMenu.Trigger>
                </ContextMenu>
            </Host>
        </View>
    );
}

const styles = StyleSheet.create({
    fill: {
        alignSelf: 'stretch',
    },
});
