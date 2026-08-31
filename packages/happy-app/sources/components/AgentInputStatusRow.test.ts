/**
 * The one status line under the composer, mounted (DROVE-82).
 *
 * utils/liveStatus.spec.ts proves the live summary, utils/droverUsage.spec.ts
 * the usage mapping and agentInputUsage.spec.ts the derivation; this is the
 * render. The segments come out in the order Clay asked for, the branch is
 * no longer among them (DROVE-90 moved it under the session title), the
 * working segment unfolds the agent tree, and a session with nothing to say
 * renders nothing, which is the shape the composer relies on to collapse
 * the row.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DroverUsageLike } from '@/utils/droverUsage';
import type { LiveStatus } from '@/utils/liveStatus';

// vi.mock factories are hoisted above every import, so what they close over
// has to be hoisted too.
const { host, sessions } = vi.hoisted(() => ({
    host: (name: string) => (props: any) => React.createElement(name, props, props.children),
    sessions: {} as Record<string, { metadata: { liveStatus?: LiveStatus | null } }>,
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
}));

vi.mock('react-native-svg', () => ({ default: host('Svg'), Circle: host('Circle') }));

vi.mock('@expo/vector-icons', () => ({ Ionicons: host('Ionicons'), Octicons: host('Octicons') }));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => {} }) }));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                text: 'text',
                textSecondary: 'secondary',
                divider: 'divider',
                success: 'green',
                textDestructive: 'red',
                gitAddedText: 'added',
                gitRemovedText: 'removed',
            },
        },
    }),
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));

vi.mock('./NativeSettingsMenu', () => ({
    NativeSettingsMenu: host('NativeSettingsMenu'),
}));

vi.mock('./StatusDot', () => ({ StatusDot: host('StatusDot') }));

vi.mock('./AnimatedOverlay', () => ({ AnimatedFade: host('AnimatedFade') }));

// The session store, reduced to the one session the row reads. `storage` is
// what the tree rows use to find a tool's transcript card; there are none.
vi.mock('@/sync/storage', () => ({
    useSession: (id: string) => sessions[id] ?? null,
    storage: (selector: (state: any) => unknown) => selector({ sessionMessages: {} }),
}));

// The real English strings, without expo-localization behind them.
vi.mock('@/text', async () => {
    const { en } = await import('@/text/_default');
    return {
        t: (key: string, params?: Record<string, unknown>) => {
            const value = key.split('.').reduce<any>((node, part) => node?.[part], en);
            if (typeof value === 'function') return value(params);
            if (typeof value === 'string') return value;
            throw new Error(`no translation for ${key}`);
        },
    };
});

import { AgentInputStatusRow, type StatusRowProps } from './AgentInputStatusRow';
import { resolveUsageStrip } from './agentInputUsage';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

const sep5 = Date.parse('2026-09-05T19:00:00Z');
const sep3 = Date.parse('2026-09-03T20:00:00Z');
const paneUsage: DroverUsageLike = {
    capturedAt: 1_000,
    accounts: [
        {
            name: 'main', current: false, loggedIn: true, fetchedAt: 900, headroom: 0,
            cooling: { until: sep3, reason: 'weekly limit at 100%' },
            limits: [{ kind: 'weekly_all', percent: 100, resetsAt: sep3, scope: null, family: null }],
        },
        {
            name: 'jamrizzi', current: true, loggedIn: true, fetchedAt: 950, headroom: 51,
            cooling: null,
            limits: [
                { kind: 'session', percent: 49, resetsAt: 1_200, scope: null, family: null },
                { kind: 'weekly_all', percent: 23, resetsAt: sep5, scope: null, family: null },
                { kind: 'weekly_scoped', percent: 39, resetsAt: sep5, scope: 'Fable', family: 'fable' },
            ],
        },
    ],
};

const online = { text: 'online', color: 'green', dotColor: 'green' };

function mount(element: React.ReactElement) {
    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(element);
    });
    return renderer!;
}

/** What SessionView hands AgentInput for a pane session: metadata, no agent-state windows, no context yet. */
function paneStrip(showRemaining = false) {
    return resolveUsageStrip({
        usageLimits: null,
        droverUsage: paneUsage,
        droverAccount: 'jamrizzi',
        showRemaining,
        contextShown: false,
    });
}

function row(overrides: Partial<StatusRowProps> = {}) {
    const strip = paneStrip();
    return mount(React.createElement(AgentInputStatusRow, {
        sessionId: 'idle',
        connectionStatus: online,
        contextStatus: null,
        weekPercent: strip.weekPercent,
        usageMenuGroups: strip.usageMenuGroups,
        showDetails: true,
        ...overrides,
    }));
}

/** Every Text on the row, flattened, so the assertion reads like the line Clay sees. */
function line(renderer: ReturnType<typeof create>): string[] {
    return renderer.root.findAllByType('Text' as any).map((node: any) => (
        Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)
    ));
}

const now = 1_700_000_000_000;
sessions.idle = { metadata: { liveStatus: null } };
sessions.busy = {
    metadata: {
        liveStatus: {
            at: now,
            turnStartedAt: now - 61_000,
            agents: [
                { id: 'a1', label: 'Sweep the backlog', startedAt: now - 20_000 },
            ],
        },
    },
};

describe('AgentInputStatusRow on an idle pane session', () => {
    it('is connection, week, on one line with a dot between, and no branch', () => {
        const renderer = row();
        expect(line(renderer)).toEqual(['online', '·', '23% week']);
        expect(renderer.root.findAllByType('AnimatedFade' as any)).toHaveLength(1);
    });

    it('carries the connection colour on the dot and has nothing left that truncates from the left', () => {
        const renderer = row();
        const dot = renderer.root.findByType('StatusDot' as any);
        expect(dot.props.color).toBe('green');
        const texts = renderer.root.findAllByType('Text' as any);
        expect(texts.some((node: any) => node.props.ellipsizeMode === 'head')).toBe(false);
        expect(renderer.root.findAllByType('Octicons' as any)).toHaveLength(0);
        const week = texts.find((node: any) => node.props.children === '23% week');
        expect(week.props.ellipsizeMode).toBeUndefined();
    });

    it('opens session info from the connection', () => {
        const onSessionInfoPress = vi.fn();
        const renderer = row({ onSessionInfoPress });
        const pressables = renderer.root.findAllByType('Pressable' as any);
        expect(pressables).toHaveLength(1);
        pressables[0].props.onPress();
        expect(onSessionInfoPress).toHaveBeenCalledTimes(1);
    });

    it('puts the usage popup behind the week figure, this account first and the others folded', () => {
        const strip = paneStrip(true);
        const renderer = row({ weekPercent: strip.weekPercent, usageMenuGroups: strip.usageMenuGroups });
        const menu = renderer.root.findByType('NativeSettingsMenu' as any);
        expect(menu.props.anchor).toBe('bottom');
        expect(menu.props.groups.map((g: any) => [g.key, g.title])).toEqual([
            ['usage', 'jamrizzi · 51% left'],
            ['accounts', 'Other accounts'],
        ]);
        expect(menu.props.groups[0].options.map((o: any) => o.label.split('\n')[0])).toEqual([
            'Session · 51%',
            'Week · 77%',
            'Fable week · 61%',
        ]);
        expect(menu.props.groups[1].options.map((o: any) => o.label.split('\n')[0])).toEqual(['main · 0% left']);
        expect(menu.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual(['77% week']);
    });

    it('keeps the context gauge after the week figure when the session has one', () => {
        const renderer = row({ contextStatus: { percent: 42, detailText: '84k / 200k context', color: 'ok' } });
        expect(line(renderer)).toEqual(['online', '·', '23% week', '·', '42% context']);
        expect(renderer.root.findAllByType('Svg' as any)).toHaveLength(1);
    });

    it('fades with the rest of the composer detail while the chat is scrolled up', () => {
        const renderer = row({ showDetails: false });
        expect(renderer.root.findByType('AnimatedFade' as any).props.visible).toBe(false);
    });
});

describe('AgentInputStatusRow while the session is working', () => {
    it('leads with the state and the turn clock, in the working colour, ahead of the connection', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const renderer = row({ sessionId: 'busy' });
            expect(line(renderer)).toEqual(['1 agent 1m 2s', '·', 'online', '·', '23% week']);
            expect(renderer.root.findByType('StatusDot' as any).props.color).toBe('#007AFF');
        } finally {
            vi.useRealTimers();
        }
    });

    it('ticks the clock every second', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const renderer = row({ sessionId: 'busy' });
            act(() => {
                vi.advanceTimersByTime(3_000);
            });
            expect(line(renderer)[0]).toBe('1 agent 1m 5s');
        } finally {
            vi.useRealTimers();
        }
    });

    it('unfolds the agent tree under the row on tap and stays visible while the chat is scrolled up', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const renderer = row({ sessionId: 'busy', showDetails: false });
            expect(renderer.root.findByType('AnimatedFade' as any).props.visible).toBe(true);
            expect(renderer.root.findAllByType('ScrollView' as any)).toHaveLength(0);
            const working = renderer.root.findAllByType('Pressable' as any)[0];
            expect(working.props.accessibilityLabel).toBe('Working: 1 agent running');
            act(() => {
                working.props.onPress();
            });
            expect(renderer.root.findAllByType('ScrollView' as any)).toHaveLength(1);
            expect(line(renderer)).toContain('Sweep the backlog');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('AgentInputStatusRow with nothing to show', () => {
    it('renders nothing for a session with no connection, no stream, no snapshot and no context', () => {
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: null, showRemaining: false, contextShown: false });
        const renderer = row({
            connectionStatus: undefined,
            weekPercent: strip.weekPercent,
            usageMenuGroups: strip.usageMenuGroups,
        });
        expect(renderer.toJSON()).toBeNull();
    });

    it('still hides a remote session\'s week figure until the context gauge shows, as before', () => {
        const strip = resolveUsageStrip({
            usageLimits: { capturedAt: 1, windows: [{ id: 'seven_day', utilization: 60, resetsAt: sep5 }] },
            droverUsage: null,
            showRemaining: false,
            contextShown: false,
        });
        const renderer = row({ weekPercent: strip.weekPercent, usageMenuGroups: strip.usageMenuGroups });
        expect(line(renderer)).toEqual(['online']);
    });
});
