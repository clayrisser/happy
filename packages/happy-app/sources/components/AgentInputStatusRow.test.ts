/**
 * The one status line under the composer, mounted (DROVE-82).
 *
 * utils/liveStatus.spec.ts proves the live summary, utils/droverUsage.spec.ts
 * the usage mapping and agentInputUsage.spec.ts the derivation; this is the
 * render. The segments come out in the order Clay asked for, the branch is
 * no longer among them (DROVE-90 moved it under the session title), and a
 * session with nothing to say renders nothing, which is the shape the
 * composer relies on to collapse the row.
 *
 * Both expanders open a sheet rather than unfolding under the row (DROVE-117
 * for the quota, DROVE-111 for the tree), and one piece of state holds which
 * is open, so the assertions here are about what the row asks for and about
 * the two never being open at once.
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
                warningCritical: 'critical',
                gitAddedText: 'added',
                gitRemovedText: 'removed',
            },
        },
    }),
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));

vi.mock('./StatusDot', () => ({ StatusDot: host('StatusDot') }));

vi.mock('./AnimatedOverlay', () => ({ AnimatedFade: host('AnimatedFade') }));

// Both sheets (DROVE-117's quota, DROVE-111's agent tree) pull in
// gesture-handler and reanimated through ComposerSheet, neither of
// which vitest can transform. What the row owes them is the open flag and the
// content; UsageAccountBars.test.ts renders the real bars.
vi.mock('./UsageAccountBarsSheet', () => ({ UsageAccountBarsSheet: host('UsageAccountBarsSheet') }));
vi.mock('./SessionAgentsSheet', () => ({ SessionAgentsSheet: host('SessionAgentsSheet') }));

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
        usageBarGroups: strip.usageBarGroups,
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
        // The connection, then the week figure that unfolds the bars.
        expect(pressables).toHaveLength(2);
        pressables[0].props.onPress();
        expect(onSessionInfoPress).toHaveBeenCalledTimes(1);
    });

    it('opens the quota sheet from the week figure with a bar per window and per account (DROVE-117)', () => {
        const strip = paneStrip(true);
        const renderer = row({ weekPercent: strip.weekPercent, usageBarGroups: strip.usageBarGroups });
        const sheet = () => renderer.root.findByType('UsageAccountBarsSheet' as any);
        // Closed by default: the row is still one line until it is asked for.
        expect(sheet().props.open).toBe(false);
        const week = renderer.root.findAllByType('Pressable' as any)[1];
        act(() => {
            week.props.onPress();
        });
        expect(sheet().props.open).toBe(true);
        const rows = sheet().props.groups.flatMap((group: any) => group.rows);
        expect(rows.map((r: any) => [r.name, r.percentText])).toEqual([
            ['Session', '51%'],
            ['Week', '77%'],
            ['Fable week', '61%'],
            ['main', '0%'],
        ]);
        // The track is drawn even for the account at zero.
        expect(rows[3].fraction).toBe(0);
        expect(rows[3].tone).toBe('critical');
        expect(line(renderer)).toContain('77% week');
        // And the sheet closes itself, which is what the backdrop and the
        // grabber both call.
        act(() => {
            sheet().props.onClose();
        });
        expect(sheet().props.open).toBe(false);
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

    it('opens the agent tree in the same sheet the quota uses and stays visible while the chat is scrolled up (DROVE-111)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const renderer = row({ sessionId: 'busy', showDetails: false });
            const agents = () => renderer.root.findByType('SessionAgentsSheet' as any);
            expect(renderer.root.findByType('AnimatedFade' as any).props.visible).toBe(true);
            // Closed by default, and nothing unfolded under the row.
            expect(agents().props.open).toBe(false);
            expect(renderer.root.findAllByType('ScrollView' as any)).toHaveLength(0);
            const working = renderer.root.findAllByType('Pressable' as any)[0];
            expect(working.props.accessibilityLabel).toBe('Working: 1 agent running');
            act(() => {
                working.props.onPress();
            });
            expect(agents().props.open).toBe(true);
            // The tree's rows go to the sheet, and the row itself draws none.
            expect(agents().props.summary.rows.some((r: any) => r.title === 'Sweep the backlog'))
                .toBe(true);
            expect(renderer.root.findAllByType('ScrollView' as any)).toHaveLength(0);
            expect(line(renderer)).not.toContain('Sweep the backlog');
            act(() => {
                agents().props.onClose();
            });
            expect(agents().props.open).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('never has both sheets open, because one value says which is (DROVE-111)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const strip = paneStrip(true);
            const renderer = row({
                sessionId: 'busy',
                weekPercent: strip.weekPercent,
                usageBarGroups: strip.usageBarGroups,
            });
            const agents = () => renderer.root.findByType('SessionAgentsSheet' as any);
            const usage = () => renderer.root.findByType('UsageAccountBarsSheet' as any);
            const pressables = renderer.root.findAllByType('Pressable' as any);
            act(() => {
                pressables[0].props.onPress();
            });
            expect([agents().props.open, usage().props.open]).toEqual([true, false]);
            act(() => {
                renderer.root.findAllByType('Pressable' as any)[2].props.onPress();
            });
            expect([agents().props.open, usage().props.open]).toEqual([false, true]);
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
            usageBarGroups: strip.usageBarGroups,
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
        const renderer = row({ weekPercent: strip.weekPercent, usageBarGroups: strip.usageBarGroups });
        expect(line(renderer)).toEqual(['online']);
    });
});
