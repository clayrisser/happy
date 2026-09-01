/**
 * Settings > Plugins (DROVE-310): the plugins each machine manages, and the
 * verbs that manage them, from the phone.
 *
 * Clay: "managing the extensions (let's actually call them plugins) should
 * actually support being managed from the mobile app ... enable disable
 * install globally install for a specific harness etc.. all from the mobile
 * app." Everything `drover plugins` can do to a plugin is on this page.
 *
 * A PLUGIN IS SHOTGUN CONTENT and only that (DROVE-325): an MCP server with
 * the skills and hooks around it — huly, pdf, matrix. A harness
 * (claude/cursor/codex/opencode/pi) and an OS installer (tmux, node, gum)
 * share the plugin.yaml filename and are NOT plugins; the drover's catalog
 * walk tells them apart by kind and skips them, so nothing on this page can
 * install a harness. The harness names that DO appear here are the set a
 * plugin may be SCOPED to.
 *
 * ITS OWN PAGE, not a section under each harness on the accounts screen.
 * That screen is one group per harness because an account and an MCP config
 * both belong to exactly one; a plugin does not — it is global by default and
 * scoped to a harness only when somebody narrows it. Hanging a global plugin
 * under all five headings would draw it five times and imply five settings.
 *
 * TWO LISTS PER MACHINE. `Installed` is what drover.yaml and the store hold —
 * the short list, the one the page opens with. `Catalog` is what the machine
 * offers that is not installed yet, loaded on demand, because browsing is a
 * second question and loading both to draw one spends the machine on a
 * question nobody asked.
 *
 * EVERY WRITE RE-READS. A write is the one thing that makes the answer stale,
 * so the report is fetched again after each op rather than patched locally
 * from the outcome — the machine is the one that knows what the render did,
 * and a locally-patched row is how the phone and the terminal start
 * disagreeing.
 *
 * THE STALE COUNT IS ALWAYS SAID (DROVE-220). A disable rewrites drover.yaml
 * on disk, but a running session keeps the plugin set it started with until it
 * restarts. The machine counts those sessions and the confirmation says the
 * number, because "disabled" on its own is a claim this page cannot make.
 *
 * NO CREDENTIAL IS TYPED HERE. A plugin NAMES the credentials it needs and the
 * values are set on the computer. A field on this page would be a token typed
 * on a phone, which is a token that has already been somewhere it should not
 * be, and an install source whose url carries one is refused BY THE MACHINE
 * rather than sanitized, so a mistyped url fails loudly.
 */

import * as React from 'react';
import { Platform, RefreshControl } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { MachinePluginRows } from '@/components/MachinePluginRows';
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Modal } from '@/modal';
import {
    machineDroverPluginCatalog,
    machineDroverPluginOp,
    machineDroverPlugins,
    type MachinePluginsResult,
    type PluginOpParams,
    type PluginReport,
} from '@/sync/machinePlugins';
import {
    pluginCountsLine,
    pluginEmptyReason,
    pluginLinksLine,
    pluginOpDone,
    pluginOpTitle,
    pluginSourceFor,
} from '@/sync/pluginText';
import { useAllMachines } from '@/sync/storage';

const amber = '#FF9500';
const blue = '#007AFF';
const grey = '#8E8E93';

function machineName(machine: { id: string; metadata?: { displayName?: string; host?: string } | null }): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id;
}

type Loaded = { loading: boolean; result: MachinePluginsResult | null };

export default function PluginsScreen() {
    const machines = useAllMachines({ includeOffline: true });
    const [managed, setManaged] = React.useState<Record<string, Loaded>>({});
    const [catalog, setCatalog] = React.useState<Record<string, Loaded>>({});
    const [openCatalog, setOpenCatalog] = React.useState<Record<string, boolean>>({});
    const [open, setOpen] = React.useState<Record<string, boolean>>({});
    const [busy, setBusy] = React.useState<string | null>(null);
    const [refreshing, setRefreshing] = React.useState(false);

    const load = React.useCallback(async (machineId: string) => {
        setManaged((prev) => ({ ...prev, [machineId]: { loading: true, result: prev[machineId]?.result ?? null } }));
        const result = await machineDroverPlugins(machineId);
        setManaged((prev) => ({ ...prev, [machineId]: { loading: false, result } }));
        return result;
    }, []);

    const loadCatalog = React.useCallback(async (machineId: string) => {
        setCatalog((prev) => ({ ...prev, [machineId]: { loading: true, result: prev[machineId]?.result ?? null } }));
        const result = await machineDroverPluginCatalog(machineId);
        setCatalog((prev) => ({ ...prev, [machineId]: { loading: false, result } }));
        return result;
    }, []);

    const machineIds = machines.map((m) => m.id).join(',');
    React.useEffect(() => {
        for (const id of machineIds ? machineIds.split(',') : []) void load(id);
    }, [machineIds, load]);

    const refresh = React.useCallback(async () => {
        setRefreshing(true);
        await Promise.all(machines.map((m) => load(m.id)));
        setRefreshing(false);
    }, [machines, load]);

    /**
     * Run one op, then re-read.
     *
     * An uninstall is confirmed and nothing else is: enable, disable and
     * install are each undone by one press of the row beside them, and a
     * confirmation on a reversible action is the dialog people learn to
     * dismiss without reading — which is how the one that matters gets
     * dismissed too.
     */
    const runOp = React.useCallback(async (machineId: string, params: PluginOpParams) => {
        const name = params.name ?? (params.source?.kind === 'catalog' ? params.source.name : 'that plugin');
        if (params.op === 'uninstall') {
            const ok = await Modal.confirm(
                pluginOpTitle('uninstall', name),
                'The drover.yaml entry goes, and the mirror stops carrying it. Anything the plugin '
                + 'fetched into the store stays on disk, and running sessions keep it until they restart.',
                { confirmText: 'Uninstall', cancelText: 'Cancel', destructive: true },
            );
            if (!ok) return;
        }
        setBusy(`${machineId}:${name}`);
        const result = await machineDroverPluginOp(machineId, params);
        setBusy(null);
        if (!result.ok) {
            Modal.alert('That machine refused', result.error);
        } else if (result.outcome.ok === false) {
            Modal.alert('That machine refused', result.outcome.error ?? `the ${params.op} failed`);
        } else {
            // The stale count and the PATH links are the two facts the machine
            // knows and the phone cannot work out. Both are said here rather
            // than folded into a row, because they are about what did NOT
            // happen yet and a row only ever shows the new state.
            const links = pluginLinksLine(result.outcome.links);
            Modal.alert(
                'Done',
                `${pluginOpDone(params.op, name, result.outcome.staleSessions)}${links ? `\n${links}` : ''}`,
            );
        }
        await load(machineId);
        if (openCatalog[machineId]) await loadCatalog(machineId);
    }, [load, loadCatalog, openCatalog]);

    /**
     * Install from something that is not in the catalog: a path on that
     * machine, a git remote at a ref, or a sha256-pinned bundle.
     *
     * ONE FIELD, and the kind is read off what was typed. Making somebody pick
     * "git or tarball or path" from a menu before typing the thing is a step
     * that exists only because the code would not look at the string, and
     * pluginSourceFor looks.
     *
     * The pin is asked for SECOND and only for a bundle, because it is the one
     * thing that cannot be worked out and the engine refuses an unpinned
     * bundle before it reads a byte. A url carrying a credential is refused
     * here rather than sent — the machine refuses it too and is the authority,
     * but a token pasted into a phone should not travel first.
     */
    const installFromSource = React.useCallback(async (machineId: string) => {
        const typed = await Modal.prompt(
            'Install from a source',
            'A path on that computer, a git remote (add #tag for a ref), or a .tar.gz bundle. '
            + 'Never a url with a token in it.',
            { placeholder: 'git@github.com:acme/notes.git#v1.0.0' },
        );
        if (!typed) return;

        let source = pluginSourceFor(typed);
        if (!source.ok && source.error.includes('sha256 pin')) {
            const pin = await Modal.prompt(
                'That bundle needs its pin',
                'The 64-character sha256 the bundle is checked against, before a byte of it is read.',
                { placeholder: 'sha256' },
            );
            if (!pin) return;
            source = pluginSourceFor(typed, pin);
        }
        if (!source.ok) {
            Modal.alert('That is not a source', source.error);
            return;
        }
        await runOp(machineId, { op: 'install', source: source.source });
    }, [runOp]);

    const section = (machineId: string, report: PluginReport, names: string[], keyPrefix: string) =>
        report.plugins
            .filter((p) => names.includes(p.name))
            .map((plugin) => (
                <MachinePluginRows
                    key={`${keyPrefix}:${plugin.name}`}
                    plugin={plugin}
                    harnesses={report.harnesses}
                    expanded={!!open[`${machineId}:${keyPrefix}:${plugin.name}`]}
                    onToggle={() => setOpen((prev) => ({
                        ...prev,
                        [`${machineId}:${keyPrefix}:${plugin.name}`]: !prev[`${machineId}:${keyPrefix}:${plugin.name}`],
                    }))}
                    busy={busy === `${machineId}:${plugin.name}`}
                    onOp={(params) => void runOp(machineId, params)}
                />
            ));

    return (
        <>
            <Stack.Screen options={{ title: 'Plugins' }} />
            <ItemList
                containerStyle={{ paddingTop: Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0 }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
            >
                {machines.length === 0 && (
                    <ItemGroup>
                        <Item title="No machines connected" showChevron={false} />
                    </ItemGroup>
                )}

                {machines.flatMap((machine) => {
                    const state = managed[machine.id];
                    const report = state?.result?.ok ? state.result.report : null;
                    const catState = catalog[machine.id];
                    const catReport = catState?.result?.ok ? catState.result.report : null;
                    const machineBusy = !!busy && busy.startsWith(`${machine.id}:`);
                    const rows: React.ReactNode[] = [];

                    if (!report) {
                        rows.push(
                            <ItemGroup key={`${machine.id}:problem`} title={machineName(machine)}>
                                <Item
                                    title={state?.loading ? 'Reading…' : 'Could not read this machine'}
                                    subtitle={state?.result && !state.result.ok ? state.result.error : undefined}
                                    subtitleLines={0}
                                    icon={<Ionicons
                                        name={state?.loading ? 'time-outline' : 'warning-outline'}
                                        size={29}
                                        color={state?.loading ? grey : amber}
                                    />}
                                    showChevron={false}
                                />
                            </ItemGroup>,
                        );
                        return rows;
                    }

                    const installedNames = report.plugins.map((p) => p.name);
                    const empty = pluginEmptyReason(report);

                    rows.push(
                        <ItemGroup
                            key={`${machine.id}:installed`}
                            title={machineName(machine)}
                            footer={pluginCountsLine(report)}
                        >
                            {/* A drover.yaml that would not parse is NOT an
                                empty machine and is drawn as a warning, not as
                                "you have none". */}
                            {empty && (
                                <Item
                                    title={report.error ? 'Could not read the config' : 'No plugins yet'}
                                    subtitle={empty}
                                    subtitleLines={0}
                                    icon={<Ionicons
                                        name={report.error ? 'warning-outline' : 'ellipse-outline'}
                                        size={29}
                                        color={report.error ? amber : grey}
                                    />}
                                    showChevron={false}
                                />
                            )}
                            {section(machine.id, report, installedNames, 'installed')}
                            {/* A manifest in the catalog that will not validate,
                                by directory. Named rather than swallowed: the
                                phone should say "this one is broken", not go
                                blank, and the mirror render fails on it. */}
                            {report.errors.map((e) => (
                                <Item
                                    key={`err:${e.dir}`}
                                    title={`${e.name} will not parse`}
                                    subtitle={`${e.dir} — ${e.error}`}
                                    subtitleLines={0}
                                    icon={<Ionicons name="warning-outline" size={29} color={amber} />}
                                    showChevron={false}
                                />
                            ))}
                        </ItemGroup>,
                    );

                    rows.push(
                        <ItemGroup key={`${machine.id}:catalog`}>
                            {/* Not in the catalog: a path, a git remote at a
                                ref, or a pinned bundle. Above the catalog
                                disclosure because it is the thing somebody
                                came here to do that the list below cannot. */}
                            <Item
                                title="Install from a source"
                                subtitle="A path on that computer, a git remote, or a pinned bundle"
                                icon={<Ionicons
                                    name="add-circle-outline"
                                    size={29}
                                    color={machineBusy ? grey : blue}
                                />}
                                /* Inert while any op on THIS machine is in
                                   flight. It has no row of its own to grey out,
                                   so without this a second tap starts a second
                                   install of the same thing. */
                                onPress={machineBusy ? undefined : () => void installFromSource(machine.id)}
                                disabled={machineBusy}
                                showChevron={false}
                            />
                            <Item
                                title="Catalog"
                                subtitle={catReport
                                    ? `${catReport.plugins.filter((p) => p.state === 'not-installed').length} not installed`
                                    : 'What this computer offers'}
                                icon={<Ionicons name="albums-outline" size={29} color={blue} />}
                                onPress={() => {
                                    const next = !openCatalog[machine.id];
                                    setOpenCatalog((prev) => ({ ...prev, [machine.id]: next }));
                                    if (next && !catState) void loadCatalog(machine.id);
                                }}
                                showChevron={false}
                                rightElement={<Ionicons
                                    name={openCatalog[machine.id] ? 'chevron-up' : 'chevron-down'}
                                    size={17}
                                    color={grey}
                                />}
                            />
                            {openCatalog[machine.id] && !catReport && (
                                <Item
                                    title={catState?.loading ? 'Reading…' : 'Could not read the catalog'}
                                    subtitle={catState?.result && !catState.result.ok ? catState.result.error : undefined}
                                    subtitleLines={0}
                                    icon={<Ionicons
                                        name={catState?.loading ? 'time-outline' : 'warning-outline'}
                                        size={29}
                                        color={catState?.loading ? grey : amber}
                                    />}
                                    showChevron={false}
                                />
                            )}
                            {openCatalog[machine.id] && catReport && section(
                                machine.id,
                                catReport,
                                catReport.plugins.filter((p) => p.state === 'not-installed').map((p) => p.name),
                                'catalog',
                            )}
                            {openCatalog[machine.id] && catReport
                                && !catReport.plugins.some((p) => p.state === 'not-installed') && (
                                <Item
                                    title="Everything the catalog offers is installed"
                                    icon={<Ionicons name="checkmark-circle-outline" size={29} color={grey} />}
                                    showChevron={false}
                                />
                            )}
                        </ItemGroup>,
                    );

                    return rows;
                })}
            </ItemList>
        </>
    );
}
