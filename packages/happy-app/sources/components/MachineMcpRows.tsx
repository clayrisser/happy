/**
 * One harness's MCP servers, as rows under that harness's heading (DROVE-274).
 *
 * Clay: "MCPs are configured differently per harness so I guess under each
 * harness you see the MCPs ... really what I wanna see is just per harness
 * MCP." So the heading is the harness and this is what hangs under it. Its own
 * component rather than another hundred lines inside accounts.tsx, because the
 * machine detail screen is the obvious second home for it and because a screen
 * that already owns a login state machine does not need a second concern.
 *
 * READ-ONLY, and there is nothing here to press except the disclosure. He
 * deferred configuring MCPs from the phone outright; a row that looked
 * editable would be a promise this pass does not keep.
 *
 * COLLAPSED BY DEFAULT, which is the only decision in the file worth arguing.
 * Forty servers is the real number on Clay's Mac, and forty rows under each of
 * four harnesses is not a view, it is a wall. The question this screen answers
 * first is "are they there" — a count and, for Claude, whether the accounts
 * agree. The names are one tap down, where somebody looking for a specific one
 * will go.
 *
 * ONLY THE DEFAULT SCOPE'S NAMES ARE LISTED. Claude mirrors the default
 * account's servers into every account (DROVE-252), so twelve identical lists
 * would bury the one that is wrong. The accounts that DIFFER are listed after
 * the names, by name and by what they are short of, which is exactly the
 * reading that was missing the night an account lost its servers and the only
 * symptom was "what the fuck where are all my mcps".
 */

import * as React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { mcpDivergenceSummary, type McpHarnessReport, type McpScope } from '@slopus/happy-wire';
import { mcpEmptyReason, mcpReadAgo } from '@/sync/mcpText';

/** iOS systemBlue / systemOrange / systemGrey, as the rest of this screen uses them. */
const blue = '#007AFF';
const amber = '#FF9500';
const grey = '#8E8E93';

export interface MachineMcpRowsProps {
    harness: McpHarnessReport;
    /** When the machine read the files. Shown, because nothing pushes this. */
    readAt: number;
    expanded: boolean;
    onToggle: () => void;
    /** Injectable so the clock is not a reason a test flakes. */
    now?: number;
}

/**
 * What a scope that differs from the default is short of, in one sentence.
 *
 * Missing is stated first and counted, because it is the failure: the mirror
 * did not reach this account. Extra is stated after and not treated as an
 * alarm — an account with a server of its own is usually somebody's choice.
 */
function divergenceLine(scope: McpScope): string {
    if (scope.error) return `${scope.source} could not be read (${scope.error}).`;
    if (scope.missing) return `No ${scope.source} on this machine.`;
    const d = scope.divergence;
    if (!d) return '';
    const parts: string[] = [];
    if (d.missing.length) parts.push(`missing ${d.missing.join(', ')}`);
    if (d.extra.length) parts.push(`only here: ${d.extra.join(', ')}`);
    return parts.join(' · ');
}

export function MachineMcpRows(props: MachineMcpRowsProps) {
    const { harness, readAt, expanded, onToggle, now } = props;
    const { theme } = useUnistyles();

    const base = harness.scopes[0];
    // A scope worth naming: it diverges, or it could not be read at all. The
    // ones that match the default are deliberately silent.
    const odd = harness.scopes.slice(1).filter((s) => s.divergence || s.error || s.missing);
    const alarming = odd.some((s) => s.error || s.missing || (s.divergence?.missing.length ?? 0) > 0);

    if (!harness.configured) {
        return (
            <>
                <Item
                    title="None configured"
                    subtitle={mcpEmptyReason(harness) ?? undefined}
                    subtitleLines={0}
                    icon={<Ionicons name="ellipse-outline" size={29} color={grey} />}
                    showChevron={false}
                />
                <Item
                    title={mcpReadAgo(readAt, now)}
                    icon={<Ionicons name="time-outline" size={29} color={grey} />}
                    showChevron={false}
                />
            </>
        );
    }

    return (
        <>
            <Item
                title="MCP servers"
                subtitle={mcpDivergenceSummary(harness) ?? base?.source ?? undefined}
                subtitleLines={0}
                icon={<Ionicons
                    name={alarming ? 'warning-outline' : 'extension-puzzle-outline'}
                    size={29}
                    color={alarming ? amber : blue}
                />}
                onPress={onToggle}
                showChevron={false}
                rightElement={(
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={{ color: theme.colors.textSecondary, marginRight: 6 }}>
                            {String(harness.count)}
                        </Text>
                        <Ionicons
                            name={expanded ? 'chevron-up' : 'chevron-down'}
                            size={17}
                            color={theme.colors.groupped.chevron}
                        />
                    </View>
                )}
            />

            {expanded && base?.servers.map((server) => (
                <Item
                    key={server.name}
                    title={server.name}
                    subtitle={server.enabled ? undefined : 'Disabled on this machine'}
                    // The transport is the second thing you want and the only
                    // other thing that is safe to say. An entry whose shape the
                    // machine did not recognise says `unknown` rather than
                    // being guessed into a category.
                    detail={server.transport}
                    icon={<Ionicons
                        name={server.enabled ? 'ellipse' : 'ellipse-outline'}
                        size={13}
                        color={server.enabled ? blue : grey}
                        style={{ width: 29, textAlign: 'center' }}
                    />}
                    showChevron={false}
                />
            ))}

            {expanded && odd.map((scope) => (
                <Item
                    key={scope.id}
                    title={scope.label}
                    subtitle={divergenceLine(scope)}
                    subtitleLines={0}
                    detail={scope.error || scope.missing ? undefined : String(scope.count)}
                    icon={<Ionicons name="alert-circle-outline" size={29} color={amber} />}
                    showChevron={false}
                />
            ))}

            {expanded && (
                <Item
                    title={mcpReadAgo(readAt, now)}
                    subtitle={base?.source ?? undefined}
                    subtitleLines={0}
                    icon={<Ionicons name="time-outline" size={29} color={grey} />}
                    showChevron={false}
                />
            )}
        </>
    );
}
