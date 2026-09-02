import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, ContextMenu, Host, RNHostView } from '@expo/ui/swift-ui';
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
 *
 * The `measured` host of Rule 3 in `nativeControls.ts`, and the reason this
 * file was parked for a day. A bare React Native child of a `Host` is wrapped
 * in a `UIViewRepresentable` with no `sizeThatFits` and no bounds observer, so
 * `matchContents` was never measuring the body — it was measuring a SwiftUI
 * tree the body contributed nothing to, and a long markdown message rendered
 * clipped mid-sentence. `RNHostView` KVOs the child's `bounds` and applies it
 * as a SwiftUI `.frame`, which closes the loop back to `setStyleSize` and a
 * dirtied Yoga node, so an async markdown reflow propagates instead of
 * freezing a stale height.
 *
 * It also attaches the `RCTSurfaceTouchHandler` a bare child never gets. That
 * was the second, quieter failure of the parked file: every link and tool card
 * inside a message was inert, which nobody reported because a clipped message
 * is louder than a dead one.
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
        // Vertical only, on every message. A bare `matchContents` matches
        // horizontally too, which pins the host's style width from content
        // whose width comes down from that same node, and the loop collapses to
        // zero. `stretch` is what gives the host a real width to lay the body
        // out against; the bubble hugs its own content INSIDE the host.
        <Host matchContents={{ vertical: true }} style={styles.host}>
            <ContextMenu>
                <ContextMenu.Items>
                    <Button label={t('common.copy')} onPress={copy} systemImage={iosSymbol('doc.on.doc')} />
                    <Button label={t('textSelection.title')} onPress={selectText} systemImage={iosSymbol('selection.pin.in.out')} />
                </ContextMenu.Items>
                {/* No ContextMenu.Preview: without one iOS lifts the pressed
                    view itself, which is the preview Clay is asking for. */}
                <ContextMenu.Trigger>
                    {/* One child, always. `RNHostView` frames the SwiftUI view
                        to its FIRST child's bounds, so a caller passing two
                        siblings — a goal bubble and its "sent as goal" row —
                        would measure the bubble and clip the row. The caller's
                        style rides on this wrapper, which is where the fill
                        versus hug decision belongs now that the host stretches
                        unconditionally. */}
                    <RNHostView matchContents>
                        <View style={props.style}>{props.children}</View>
                    </RNHostView>
                </ContextMenu.Trigger>
            </ContextMenu>
        </Host>
    );
}

const styles = StyleSheet.create({
    host: {
        alignSelf: 'stretch',
    },
});
