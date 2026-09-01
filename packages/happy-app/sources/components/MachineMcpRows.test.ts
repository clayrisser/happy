/**
 * What the harness section actually PUTS ON SCREEN (DROVE-274).
 *
 * Rendered rather than reasoned about, because the acceptance criteria are
 * about what Clay sees: a count under each harness, a harness with none saying
 * so rather than vanishing, and an account that has drifted from the default
 * being called out by name.
 *
 * `.ts` and not `.tsx` on purpose — vitest.config.ts includes only
 * `sources/**\/*.{spec,test}.ts`, so a .tsx test is a test that never runs.
 * Elements are built with React.createElement for the same reason.
 */

import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: host('Ionicons') }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#8E8E93', groupped: { chevron: '#C7C7CC' } } } }),
    StyleSheet: { create: (v: unknown) => (typeof v === 'function' ? (v as () => unknown)() : v) },
}));
// The real Item is a pile of platform styling this test does not measure. A
// host stub keeps its PROPS — title, subtitle, detail — which is exactly what
// the assertions are about.
vi.mock('@/components/Item', () => ({ Item: host('Item') }));

import { MachineMcpRows } from './MachineMcpRows';

const server = (name: string, transport = 'stdio', enabled = true) => ({ name, transport, enabled }) as never;

const scope = (id: string, servers: unknown[], over: Record<string, unknown> = {}) => ({
    id,
    label: id,
    source: id === 'default' ? '~/.claude.json' : `~/.claude-accounts/${id}/.claude.json`,
    missing: false,
    error: null,
    servers,
    count: servers.length,
    divergence: null,
    ...over,
}) as never;

const harness = (over: Record<string, unknown> = {}) => ({
    harness: 'claude',
    label: 'Claude Code',
    perAccount: true,
    scopes: [scope('default', [server('pdf'), server('huly'), server('zoom')])],
    count: 3,
    configured: true,
    diverged: false,
    ...over,
}) as never;

const readAt = 1_700_000_000_000;
const now = readAt + 5_000;

function render(props: Record<string, unknown>) {
    let tree: { root: { findAllByType: (t: string) => { props: Record<string, unknown> }[] } };
    act(() => {
        tree = create(React.createElement(MachineMcpRows, { readAt, now, expanded: false, onToggle: () => {}, ...props } as never));
    });
    return tree!;
}

const items = (tree: ReturnType<typeof render>) => tree.root.findAllByType('Item').map((n) => n.props);

/** The Ionicons name on a row's icon. Props, not a stringify — the rendered tree is circular. */
const iconName = (row: Record<string, unknown>) =>
    (row.icon as { props?: { name?: string } } | undefined)?.props?.name;
const titles = (tree: ReturnType<typeof render>) => items(tree).map((p) => String(p.title));

beforeAll(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

describe('collapsed, which is what the page opens on', () => {
    it('shows the count and nothing else, because forty names is not a summary', () => {
        const tree = render({ harness: harness() });
        expect(titles(tree)).toEqual(['MCP servers']);
        const right = items(tree)[0].rightElement as { props: { children: unknown[] } };
        const countText = right.props.children[0] as { props: { children: string } };
        expect(countText.props.children).toBe('3');
    });

    it('says the accounts agree, out loud — silence would read as unchecked', () => {
        const tree = render({
            harness: harness({
                scopes: [
                    scope('default', [server('pdf')]),
                    scope('alt', [server('pdf')]),
                ],
                count: 1,
            }),
        });
        expect(items(tree)[0].subtitle).toBe('Same on all 2 accounts');
    });

    it('falls back to the config path for a harness that has one file', () => {
        const tree = render({
            harness: harness({
                harness: 'cursor',
                label: 'Cursor',
                perAccount: false,
                scopes: [scope('global', [server('pdf')], { source: '~/.cursor/mcp.json' })],
                count: 1,
            }),
        });
        expect(items(tree)[0].subtitle).toBe('~/.cursor/mcp.json');
    });
});

describe('a harness with nothing configured', () => {
    const none = harness({
        harness: 'opencode',
        label: 'OpenCode',
        perAccount: false,
        configured: false,
        count: 0,
        scopes: [scope('global', [], { source: '~/.config/opencode/opencode.json', missing: true })],
    });

    it('says none rather than disappearing', () => {
        const tree = render({ harness: none });
        expect(titles(tree)).toContain('None configured');
    });

    it('says WHY it is empty, so nobody hunts in the wrong file', () => {
        const tree = render({ harness: none });
        expect(items(tree)[0].subtitle).toBe('No ~/.config/opencode/opencode.json on this machine.');
    });

    it('distinguishes a file that exists and configures nothing from one that is absent', () => {
        const present = harness({
            configured: false,
            count: 0,
            scopes: [scope('global', [], { source: '~/.cursor/mcp.json', missing: false })],
        });
        const tree = render({ harness: present });
        expect(items(tree)[0].subtitle).toBe('~/.cursor/mcp.json configures no MCP servers.');
    });

    it('distinguishes an unreadable file from an empty one — one is a bug', () => {
        const broken = harness({
            configured: false,
            count: 0,
            scopes: [scope('global', [], { source: '~/.codex/config.toml', error: 'EACCES' })],
        });
        const tree = render({ harness: broken });
        expect(items(tree)[0].subtitle).toBe('~/.codex/config.toml could not be read (EACCES).');
    });

    it('still says when it looked, because nothing pushes this', () => {
        const tree = render({ harness: none });
        expect(titles(tree)).toContain('Read just now');
    });
});

describe('expanded', () => {
    it('lists every server in the default scope, with its transport', () => {
        const tree = render({
            expanded: true,
            harness: harness({
                scopes: [scope('default', [server('pdf'), server('linear', 'http'), server('feed', 'sse')])],
                count: 3,
            }),
        });
        expect(titles(tree)).toEqual(['MCP servers', 'pdf', 'linear', 'feed', 'Read just now']);
        const byTitle = Object.fromEntries(items(tree).map((p) => [p.title, p]));
        expect(byTitle.pdf.detail).toBe('stdio');
        expect(byTitle.linear.detail).toBe('http');
        expect(byTitle.feed.detail).toBe('sse');
    });

    it('shows a disabled server as disabled rather than dropping it', () => {
        const tree = render({
            expanded: true,
            harness: harness({ scopes: [scope('default', [server('muted', 'stdio', false)])], count: 1 }),
        });
        const row = items(tree).find((p) => p.title === 'muted')!;
        expect(row.subtitle).toBe('Disabled on this machine');
    });

    it('names the config file and when it was read', () => {
        const tree = render({ expanded: true, harness: harness() });
        const last = items(tree).at(-1)!;
        expect(last.title).toBe('Read just now');
        expect(last.subtitle).toBe('~/.claude.json');
    });

    it('does NOT repeat the list for every account — that is what buried the bug', () => {
        const tree = render({
            expanded: true,
            harness: harness({
                scopes: [
                    scope('default', [server('pdf'), server('huly')]),
                    scope('alt', [server('pdf'), server('huly')]),
                    scope('work', [server('pdf'), server('huly')]),
                ],
                count: 2,
            }),
        });
        // Two names, once, not six.
        expect(titles(tree).filter((t) => t === 'pdf')).toHaveLength(1);
        expect(titles(tree)).not.toContain('alt');
        expect(titles(tree)).not.toContain('work');
    });
});

describe('divergence, which is the whole reason the Claude view is per account', () => {
    const drifted = harness({
        diverged: true,
        count: 3,
        scopes: [
            scope('default', [server('pdf'), server('huly'), server('zoom')]),
            scope('mirrored', [server('pdf'), server('huly'), server('zoom')]),
            scope('short', [server('pdf')], { divergence: { missing: ['huly', 'zoom'], extra: [] } }),
        ],
    });

    it('turns the collapsed row amber, so it is visible without expanding', () => {
        const tree = render({ harness: drifted });
        expect(iconName(items(tree)[0])).toBe('warning-outline');
    });

    it('counts what is missing on the collapsed row', () => {
        const tree = render({ harness: drifted });
        expect(items(tree)[0].subtitle).toBe('short is missing 2');
    });

    it('names the drifted account and what it is short of, expanded', () => {
        const tree = render({ expanded: true, harness: drifted });
        const row = items(tree).find((p) => p.title === 'short')!;
        expect(row.subtitle).toBe('missing huly, zoom');
        expect(row.detail).toBe('1');
    });

    it('leaves the matching accounts unlisted', () => {
        const tree = render({ expanded: true, harness: drifted });
        expect(titles(tree)).not.toContain('mirrored');
    });

    it('reports an extra server without crying wolf about it', () => {
        const bespoke = harness({
            diverged: true,
            scopes: [
                scope('default', [server('pdf')]),
                scope('mine', [server('pdf'), server('local')], { divergence: { missing: [], extra: ['local'] } }),
            ],
            count: 2,
        });
        const collapsed = render({ harness: bespoke });
        // Not amber: an account with a server of its own is somebody's choice.
        expect(iconName(items(collapsed)[0])).toBe('extension-puzzle-outline');
        const open = render({ expanded: true, harness: bespoke });
        expect(items(open).find((p) => p.title === 'mine')!.subtitle).toBe('only here: local');
    });

    it('an account whose file could not be read is amber and says so', () => {
        const broken = harness({
            scopes: [
                scope('default', [server('pdf')]),
                scope('corrupt', [], { error: 'unparseable' }),
            ],
            count: 1,
        });
        const tree = render({ expanded: true, harness: broken });
        expect(iconName(items(tree)[0])).toBe('warning-outline');
        const row = items(tree).find((p) => p.title === 'corrupt')!;
        expect(row.subtitle).toContain('could not be read (unparseable)');
    });
});

describe('nothing here is editable, because that was deferred', () => {
    it('gives no row but the disclosure anything to press', () => {
        const tree = render({ expanded: true, harness: harness() });
        const pressable = items(tree).filter((p) => typeof p.onPress === 'function');
        expect(pressable).toHaveLength(1);
        expect(pressable[0].title).toBe('MCP servers');
    });

    it('the disclosure toggles rather than navigating', () => {
        let toggled = 0;
        const tree = render({ harness: harness(), onToggle: () => { toggled += 1; } });
        const row = items(tree)[0];
        expect(row.showChevron).toBe(false);
        (row.onPress as () => void)();
        expect(toggled).toBe(1);
    });
});

describe('the freshness line', () => {
    it('counts up rather than showing a clock time nobody can use', () => {
        const cases: [number, string][] = [
            [0, 'Read just now'],
            [90_000, 'Read 2 minutes ago'],
            [60_000 * 61, 'Read 1 hour ago'],
            [86_400_000 * 3, 'Read 3 days ago'],
        ];
        for (const [age, expected] of cases) {
            const tree = render({ harness: harness(), expanded: true, now: readAt + age });
            expect(titles(tree)).toContain(expected);
        }
    });
});
