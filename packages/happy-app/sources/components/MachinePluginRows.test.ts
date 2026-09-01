/**
 * What a plugin row actually PUTS ON SCREEN, and what pressing it asks the
 * machine to do (DROVE-310).
 *
 * Rendered rather than reasoned about, because the acceptance criteria are
 * about what Clay sees and touches: enable, disable, install, uninstall, and
 * scoping a plugin globally or to one harness, all from the phone. A test of
 * the wording alone would pass while every row was inert.
 *
 * `.ts` and not `.tsx` on purpose — vitest.config.ts includes only
 * `sources/**\/*.{spec,test}.ts`, so a .tsx test is a test that never runs.
 * Elements are built with React.createElement for the same reason.
 */

import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const { host } = vi.hoisted(() => ({
    host: (name: string) => (props: Record<string, unknown>) =>
        React.createElement(name, props, props.children as React.ReactNode),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
    Text: host('Text'),
    View: host('View'),
    Pressable: host('Pressable'),
    ActivityIndicator: host('ActivityIndicator'),
    // Mocked so the "no field here" assertion below can look for one and find
    // none, rather than passing because the import was undefined.
    TextInput: host('TextInput'),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: host('Ionicons') }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#8E8E93', groupped: { chevron: '#C7C7CC' } } } }),
    StyleSheet: { create: (v: unknown) => (typeof v === 'function' ? (v as () => unknown)() : v) },
}));
// The real Item is a pile of platform styling this test does not measure. A
// host stub keeps its PROPS — title, subtitle, onPress — which is exactly what
// the assertions are about.
vi.mock('@/components/Item', () => ({ Item: host('Item') }));

import { MachinePluginRows } from './MachinePluginRows';

const harnesses = ['claude', 'cursor', 'codex', 'opencode', 'pi'];

const plugin = (over: Record<string, unknown> = {}) => ({
    name: '@drover/huly',
    id: { scope: '@drover', name: 'huly', full: '@drover/huly' },
    version: '1.2.0',
    manifestVersion: 1,
    summary: 'Huly ticketing',
    schema: 'drover.plugin/v1',
    origin: 'catalog',
    dir: '~/Projects/bitspur/cattle-drover/plugins/huly',
    state: 'enabled',
    scope: { kind: 'global' },
    when: null,
    enableDefault: true,
    builds: false,
    provides: {
        mcp: [{ name: 'huly', when: null }],
        skills: ['skills/huly-ticket'],
        commands: [],
        subagents: [],
        rules: [],
        bin: [],
        hooks: [{ event: 'preToolUse', matcher: 'mcp__huly__.*', when: null }],
    },
    requires: { commands: [], platform: [], plugins: [] },
    vendor: [],
    capabilities: { network: null, paths: [], credentialNames: [], harnesses: [], sudo: false },
    warnings: [],
    vars: [],
    from: null,
    installedAt: null,
    sha256: null,
    error: null,
    ...over,
}) as never;

type Props = Record<string, unknown>;

function render(props: Props) {
    let tree: { root: { findAllByType: (t: string) => { props: Record<string, unknown> }[] } };
    act(() => {
        tree = create(React.createElement(MachinePluginRows, {
            harnesses,
            expanded: true,
            onToggle: () => {},
            onOp: () => {},
            ...props,
        } as never));
    });
    return tree!;
}

const items = (tree: ReturnType<typeof render>) => tree.root.findAllByType('Item').map((n) => n.props);
const titles = (tree: ReturnType<typeof render>) => items(tree).map((i) => String(i.title));
const row = (tree: ReturnType<typeof render>, title: string) => items(tree).find((i) => i.title === title);
/**
 * Every WORD on screen. The string-valued props only — `icon` holds React
 * elements whose fibers close a cycle, and the words are what these
 * assertions are about anyway.
 */
/**
 * Whether a scope row is the one in force. The icon is a PROP of Item, not a
 * child of it, so the mocked Item never renders it into the tree — reading the
 * prop is the only way to see which radio is filled.
 */
const ticked = (tree: ReturnType<typeof render>, title: string) => {
    const icon = row(tree, title)?.icon as { props?: { name?: string } } | undefined;
    return icon?.props?.name === 'radio-button-on';
};

const text = (tree: ReturnType<typeof render>) =>
    items(tree)
        .flatMap((i) => [i.title, i.subtitle, i.detail])
        .filter((v) => typeof v === 'string')
        .join('\n');

describe('the collapsed row', () => {
    it('answers "is it on" and "what does it add", and names the full identity', () => {
        const tree = render({ plugin: plugin(), expanded: false });
        const head = items(tree)[0];
        expect(head.title).toBe('huly');
        expect(String(head.subtitle)).toContain('Enabled');
        expect(String(head.subtitle)).toContain('1 MCP');
        // The FULL namespaced name is what every route and drover.yaml entry
        // is keyed by, so it is on the row, not only in the disclosure.
        expect(String(head.subtitle)).toContain('@drover/huly');
        expect(head.detail).toBe('1.2.0');
    });

    it('shows the narrowed scope on the row itself', () => {
        const tree = render({
            plugin: plugin({ state: 'disabled', scope: { kind: 'harness', harnesses: ['codex'] } }),
            expanded: false,
        });
        expect(String(items(tree)[0].subtitle)).toContain('Disabled · codex');
    });

    it('offers NOTHING to press but the disclosure — an uninstall is not one thumb from a scroll', () => {
        const tree = render({ plugin: plugin(), expanded: false });
        expect(titles(tree)).toEqual(['huly']);
    });
});

describe('the verbs, which is what this view has and the MCP view does not', () => {
    it('offers disable and uninstall on an enabled plugin, and never enable', () => {
        const tree = render({ plugin: plugin() });
        expect(titles(tree)).toContain('Disable');
        expect(titles(tree)).toContain('Uninstall');
        expect(titles(tree)).not.toContain('Enable');
        expect(titles(tree)).not.toContain('Install');
    });

    it('offers enable on a disabled plugin, whose files are still there', () => {
        const tree = render({ plugin: plugin({ state: 'disabled' }) });
        expect(titles(tree)).toContain('Enable');
        expect(titles(tree)).not.toContain('Disable');
        expect(titles(tree)).toContain('Uninstall');
    });

    it('offers only install on one that is not installed, and no scope to set', () => {
        const tree = render({ plugin: plugin({ state: 'not-installed' }) });
        expect(titles(tree)).toContain('Install');
        expect(titles(tree)).not.toContain('Uninstall');
        expect(titles(tree)).not.toContain('Every harness');
        expect(titles(tree)).not.toContain('codex');
    });

    it('asks the machine for the op the row names', () => {
        const asked: unknown[] = [];
        const tree = render({ plugin: plugin(), onOp: (p: unknown) => asked.push(p) });
        (row(tree, 'Disable')!.onPress as () => void)();
        expect(asked).toEqual([{ op: 'disable', name: '@drover/huly' }]);
    });

    it('installs by NAME from the catalog, never by a url typed here', () => {
        const asked: unknown[] = [];
        const tree = render({ plugin: plugin({ state: 'not-installed' }), onOp: (p: unknown) => asked.push(p) });
        (row(tree, 'Install')!.onPress as () => void)();
        expect(asked).toEqual([{ op: 'install', source: { kind: 'catalog', name: '@drover/huly' } }]);
    });

    it('marks uninstall destructive so it does not read like the rest', () => {
        const tree = render({ plugin: plugin() });
        expect(row(tree, 'Uninstall')!.destructive).toBe(true);
        expect(row(tree, 'Disable')!.destructive).toBe(false);
    });

    it('says an install will run the plugin\'s own build BEFORE the install row', () => {
        const tree = render({ plugin: plugin({ state: 'not-installed', builds: true }) });
        const all = titles(tree);
        expect(all).toContain('Installing this runs its own build');
        expect(all.indexOf('Installing this runs its own build')).toBeLessThan(all.indexOf('Install'));
    });
});

describe('scope: global or a named harness, never a toggle', () => {
    it('lists every harness the machine knows, so a re-scope is not a guess', () => {
        const tree = render({ plugin: plugin() });
        for (const h of harnesses) expect(titles(tree)).toContain(h);
        expect(titles(tree)).toContain('Every harness');
    });

    it('ticks global, and only global, when the plugin is global', () => {
        const tree = render({ plugin: plugin() });
        expect(ticked(tree, 'Every harness')).toBe(true);
        for (const h of harnesses) expect(ticked(tree, h)).toBe(false);
    });

    it('ticks the scoped harnesses instead when it is narrowed', () => {
        const tree = render({ plugin: plugin({ scope: { kind: 'harness', harnesses: ['codex', 'pi'] } }) });
        expect(ticked(tree, 'Every harness')).toBe(false);
        expect(ticked(tree, 'codex')).toBe(true);
        expect(ticked(tree, 'pi')).toBe(true);
        expect(ticked(tree, 'claude')).toBe(false);
    });

    it('re-scopes to the harness pressed, as an enable carrying the scope', () => {
        const asked: unknown[] = [];
        const tree = render({ plugin: plugin(), onOp: (p: unknown) => asked.push(p) });
        (row(tree, 'codex')!.onPress as () => void)();
        expect(asked).toEqual([{
            op: 'enable',
            name: '@drover/huly',
            scope: { kind: 'harness', harnesses: ['codex'] },
        }]);
    });

    it('widens back to global from the global row', () => {
        const asked: unknown[] = [];
        const tree = render({
            plugin: plugin({ scope: { kind: 'harness', harnesses: ['codex'] } }),
            onOp: (p: unknown) => asked.push(p),
        });
        (row(tree, 'Every harness')!.onPress as () => void)();
        expect(asked).toEqual([{ op: 'enable', name: '@drover/huly', scope: { kind: 'global' } }]);
    });
});

describe('an op in flight', () => {
    it('makes every action inert rather than making the rows vanish under a thumb', () => {
        const tree = render({ plugin: plugin(), busy: true });
        for (const title of ['Disable', 'Uninstall', 'Every harness', 'codex']) {
            expect(row(tree, title)!.onPress).toBeUndefined();
            expect(row(tree, title)!.disabled).toBe(true);
        }
        // Still on screen, all of them.
        expect(titles(tree)).toContain('Uninstall');
    });
});

describe('the facts behind the disclosure', () => {
    it('lists the names behind each count', () => {
        const tree = render({ plugin: plugin() });
        expect(row(tree, 'MCP servers')!.subtitle).toBe('huly');
        expect(row(tree, 'Skills')!.subtitle).toBe('skills/huly-ticket');
        expect(String(row(tree, 'Hooks')!.subtitle)).toContain('preToolUse');
    });

    it('draws no heading for a kind the plugin provides none of', () => {
        expect(titles(render({ plugin: plugin() }))).not.toContain('Rules');
        expect(titles(render({ plugin: plugin() }))).not.toContain('On PATH');
    });

    it('NAMES a credential and never offers a field for it', () => {
        const tree = render({
            plugin: plugin({
                capabilities: { network: null, paths: [], credentialNames: ['HULY_API_KEY'], harnesses: [], sudo: false },
            }),
        });
        const body = text(tree);
        expect(body).toContain('HULY_API_KEY');
        expect(body).toContain('set on the computer');
        // Nothing on this screen may ACCEPT a value: a token typed on a phone
        // is a token that has already been somewhere it should not be.
        expect(tree.root.findAllByType('TextInput')).toHaveLength(0);
    });

    it('names the config KEYS drover.yaml sets, never a value', () => {
        const tree = render({ plugin: plugin({ vars: ['HULY_URL'] }) });
        expect(text(tree)).toContain('HULY_URL');
        expect(text(tree)).toContain('names only');
    });

    it('says a plugin is broken ABOVE everything it claims about itself', () => {
        const tree = render({ plugin: plugin({ error: 'not in the catalog' }) });
        const all = titles(tree);
        expect(all).toContain('This one is broken');
        expect(all.indexOf('This one is broken')).toBeLessThan(all.indexOf('Huly ticketing'));
    });

    it("carries the validator's warnings, as sentences", () => {
        const tree = render({ plugin: plugin({ warnings: ['grants every network host'] }) });
        expect(text(tree)).toContain('grants every network host');
    });

    it('names where an installed-from-git plugin came from, host and path only', () => {
        const tree = render({
            plugin: plugin({
                origin: 'store',
                from: { kind: 'git', locator: 'github.com/acme/notes.git', ref: 'v1', sha256: null, commit: 'abc' },
            }),
        });
        expect(titles(tree)).toContain('From github.com/acme/notes.git at v1');
    });
});
