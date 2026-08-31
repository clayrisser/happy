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
const { host, sessions, screen } = vi.hoisted(() => ({
    host: (name: string) => (props: any) => React.createElement(name, props, props.children),
    sessions: {} as Record<string, {
        metadata: { liveStatus?: LiveStatus | null };
        todos?: { content: string; status: 'pending' | 'in_progress' | 'completed' }[];
    }>,
    // Wider than the fold threshold by default; the narrow-phone spec moves it.
    screen: { width: 390 },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
    useWindowDimensions: () => screen,
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

// The switch itself is the `/flip` message every other surface sends; what
// the row owes it is the target and the account it is leaving (DROVE-160).
vi.mock('@/utils/droverAccountSwitch', () => ({ confirmDroverSwitch: vi.fn() }));
vi.mock('./SessionAgentsSheet', () => ({ SessionAgentsSheet: host('SessionAgentsSheet') }));
vi.mock('./SessionTasksSheet', () => ({ SessionTasksSheet: host('SessionTasksSheet') }));

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
import { confirmDroverSwitch } from '@/utils/droverAccountSwitch';

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
/** The main thread thinking, with one background agent out beside it. */
sessions.busy = {
    metadata: {
        liveStatus: {
            at: now,
            turnStartedAt: now - 61_000,
            main: { startedAt: now - 61_000, tokens: 251_200 },
            agents: [
                { id: 'a1', label: 'Sweep the backlog', startedAt: now - 20_000 },
            ],
        },
    },
};

/**
 * The case the dot used to get wrong (DROVE-155): the turn is over, the main
 * thread is idle, and a background fan-out is still running.
 */
sessions.agentsOnly = {
    metadata: {
        liveStatus: {
            at: now,
            turnStartedAt: now - 400_000,
            agents: [
                { id: 'a1', label: 'Sweep the backlog', startedAt: now - 380_000, tokens: 274_622 },
                { id: 'a2', label: 'Chase the flake', startedAt: now - 40_000 },
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

    it('opens the quota sheet from the week figure with every window for every account (DROVE-148)', () => {
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
        // Both accounts carry the same three measures, so the sheet answers
        // "where do I flip to" rather than "which account is fullest".
        expect(sheet().props.groups.map((g: any) => [g.key, g.active])).toEqual([
            ['account:jamrizzi', true],
            ['account:main', false],
        ]);
        const rows = sheet().props.groups.flatMap((group: any) => group.rows);
        expect(rows.map((r: any) => [r.name, r.percentText])).toEqual([
            ['Session', '51%'],
            ['Week', '77%'],
            ['Fable week', '61%'],
            ['Session', null],
            ['Week', '0%'],
            ['Fable week', null],
        ]);
        // The track is drawn even for the account at zero.
        expect(rows[4].fraction).toBe(0);
        expect(rows[4].tone).toBe('critical');
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
    it('leads with the main thread\'s own state, clock and tokens, ahead of the agent count', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const renderer = row({ sessionId: 'busy' });
            // The main thread first, then the agents as a bare count: the two
            // never share a number (DROVE-155).
            expect(line(renderer)).toEqual(['working', '1m 2s 251.2k', '1', '·', 'online', '·', '23% week']);
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
            expect(line(renderer)[1]).toBe('1m 5s 251.2k');
        } finally {
            vi.useRealTimers();
        }
    });

    it('names the tool the main thread is blocked on, and only the tool (DROVE-155)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            sessions.tooling = {
                metadata: {
                    liveStatus: {
                        at: now,
                        turnStartedAt: now - 61_000,
                        main: { startedAt: now - 61_000, tokens: 1_530_411 },
                        tool: { id: 't1', name: 'Bash', arg: 'Run the unit suite', startedAt: now - 5_000 },
                    },
                },
            };
            const renderer = row({ sessionId: 'tooling' });
            expect(line(renderer)).toEqual(['Bash', '1m 2s 1.5M', '·', 'online', '·', '23% week']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('lets only the tool name shrink, so the numbers can never truncate', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const renderer = row({ sessionId: 'busy' });
            const shrinking = renderer.root.findAllByType('Text' as any)
                .filter((node: any) => node.props.numberOfLines === 1);
            expect(shrinking).toHaveLength(1);
            expect(shrinking[0].props.children).toBe('working');
        } finally {
            vi.useRealTimers();
        }
    });

    it('folds the tool name away on a 320pt phone and keeps the numbers (DROVE-155)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        screen.width = 320;
        try {
            const renderer = row({ sessionId: 'busy' });
            // The name is what the tree behind the fold carries in full; the
            // clock and the token count are what Clay is watching.
            expect(line(renderer)).toEqual(['1m 2s 251.2k', '1', '·', 'online', '·', '23% week']);
        } finally {
            screen.width = 390;
            vi.useRealTimers();
        }
    });

    it('folds the context percent onto its ring while the main thread works, and a tap unfolds it', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const contextStatus = { percent: 42, detailText: '84k / 200k context', color: 'ok' };
            // Idle, the percent is on the row as before.
            expect(line(row({ contextStatus }))).toContain('42% context');
            // Working, the ring carries it alone: the live token count is the
            // cost readout at that moment, and the row has to fit.
            const renderer = row({ sessionId: 'busy', contextStatus });
            expect(line(renderer)).not.toContain('42% context');
            expect(renderer.root.findAllByType('Svg' as any)).toHaveLength(1);
            const gauge = renderer.root.findAllByType('Pressable' as any).at(-1);
            act(() => {
                gauge!.props.onPress();
            });
            expect(line(renderer)).toContain('84k / 200k context');
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
            expect(working.props.accessibilityLabel).toBe('Main thread: working 1m 2s, 251.2k tokens, 1 agent');
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

/**
 * The rule DROVE-155 settled, asserted so it cannot drift back.
 *
 * Clay: "Is the pulsing blue dot next to the agent blinking when the agents
 * are running or when we're actually thinking in the main chat". The dot means
 * the MAIN thread. The count means the agents.
 */
describe('AgentInputStatusRow dot rule', () => {
    it('is the working blue only while the MAIN thread is working', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            expect(row({ sessionId: 'busy' }).root.findByType('StatusDot' as any).props.color)
                .toBe('#007AFF');
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the connection colour while only background agents are out', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const renderer = row({ sessionId: 'agentsOnly' });
            const dot = renderer.root.findByType('StatusDot' as any);
            expect(dot.props.color).toBe('green');
            expect(dot.props.isPulsing).toBeUndefined();
            // The agents still say how many they are, and nothing else.
            expect(line(renderer)).toEqual(['2', '·', 'online', '·', '23% week']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('is the connection colour on an idle session', () => {
        expect(row().root.findByType('StatusDot' as any).props.color).toBe('green');
    });
});

describe('AgentInputStatusRow going idle', () => {
    it('drops the clock and the token count rather than leaving last turn\'s on the row', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            sessions.turning = {
                metadata: {
                    liveStatus: {
                        at: now,
                        turnStartedAt: now - 61_000,
                        main: { startedAt: now - 61_000, tokens: 251_200 },
                    },
                },
            };
            const renderer = row({ sessionId: 'turning' });
            expect(line(renderer)).toEqual(['working', '1m 2s 251.2k', '·', 'online', '·', '23% week']);
            // The CLI writes an explicit null the moment the turn ends.
            sessions.turning.metadata.liveStatus = null;
            act(() => {
                vi.advanceTimersByTime(1_000);
            });
            expect(line(renderer)).toEqual(['online', '·', '23% week']);
            expect(renderer.root.findByType('StatusDot' as any).props.color).toBe('green');
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops trusting a snapshot the CLI stopped refreshing, instead of ticking on forever', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 200_000);
        try {
            const renderer = row({ sessionId: 'busy' });
            expect(line(renderer)).toEqual(['online', '·', '23% week']);
            expect(renderer.root.findByType('StatusDot' as any).props.color).toBe('green');
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * The sheet as the place the move happens (DROVE-160).
 *
 * The row owns the sheet, so it owns what a tap on a block does: close the
 * sheet, then confirm. The confirm is unconditional here even though the menu
 * path only asks when Remote Control is at risk, because this tap is one of
 * five in a column being read for numbers.
 */
describe('switching account from the quota sheet (DROVE-160)', () => {
    it('closes the sheet and confirms, sending the account it came from', () => {
        vi.mocked(confirmDroverSwitch).mockClear();
        const strip = paneStrip(true);
        const renderer = row({
            sessionId: 'busy',
            weekPercent: strip.weekPercent,
            usageBarGroups: strip.usageBarGroups,
        });
        const sheet = () => renderer.root.findByType('UsageAccountBarsSheet' as any);
        act(() => {
            renderer.root.findAllByType('Pressable' as any)[1].props.onPress();
        });
        expect(sheet().props.open).toBe(true);
        act(() => {
            sheet().props.onSwitchAccount('main');
        });
        expect(sheet().props.open).toBe(false);
        expect(confirmDroverSwitch).toHaveBeenCalledWith({
            sessionId: 'busy',
            account: 'main',
            from: 'jamrizzi',
            always: true,
        });
    });

    it('offers no switch on a preview with no session behind it', () => {
        const strip = paneStrip(true);
        const renderer = row({
            sessionId: undefined,
            weekPercent: strip.weekPercent,
            usageBarGroups: strip.usageBarGroups,
        });
        expect(renderer.root.findByType('UsageAccountBarsSheet' as any).props.onSwitchAccount)
            .toBeUndefined();
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

/**
 * The task segment (DROVE-167). Clay, three times, the last one at midnight:
 * "why does this not let me see my fucking tasks". The list was in the store
 * the whole time with nowhere to land.
 */
describe('AgentInputStatusRow tasks', () => {
    it('says how far through the list the session is, and opens the sheet', () => {
        sessions.withTasks = {
            metadata: { liveStatus: null },
            todos: [
                { content: 'Read the reducer', status: 'completed' },
                { content: 'Write the sheet', status: 'in_progress' },
                { content: 'Wire the wrist', status: 'pending' },
            ],
        };
        const renderer = row({ sessionId: 'withTasks' });
        expect(line(renderer)).toEqual(['1/3 tasks', '·', 'online', '·', '23% week']);

        const sheet = () => renderer.root.findByType('SessionTasksSheet' as any);
        expect(sheet().props.open).toBe(false);
        const segment = renderer.root.findAllByType('Pressable' as any)
            .find((node: any) => node.props.accessibilityLabel === '1 of 3 done');
        act(() => segment!.props.onPress());
        expect(sheet().props.open).toBe(true);
    });

    it('shows no segment at all for a session that never kept a list', () => {
        const renderer = row({ sessionId: 'idle' });
        expect(line(renderer)).toEqual(['online', '·', '23% week']);
    });

    it('opening the quota closes the tasks sheet, since one piece of state holds both', () => {
        sessions.withTasks2 = {
            metadata: { liveStatus: null },
            todos: [{ content: 'Ship it', status: 'pending' }],
        };
        const renderer = row({ sessionId: 'withTasks2' });
        const press = (label: string) => {
            const node = renderer.root.findAllByType('Pressable' as any)
                .find((n: any) => n.props.accessibilityLabel === label);
            act(() => node!.props.onPress());
        };
        press('0 of 1 done');
        expect(renderer.root.findByType('SessionTasksSheet' as any).props.open).toBe(true);
        // Tasks, connection, week: the quota is the third pressable once the
        // task segment is on the row.
        const week = renderer.root.findAllByType('Pressable' as any)[2];
        act(() => week.props.onPress());
        expect(renderer.root.findByType('SessionTasksSheet' as any).props.open).toBe(false);
        expect(renderer.root.findByType('UsageAccountBarsSheet' as any).props.open).toBe(true);
    });
});
