import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { NativeSettingsMenu, type NativeSettingsMenuGroup } from './NativeSettingsMenu';

// Grayscale ring that fills and darkens with context usage — reads at a
// glance without color, sized to sit beside the 11pt status text.
function ContextGaugeIcon(props: { percent: number }) {
    const { theme } = useUnistyles();
    const size = 14;
    const strokeWidth = 2.5;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = Math.min(100, Math.max(0, props.percent));
    const intensity = 0.35 + 0.65 * (progress / 100);
    const color = theme.dark
        ? `rgba(255, 255, 255, ${intensity})`
        : `rgba(0, 0, 0, ${intensity})`;
    return (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <Circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                stroke={theme.colors.divider}
                strokeWidth={strokeWidth}
                fill="none"
            />
            <Circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                fill="none"
                strokeDasharray={`${circumference} ${circumference}`}
                strokeDashoffset={circumference * (1 - progress / 100)}
                rotation="-90"
                originX={size / 2}
                originY={size / 2}
            />
        </Svg>
    );
}

export type UsageRowProps = {
    contextStatus: { percent: number; detailText: string; color: string } | null;
    weekPercent: number | null;
    /**
     * Prebuilt "Session — 32% · resets 6 PM" rows for the week popup, then a
     * second group with every other drover account folded under it (DROVE-47).
     */
    usageMenuGroups: NativeSettingsMenuGroup[];
};

// Sits under the composer card, right-aligned with the effort label: week
// quota (tap for the session/week detail popup) and the context gauge (tap
// to swap the percent for exact token counts). Its own module so a test can
// mount it without the composer around it (DROVE-47).
export const AgentInputUsageRow = React.memo(function AgentInputUsageRow(p: UsageRowProps) {
    const { theme } = useUnistyles();
    const [showPreciseContext, setShowPreciseContext] = React.useState(false);
    if (!p.contextStatus && p.weekPercent == null) {
        return null;
    }
    const weekText = p.weekPercent != null ? (
        <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
            {t('agentInput.context.percentWeek', { percent: Math.round(p.weekPercent) })}
        </Text>
    ) : null;
    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 10,
            // 18 = 10pt shell inset + 8pt action inset: lines the gauge up
            // with the effort label's right edge.
            paddingHorizontal: 18,
            paddingTop: 6,
            minHeight: 18,
        }}>
            {weekText && (
                p.usageMenuGroups.length > 0 ? (
                    <NativeSettingsMenu
                        anchor="bottom"
                        groups={p.usageMenuGroups}
                    >
                        {/* Native menu triggers hit only their own bounds, so
                            pad the target out and pull the layout back in. */}
                        <View style={{ padding: 10, margin: -10 }}>
                            {weekText}
                        </View>
                    </NativeSettingsMenu>
                ) : weekText
            )}
            {p.contextStatus && (
                <Pressable
                    onPress={() => setShowPreciseContext((current) => !current)}
                    hitSlop={{ top: 12, bottom: 14, left: 10, right: 14 }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
                >
                    <Text style={{ fontSize: 11, color: p.contextStatus.color, ...Typography.default() }}>
                        {showPreciseContext
                            ? p.contextStatus.detailText
                            : t('agentInput.context.percentContext', { percent: p.contextStatus.percent })}
                    </Text>
                    <ContextGaugeIcon percent={p.contextStatus.percent} />
                </Pressable>
            )}
        </View>
    );
});
