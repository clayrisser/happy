/**
 * One plugin, as a row that can be PRESSED (DROVE-310).
 *
 * Clay: "managing the extensions (let's actually call them plugins) should
 * actually support being managed from the mobile app ... enable disable
 * install globally install for a specific harness etc.. all from the mobile
 * app." So unlike MachineMcpRows, which is deliberately read-only, every verb
 * the terminal has is a row here.
 *
 * COLLAPSED BY DEFAULT, for MachineMcpRows' reason and more strongly: a plugin
 * has a manifest behind it — what it provides, what it requires, what it
 * touches, where it came from, which config keys are set — and that is a
 * screenful per plugin. The collapsed row answers the two questions a list is
 * for, "is it on" and "what does it add", and everything else is one tap down.
 *
 * THE ACTIONS ARE INSIDE THE DISCLOSURE, never on the collapsed row. An
 * uninstall one thumb-width from a scroll is how somebody loses a plugin they
 * were only looking at, and a plugin's actions are meaningless without the
 * facts above them — you scope a plugin to codex knowing what it provides.
 *
 * SCOPE IS A LIST OF ROWS, not a toggle. A plugin is global or scoped to a
 * named set of harnesses, and the drover takes the set; a switch could only
 * ever say global-or-not, which is the shape that would have to be replaced
 * the first time somebody wanted it on two harnesses and not the third. The
 * currently-scoped harnesses are ticked, so pressing one is a re-scope with
 * the whole set visible rather than a guess.
 *
 * NOTHING HERE ASKS FOR A CREDENTIAL. A plugin NAMES what it needs and the
 * value is set on the computer; pluginCredentialsLine says that out loud. A
 * field here would be a token typed on a phone, which is a token that has
 * already been somewhere it should not be.
 */

import * as React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { pluginStateLine, type PluginOpParams, type PluginSummary } from '@slopus/happy-wire';
import {
    pluginCredentialsLine,
    pluginOriginLine,
    pluginProvidesLine,
    pluginScopeLine,
    pluginTouchesLine,
    pluginVarsLine,
    pluginWhenLine,
} from '@/sync/pluginText';

/** iOS systemBlue / systemGreen / systemOrange / systemRed / systemGrey. */
const blue = '#007AFF';
const green = '#34C759';
const amber = '#FF9500';
const red = '#FF3B30';
const grey = '#8E8E93';

export interface MachinePluginRowsProps {
    plugin: PluginSummary;
    /** The harnesses this machine knows, which is the set a plugin may be scoped to. */
    harnesses: string[];
    expanded: boolean;
    onToggle: () => void;
    /** An op is in flight for this plugin: every action row is inert until it lands. */
    busy?: boolean;
    onOp: (params: PluginOpParams) => void;
}

const dotFor = (state: PluginSummary['state']) =>
    state === 'enabled' ? green : state === 'disabled' ? amber : grey;

/** A fact row inside the disclosure: indented under the plugin, never pressable. */
function Fact(props: { title: string; subtitle?: string | null; detail?: string; tone?: string }) {
    return (
        <Item
            title={props.title}
            subtitle={props.subtitle ?? undefined}
            subtitleLines={0}
            detail={props.detail}
            icon={<View style={{ width: 29 }} />}
            titleStyle={props.tone ? { color: props.tone } : undefined}
            showChevron={false}
        />
    );
}

export function MachinePluginRows(props: MachinePluginRowsProps) {
    const { plugin, harnesses, expanded, onToggle, busy, onOp } = props;
    const { theme } = useUnistyles();

    const installed = plugin.state !== 'not-installed';
    const scoped = plugin.scope.kind === 'harness' ? plugin.scope.harnesses : null;
    const problem = !!plugin.error || plugin.warnings.length > 0;

    /*
     * The NAMES behind each count, listed only when there are some. A section
     * heading with nothing under it is the noise the collapsed row already
     * refused; a plugin that provides no rules should not draw a "Rules" row
     * to say zero.
     */
    const provided: [string, string[]][] = [
        ['MCP servers', plugin.provides.mcp.map((m) => m.name)],
        ['Skills', plugin.provides.skills],
        ['Commands', plugin.provides.commands],
        ['Subagents', plugin.provides.subagents],
        ['Rules', plugin.provides.rules],
        ['Hooks', plugin.provides.hooks.map((h) => [h.event, h.matcher].filter(Boolean).join(' '))],
        ['On PATH', plugin.provides.bin],
    ];
    const required: [string, string[]][] = [
        ['Needs commands', plugin.requires.commands],
        ['Needs platform', plugin.requires.platform],
        ['Needs plugins', plugin.requires.plugins],
    ];

    /*
     * An action row. Disabled while an op is in flight rather than hidden: a
     * row that vanishes mid-press is how somebody hits the row that took its
     * place, and this list has an uninstall in it.
     */
    const action = (
        key: string,
        title: string,
        icon: keyof typeof Ionicons.glyphMap,
        color: string,
        params: PluginOpParams,
        subtitle?: string,
    ) => (
        <Item
            key={key}
            title={title}
            subtitle={subtitle}
            subtitleLines={0}
            icon={<Ionicons name={icon} size={29} color={busy ? grey : color} />}
            onPress={busy ? undefined : () => onOp(params)}
            disabled={busy}
            destructive={color === red}
            showChevron={false}
        />
    );

    return (
        <>
            <Item
                title={plugin.id?.name ?? plugin.name}
                // The state first, because it is the question the list answers,
                // then what the plugin adds. The FULL namespaced name is the
                // identity every route and every drover.yaml entry is keyed by,
                // so it is said here rather than only in the disclosure.
                subtitle={`${pluginStateLine(plugin)} · ${pluginProvidesLine(plugin)}\n${plugin.name}`}
                subtitleLines={0}
                detail={plugin.version ?? undefined}
                icon={<Ionicons
                    name={problem ? 'warning-outline' : 'cube-outline'}
                    size={29}
                    color={problem ? amber : dotFor(plugin.state)}
                />}
                onPress={onToggle}
                showChevron={false}
                rightElement={(
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        {busy && (
                            <Text style={{ color: theme.colors.textSecondary, marginRight: 6 }}>…</Text>
                        )}
                        <Ionicons
                            name={expanded ? 'chevron-up' : 'chevron-down'}
                            size={17}
                            color={theme.colors.groupped.chevron}
                        />
                    </View>
                )}
            />

            {expanded && (
                <>
                    {/* Why this plugin is not usable, first, above everything it
                        claims — a plugin drover.yaml names and the catalog
                        lacks would otherwise read as installed and fine. */}
                    {plugin.error && <Fact title="This one is broken" subtitle={plugin.error} tone={amber} />}
                    {plugin.warnings.map((w, i) => (
                        <Fact key={`warn-${i}`} title="Warning" subtitle={w} tone={amber} />
                    ))}

                    {plugin.summary && <Fact title={plugin.summary} />}

                    {provided.map(([label, names]) => names.length
                        ? <Fact key={label} title={label} subtitle={names.join(', ')} detail={String(names.length)} />
                        : null)}
                    {required.map(([label, names]) => names.length
                        ? <Fact key={label} title={label} subtitle={names.join(', ')} />
                        : null)}

                    <Fact title={pluginTouchesLine(plugin)} />
                    {pluginCredentialsLine(plugin) && <Fact title={pluginCredentialsLine(plugin)!} />}
                    {pluginVarsLine(plugin) && <Fact title={pluginVarsLine(plugin)!} />}
                    {pluginWhenLine(plugin) && <Fact title={pluginWhenLine(plugin)!} />}
                    {plugin.vendor.length > 0 && (
                        <Fact
                            title="Vendors"
                            subtitle={plugin.vendor.map((v) => `${v.name} (${v.kind}${v.locator ? ` ${v.locator}` : ''})`).join(', ')}
                        />
                    )}
                    {pluginOriginLine(plugin) && <Fact title={pluginOriginLine(plugin)!} subtitle={plugin.dir ?? undefined} />}
                    {/* Installing runs the plugin's own build. Said before the
                        install row, not after it. */}
                    {plugin.builds && !installed && <Fact title="Installing this runs its own build" />}

                    {/* ---- what may be done to it ---- */}
                    {plugin.state === 'enabled' && action(
                        'disable', 'Disable', 'pause-circle-outline', amber,
                        { op: 'disable', name: plugin.name },
                        'Keeps the files. The mirror stops carrying it.',
                    )}
                    {plugin.state === 'disabled' && action(
                        'enable', 'Enable', 'play-circle-outline', green,
                        { op: 'enable', name: plugin.name },
                    )}
                    {!installed && action(
                        'install', 'Install', 'download-outline', blue,
                        { op: 'install', source: { kind: 'catalog', name: plugin.name } },
                        'From the catalog on this computer.',
                    )}

                    {/* Scope. Shown for an installed plugin only: scoping one
                        that is not there yet would be a setting with nothing
                        to apply to, and the install row above installs global
                        which is what somebody pressing once means. */}
                    {installed && (
                        <>
                            <Item
                                title="Every harness"
                                subtitle={plugin.scope.kind === 'global' ? pluginScopeLine(plugin.scope) : undefined}
                                icon={<Ionicons
                                    name={plugin.scope.kind === 'global' ? 'radio-button-on' : 'radio-button-off'}
                                    size={29}
                                    color={busy ? grey : blue}
                                />}
                                onPress={busy ? undefined : () => onOp({ op: 'enable', name: plugin.name, scope: { kind: 'global' } })}
                                disabled={busy}
                                showChevron={false}
                            />
                            {harnesses.map((h) => (
                                <Item
                                    key={`scope-${h}`}
                                    title={h}
                                    icon={<Ionicons
                                        name={scoped?.includes(h) ? 'radio-button-on' : 'radio-button-off'}
                                        size={29}
                                        color={busy ? grey : blue}
                                    />}
                                    onPress={busy ? undefined : () => onOp({
                                        op: 'enable',
                                        name: plugin.name,
                                        // Pressing a harness SETS the scope to
                                        // it rather than adding to a set, so one
                                        // press has one meaning. Adding a second
                                        // harness is two presses and both are
                                        // visible above.
                                        scope: { kind: 'harness', harnesses: [h] },
                                    })}
                                    disabled={busy}
                                    showChevron={false}
                                />
                            ))}
                        </>
                    )}

                    {installed && action(
                        'uninstall', 'Uninstall', 'trash-outline', red,
                        { op: 'uninstall', name: plugin.name },
                        'Removes the drover.yaml entry and the mirror.',
                    )}
                </>
            )}
        </>
    );
}
