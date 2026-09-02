/**
 * The tab strip inside a sheet (DROVE-330): a segmented control.
 *
 * Tabs that switch what a sheet SHOWS, not where the app IS. expo-router's
 * NativeTabs is the latter, a tab bar at the bottom of a navigator, and it is
 * static by rule; a sheet's tabs are a segmented control, which is what the
 * platform draws for "one of these views". On iOS that is `SheetTabs.ios.tsx`:
 * a SwiftUI `Picker` in the segmented style, which is `UISegmentedControl`
 * with iOS 26's glass, inside a Host of fixed height (nativeControls Rule 3,
 * `fixed`). Rule 1 permits it because a segment is a label and nothing else.
 *
 * This file is the sibling every platform file has (Rule 7): a real
 * implementation for Android and web, drawn by us because Compose has no
 * segmented control worth the host and web has nothing native to reach for.
 * Same height as the iOS control, from the layout module, so the sheet
 * measures the same on every platform.
 */
import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { hapticsSelection } from './haptics';
import { sheetTabsHeight, sheetTabsInset } from './worktreeSheetLayout';

export interface SheetTab<K extends string> {
    key: K;
    label: string;
}

export interface SheetTabsProps<K extends string> {
    tabs: readonly SheetTab<K>[];
    selected: K;
    onSelect: (key: K) => void;
    /** Read out with the control, so the strip says what it switches. */
    accessibilityLabel: string;
}

const stylesheet = StyleSheet.create((theme) => ({
    strip: {
        paddingHorizontal: sheetTabsInset.horizontal,
        paddingTop: sheetTabsInset.top,
        paddingBottom: sheetTabsInset.bottom,
    },
    control: {
        height: sheetTabsHeight,
        flexDirection: 'row',
        borderRadius: 9,
        padding: 2,
        backgroundColor: theme.colors.surfaceHigh,
    },
    segment: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
    },
    segmentSelected: {
        backgroundColor: theme.colors.surface,
    },
    label: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    labelSelected: {
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
}));

export function SheetTabs<K extends string>(props: SheetTabsProps<K>) {
    const styles = stylesheet;
    return (
        <View style={styles.strip}>
            <View style={styles.control} accessibilityRole="tablist" accessibilityLabel={props.accessibilityLabel}>
                {props.tabs.map((tab) => {
                    const selected = tab.key === props.selected;
                    return (
                        <Pressable
                            key={tab.key}
                            onPress={() => {
                                if (selected) return;
                                hapticsSelection();
                                props.onSelect(tab.key);
                            }}
                            accessibilityRole="tab"
                            accessibilityState={{ selected }}
                            accessibilityLabel={tab.label}
                            style={[styles.segment, selected && styles.segmentSelected]}
                        >
                            <Text style={[styles.label, selected && styles.labelSelected]} numberOfLines={1}>
                                {tab.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}
