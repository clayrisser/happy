/**
 * One harness's MCP servers AND its model providers, as rows under that
 * harness's heading (DROVE-274, DROVE-296).
 *
 * Clay: "MCPs are configured differently per harness so I guess under each
 * harness you see the MCPs ... really what I wanna see is just per harness
 * MCP." So the heading is the harness and this is what hangs under it. Its own
 * component rather than another hundred lines inside accounts.tsx, because the
 * machine detail screen is the obvious second home for it and because a screen
 * that already owns a login state machine does not need a second concern.
 *
 * ONE THING TO PRESS PER ROW (DROVE-291). This file used to say there was
 * nothing here to press except the disclosure, because DROVE-274 deferred
 * acting on a server outright. Clay overruled that holding the shipped list:
 * "Shouldn't I be able to click on these and reconnect authenticate etc…". So a
 * row now opens McpServerSheet — health, reconnect, re-authenticate — and only
 * when the screen passes `onPressServer`, so the component still renders as the
 * read it was for a caller that has nowhere to send you.
 *
 * CONFIGURING an MCP server is still deferred. Nothing here edits a config; the
 * sheet's two verbs act on a server, they do not rewrite the file that declares
 * it.
 *
 * COLLAPSED BY DEFAULT, which is the only decision in the file worth arguing.
 * Forty servers is the real number on Clay's Mac, and forty rows under each of
 * four harnesses is not a view, it is a wall. The question this screen answers
 * first is "are they there" — a count and, for Claude, whether the accounts
 * agree. The names are one tap down, where somebody looking for a specific one
 * will go.
 *
 * THE PROVIDERS ARE A SECOND DISCLOSURE (DROVE-296). Clay: "I typically use
 * opencode for custom 3rd party model providers" — that is what OpenCode is
 * for in this setup, so its providers belong beside its servers rather than on
 * a screen of their own. Its own toggle because the two lists have two
 * lengths, 37 servers against 141 models, and opening one to read the other is
 * the wall this file already refused once. Only OpenCode has one; the field is
 * null on the other three, and a null draws nothing rather than a "None
 * configured" row inventing a setting that does not exist.
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
import { mcpDivergenceSummary, type McpHarnessReport, type McpScope, type McpServerSummary } from '@slopus/happy-wire';
import {
    mcpEmptyReason,
    mcpReadAgo,
    providerEmptyReason,
    providerOriginLine,
    providerSummaryLine,
} from '@/sync/mcpText';

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
    /**
     * The PROVIDERS disclosure, which is a second one (DROVE-296).
     *
     * Its own state rather than sharing the servers' toggle: they are two lists
     * with two lengths — 37 servers and 141 models on Clay's Mac — and opening
     * one to read the other is the wall this screen already refused once.
     */
    providersExpanded?: boolean;
    onToggleProviders?: () => void;
    /**
     * Open the provider editor for this machine (DROVE-276).
     *
     * Optional, so the machine detail screen can render this component without
     * offering an edit it has no route for, and so a harness that takes no
     * provider list never draws the row. When it is absent the whole section
     * stays exactly what DROVE-296 shipped: a read.
     */
    onEditProviders?: () => void;
    /**
     * Tap one server (DROVE-291).
     *
     * Optional, so a screen with nowhere to send you still renders exactly the
     * read DROVE-274 shipped. When it is absent the rows draw no chevron and
     * take no press, because a row that looks tappable and is not is worse than
     * one that never offered.
     */
    onPressServer?: (server: McpServerSummary) => void;
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
    const { harness, readAt, expanded, onToggle, providersExpanded, onToggleProviders, onEditProviders, onPressServer, now } = props;
    const { theme } = useUnistyles();

    const base = harness.scopes[0];
    // A scope worth naming: it diverges, or it could not be read at all. The
    // ones that match the default are deliberately silent.
    const odd = harness.scopes.slice(1).filter((s) => s.divergence || s.error || s.missing);
    const alarming = odd.some((s) => s.error || s.missing || (s.divergence?.missing.length ?? 0) > 0);

    /*
     * THE PROVIDERS (DROVE-296), under the same harness heading and above the
     * freshness line in both branches below.
     *
     * Clay: "I typically use opencode for custom 3rd party model providers."
     * That is what OpenCode is FOR here, so it belongs beside its servers
     * rather than on a screen of its own — and it is rendered in the
     * NOT-CONFIGURED branch too, because a machine can perfectly well have
     * providers and no MCP servers, and the early return used to swallow
     * everything after it.
     *
     * `null` providers draws nothing at all. Three of the four harnesses have
     * no provider list to have, and a "None configured" row under Claude Code
     * would be inventing a setting that does not exist.
     */
    const providers = harness.providers;
    const providerAlarm = !!providers && (
        providers.missing || !!providers.error
        || providers.providers.some((p) => p.origin === 'declared')
    );
    const providerRows = !providers ? null : (
        <>
            <Item
                title="Model providers"
                subtitle={providerSummaryLine(providers)}
                subtitleLines={0}
                icon={<Ionicons
                    name={providerAlarm ? 'warning-outline' : 'layers-outline'}
                    size={29}
                    color={providerAlarm ? amber : blue}
                />}
                onPress={onToggleProviders}
                showChevron={false}
                rightElement={(
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={{ color: theme.colors.textSecondary, marginRight: 6 }}>
                            {String(providers.count)}
                        </Text>
                        <Ionicons
                            name={providersExpanded ? 'chevron-up' : 'chevron-down'}
                            size={17}
                            color={theme.colors.groupped.chevron}
                        />
                    </View>
                )}
            />
            {providersExpanded && !providers.count && (
                <Item
                    title="None configured"
                    subtitle={providerEmptyReason(providers) ?? undefined}
                    subtitleLines={0}
                    icon={<Ionicons name="ellipse-outline" size={29} color={grey} />}
                    showChevron={false}
                />
            )}
            {/*
              * The way in to editing them (DROVE-276), at the BOTTOM of the
              * open list rather than beside the heading. The heading's job is
              * still the count -- that is what this screen answers first --
              * and a chevron there would compete with the disclosure's own.
              * Absent when the screen has nowhere to send you, so this
              * component still renders as the read DROVE-296 shipped.
              */}
            {providersExpanded && onEditProviders && (
                <Item
                    title="Add a provider"
                    subtitle="The key stays on the computer"
                    subtitleLines={0}
                    icon={<Ionicons name="add-circle-outline" size={29} color={blue} />}
                    onPress={onEditProviders}
                />
            )}
            {providersExpanded && providers.providers.map((provider) => (
                <React.Fragment key={provider.id}>
                    <Item
                        title={provider.name}
                        subtitle={providerOriginLine(provider.origin) ?? undefined}
                        subtitleLines={0}
                        detail={`${provider.modelCount}`}
                        icon={<Ionicons
                            name={provider.origin === 'declared' ? 'ellipse-outline' : 'ellipse'}
                            size={13}
                            color={provider.origin === 'declared' ? amber : blue}
                            style={{ width: 29, textAlign: 'center' }}
                        />}
                        showChevron={false}
                    />
                    {/*
                      * The MODEL IDS, in the `provider/model` spelling OpenCode
                      * itself takes. Spelled out rather than shortened, because
                      * this is the list a pick has to name exactly and a
                      * prettified label is how DROVE-253 got a model id that
                      * did not exist.
                      */}
                    {provider.models.map((model) => (
                        <Item
                            key={`${provider.id}/${model.id}`}
                            title={model.name}
                            subtitle={`${provider.id}/${model.id}`}
                            subtitleLines={0}
                            icon={<View style={{ width: 29 }} />}
                            showChevron={false}
                        />
                    ))}
                </React.Fragment>
            ))}
        </>
    );

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
                {providerRows}
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

            {/*
              * THE ROW IS THE THING YOU PRESS NOW (DROVE-291). DROVE-274 said
              * in this file that "there is nothing here to press except the
              * disclosure", and Clay overruled it in one sentence: "Shouldn't I
              * be able to click on these and reconnect authenticate etc…".
              *
              * THE DOT STILL MEANS WHAT IT MEANT, and that is deliberate. It is
              * `enabled`, read from the config, which is a fact this screen
              * already has for all forty rows. It is NOT health: health costs a
              * probe per server and forty of them on a screen open would be a
              * minute of connections nobody asked for. The health is one tap
              * down, for the one server you are actually asking about.
              */}
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
                    onPress={onPressServer ? () => onPressServer(server) : undefined}
                    showChevron={!!onPressServer}
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

            {providerRows}

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
