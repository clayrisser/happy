/**
 * The sheet's tab strip on iOS (DROVE-330): SwiftUI's segmented Picker.
 *
 * `Picker` with `pickerStyle('segmented')` is `UISegmentedControl`, and on
 * iOS 26 it draws itself in the system's glass, so the sheet's tabs look like
 * every other segmented control on the phone rather than like a row of
 * buttons we drew. The Host is the `fixed` mode of nativeControls Rule 3: an
 * explicit height from the layout module, a real width from RN style, and
 * SwiftUI-only children, so nothing is measured and nothing can clip.
 *
 * Remounted on a theme flip, like the two menus, because a SwiftUI host keeps
 * the old tint otherwise.
 */
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Host, Picker, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import type { SheetTabsProps } from './SheetTabs';
import { hapticsSelection } from './haptics';
import { sheetTabsHeight, sheetTabsInset } from './worktreeSheetLayout';

export function SheetTabs<K extends string>(props: SheetTabsProps<K>) {
    const { theme } = useUnistyles();
    const { onSelect, selected } = props;
    const handleChange = React.useCallback((key: K) => {
        if (key === selected) return;
        hapticsSelection();
        onSelect(key);
    }, [onSelect, selected]);
    return (
        <View
            style={{
                paddingHorizontal: sheetTabsInset.horizontal,
                paddingTop: sheetTabsInset.top,
                paddingBottom: sheetTabsInset.bottom,
            }}
        >
            <Host
                key={theme.dark ? 'dark' : 'light'}
                colorScheme={theme.dark ? 'dark' : 'light'}
                style={{ height: sheetTabsHeight, width: '100%' }}
            >
                <Picker<K>
                    selection={selected}
                    onSelectionChange={handleChange}
                    modifiers={[pickerStyle('segmented'), accessibilityLabel(props.accessibilityLabel)]}
                >
                    {props.tabs.map((tab) => (
                        <Text key={tab.key} modifiers={[tag(tab.key)]}>{tab.label}</Text>
                    ))}
                </Picker>
            </Host>
        </View>
    );
}
