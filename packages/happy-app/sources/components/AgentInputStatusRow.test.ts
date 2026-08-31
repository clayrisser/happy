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
const { host, sessions, machines, pushed, screen } = vi.hoisted(() => ({
    host: (name: string) => (props: any) => React.createElement(name, props, props.children),
    sessions: {} as Record<string, {
        metadata: { liveStatus?: LiveStatus | null; machineId?: string };
        todos?: { content: string; status: 'pending' | 'in_progress' | 'completed' }[];
        // `'online'`, or the timestamp it was last seen at (DROVE-231): the
        // dot's yellow-to-red threshold measures off that number.
        presence?: 'online' | number;
        activeAt?: number;
    }>,
    // The machines the sessions above run on, for the add row (DROVE-208).
    machines: {} as Record<string, { metadata?: { displayName?: string; host?: string } }>,
    pushed: [] as string[],
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

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: () => {} }),
    router: { push: (href: string) => { pushed.push(href); } },
}));

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

// The model's picker is a native menu on iOS; the host module reaches for a
// platform file vitest cannot resolve. What the row owes it is the group and
// the label.
vi.mock('./NativeSettingsMenu', () => ({ NativeSettingsMenu: host('NativeSettingsMenu') }));

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
    useMachine: (id: string) => machines[id] ?? null,
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
import { statusRowShrink } from './statusRowLayout';
import { statusDotColors } from './statusDotState';
import { statusStripAccountCap } from './statusStripLayout';
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

const online = { text: 'online', dotColor: 'green' };

/**
 * 84k of a 200k window: the two numbers the phone actually has (DROVE-231).
 * `contextSize` is assembled in the reducer from the API's own usage block and
 * `contextWindow` rides beside it, so no CLI change is behind this reading.
 */
const context = { contextSize: 84_000, contextWindow: 200_000 };

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
    });
}

function row(overrides: Partial<StatusRowProps> = {}) {
    const strip = paneStrip();
    return mount(React.createElement(AgentInputStatusRow, {
        sessionId: 'idle',
        connectionStatus: online,
        contextUsage: null,
        weekPercent: strip.weekPercent,
        usageBarGroups: strip.usageBarGroups,
        showDetails: true,
        ...overrides,
    }));
}

/** The one segment a screen reader calls `label`, so an assertion never counts indexes. */
function segment(renderer: ReturnType<typeof create>, label: string): any {
    return renderer.root.findAll(
        (node: any) => typeof node.type === 'string' && node.props?.accessibilityLabel === label,
    )[0];
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
 * The row Clay photographed on DROVE-223: no tool, so the label is the working
 * word, six agents out, `4m 20s` on the clock and `51.6k` spent.
 */
sessions.photographed = {
    metadata: {
        liveStatus: {
            at: now,
            turnStartedAt: now - 259_000,
            main: { startedAt: now - 259_000, tokens: 51_600 },
            agents: [1, 2, 3, 4, 5, 6].map((n) => ({
                id: `a${n}`, label: `Agent ${n}`, startedAt: now - 20_000,
            })),
        },
    },
};

/** The same row with a task list on it, which is the widest it ever gets. */
sessions.photographedWithTasks = {
    metadata: sessions.photographed.metadata,
    todos: [
        { content: 'Read the reducer', status: 'completed' },
        { content: 'Write the sheet', status: 'in_progress' },
        { content: 'Wire the wrist', status: 'pending' },
    ],
};

/**
 * Clay's night, from a CLI that publishes the tally (DROVE-184): the main
 * thread spent 51.6k and nine subagents spent 200k each, so the row's old
 * number understated it by an order of magnitude.
 */
sessions.tallied = {
    metadata: {
        liveStatus: {
            at: now,
            turnStartedAt: now - 259_000,
            main: { startedAt: now - 259_000, tokens: 51_600 },
            tokens: { turn: 1_851_600, turnMain: 51_600, session: 1_851_600, sessionMain: 51_600 },
            agents: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
                id: `a${n}`, label: `Agent ${n}`, startedAt: now - 20_000, tokens: 200_000,
            })),
        },
    },
};

/** The same fan-out once it has outlived the turn: no main block, tally still live. */
sessions.talliedAgentsOnly = {
    metadata: {
        liveStatus: {
            at: now,
            turnStartedAt: now - 400_000,
            tokens: { turn: 1_800_000, turnMain: 51_600, session: 1_851_600, sessionMain: 51_600 },
            agents: [1, 2, 3].map((n) => ({
                id: `a${n}`, label: `Agent ${n}`, startedAt: now - 380_000, tokens: 600_000,
            })),
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

/**
 * A session with a machine stamped on it, and that machine's name (DROVE-208).
 * `busy` above deliberately has none, which is the no-add-row case.
 */
sessions.onDrogon = { metadata: { liveStatus: null, machineId: 'm-drogon' } };
sessions.onUnnamedMachine = { metadata: { liveStatus: null, machineId: 'm-unnamed-01' } };
machines['m-drogon'] = { metadata: { displayName: 'drogon', host: 'drogon.local' } };

describe('AgentInputStatusRow on an idle pane session', () => {
    it('is the account and its quota, with no word for the connection (DROVE-138, DROVE-178)', () => {
        const renderer = row();
        expect(line(renderer)).toEqual(['jamrizzi', '23%']);
        expect(line(renderer)).not.toContain('online');
        expect(renderer.root.findAllByType('AnimatedFade' as any)).toHaveLength(1);
    });

    it('keeps the window word only when there is no account to head the quota', () => {
        const strip = resolveUsageStrip({
            usageLimits: { capturedAt: 1, windows: [{ id: 'seven_day', utilization: 77, resetsAt: sep5 }] },
            droverUsage: null,
            showRemaining: false,
        });
        expect(line(row({ weekPercent: strip.weekPercent, usageBarGroups: strip.usageBarGroups })))
            .toEqual(['77% week']);
    });

    it('carries the connection colour on the dot and has nothing left that truncates from the left', () => {
        const renderer = row();
        const dot = renderer.root.findByType('StatusDot' as any);
        // The dot's own table paints it now, not the colour the connection
        // carried (DROVE-231): one place decides the state and paints it.
        expect(dot.props.color).toBe(statusDotColors.connected);
        const texts = renderer.root.findAllByType('Text' as any);
        expect(texts.some((node: any) => node.props.ellipsizeMode === 'head')).toBe(false);
        expect(renderer.root.findAllByType('Octicons' as any)).toHaveLength(0);
        const percent = texts.find((node: any) => node.props.children === '23%');
        expect(percent.props.ellipsizeMode).toBeUndefined();
    });

    it('says the state in words on the dot, since the screen no longer does', () => {
        const renderer = row();
        // Every state the dot can be in has a spoken name now, because the dot
        // is the only thing saying it (DROVE-231).
        expect(segment(renderer, 'Connected')).toBeTruthy();
        expect(renderer.root.findByType('StatusDot' as any).props.size).toBe(7);
    });

    it('opens session info from the dot, which inherited the word\'s tap target', () => {
        const onSessionInfoPress = vi.fn();
        const renderer = row({ onSessionInfoPress });
        act(() => {
            segment(renderer, 'Connected').props.onPress();
        });
        expect(onSessionInfoPress).toHaveBeenCalledTimes(1);
    });

    /**
     * The model is NOT on this row (DROVE-178). It was here from DROVE-138
     * until DROVE-153 freed the gap on the button row that Clay drew his
     * arrow into; the three tests that lived here, for the one-tap picker,
     * the native menu and the account shrinking before the name, moved to
     * the capsule with it. What is asserted here is that the row is shorter.
     */
    it('does not draw the model any more, so the row is the clock, the account and the gauge', () => {
        const renderer = row();
        expect(segment(renderer, 'Model')).toBeUndefined();
        expect(line(renderer).some((text) => /Opus|Fable|Sonnet/.test(text))).toBe(false);
    });

    it('opens the quota sheet from the week figure with every window for every account (DROVE-148)', () => {
        const strip = paneStrip(true);
        const renderer = row({ weekPercent: strip.weekPercent, usageBarGroups: strip.usageBarGroups });
        const sheet = () => renderer.root.findByType('UsageAccountBarsSheet' as any);
        // Closed by default: the row is still one line until it is asked for.
        expect(sheet().props.open).toBe(false);
        act(() => {
            segment(renderer, 'Quota, jamrizzi 77%').props.onPress();
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
        expect(line(renderer)).toEqual(['jamrizzi', '77%']);
        // And the sheet closes itself, which is what the backdrop and the
        // grabber both call.
        act(() => {
            sheet().props.onClose();
        });
        expect(sheet().props.open).toBe(false);
    });

    it('draws the context gauge as the ring alone once the account is on the row (DROVE-138)', () => {
        const renderer = row({ contextUsage: context });
        // The ring fills toward the next COMPACTION, so the text is the
        // cheapest thing on a full row to lose.
        expect(line(renderer)).toEqual(['jamrizzi', '23%']);
        expect(renderer.root.findAllByType('Svg' as any)).toHaveLength(1);
        // And the tap prints the sentence WITH ITS SOURCE in it (DROVE-231):
        // both real numbers and where the compaction point sits.
        act(() => {
            segment(renderer, 'Context').props.onPress();
        });
        expect(line(renderer)).toContain('84.0k of 200.0k context, compacts near 184.0k');
    });

    it('keeps the context percent printed on an idle session with no account taking the width', () => {
        const strip = resolveUsageStrip({
            usageLimits: { capturedAt: 1, windows: [{ id: 'seven_day', utilization: 77, resetsAt: sep5 }] },
            droverUsage: null,
            showRemaining: false,
        });
        const renderer = row({
            weekPercent: strip.weekPercent,
            usageBarGroups: strip.usageBarGroups,
            contextUsage: context,
        });
        // 46% of the way to the compaction point, not 42% of the window: the
        // number agrees with the ring beside it (DROVE-231).
        expect(line(renderer)).toEqual(['46% context', '77% week']);
    });

    it('fades with the rest of the composer detail while the chat is scrolled up', () => {
        const renderer = row({ showDetails: false });
        expect(renderer.root.findByType('AnimatedFade' as any).props.visible).toBe(false);
    });

    it('drops the account\'s name in zen mode, and with it the folds the name paid for', () => {
        vi.mocked(confirmDroverSwitch).mockClear();
        const strip = paneStrip(true);
        const renderer = row({
            sessionId: 'busy',
            hideAccount: true,
            weekPercent: strip.weekPercent,
            usageBarGroups: strip.usageBarGroups,
            contextUsage: context,
        });
        // The window keeps its word with no account to head it, and the
        // context percent stays printed, since nothing is taking its width.
        expect(line(renderer)).toEqual(['46% context', '77% week']);
        // The account is hidden, not forgotten: the sheet still opens on it
        // and a switch still says which account it is leaving (DROVE-160).
        const sheet = () => renderer.root.findByType('UsageAccountBarsSheet' as any);
        expect(sheet().props.groups.map((g: any) => [g.account, g.active])).toEqual([
            ['jamrizzi', true],
            ['main', false],
        ]);
        act(() => {
            sheet().props.onSwitchAccount('main');
        });
        expect(confirmDroverSwitch).toHaveBeenCalledWith({
            sessionId: 'busy',
            account: 'main',
            from: 'jamrizzi',
            always: true,
        });
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
            // NO WORKING WORD. Clay: "Don't show text working." The dot is
            // blinking blue instead, which is the whole of DROVE-231's table.
            // Left: the clock and the workers. Centre: the tally. Right: the
            // account and its percentage.
            expect(line(renderer)).toEqual(['1m 2s', '1', '251.2k', 'jamrizzi', '23%']);
            expect(line(renderer)).not.toContain('working');
            const dot = renderer.root.findByType('StatusDot' as any);
            expect(dot.props.color).toBe(statusDotColors.working);
            expect(dot.props.isPulsing).toBe(true);
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
            expect(line(renderer)[0]).toBe('1m 5s');
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
            // The label slot only ever holds a TOOL now, so `Bash` is the one
            // word the strip prints about what the main thread is doing.
            expect(line(renderer)).toEqual(['Bash', '1m 2s', '1.5M', 'jamrizzi', '23%']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('lets only the tool name shrink, so the numbers can never truncate', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const renderer = row({ sessionId: 'busy' });
            // The tool name and the account: two now the model has gone back
            // to the button row (DROVE-178), and they give way in that order
            // backwards (statusRowShrink). The clock, the token count and the
            // quota number are not among them.
            const shrinking = renderer.root.findAllByType('Text' as any)
                .filter((node: any) => node.props.numberOfLines === 1);
            // Only the account, now the working word is gone: nothing else on
            // the strip may be cut mid-string.
            expect(shrinking.map((node: any) => node.props.children))
                .toEqual(['jamrizzi']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('needs no fold at all on a 320pt phone now the model has gone (DROVE-155, DROVE-178)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        screen.width = 320;
        try {
            // This used to fold the tool name AND then the model whole, and
            // 320 was still 6pt over after both. With the model back on the
            // button row the same row draws entire on the narrowest phone
            // there is, which is the width DROVE-178 bought back.
            expect(line(row({ sessionId: 'busy' })))
                .toEqual(['1m 2s', '1', '251.2k', 'jamrizzi', '23%']);
        } finally {
            screen.width = 390;
            vi.useRealTimers();
        }
    });

    it('caps a long MCP tool name at under half the row, so it cannot squeeze the account', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            sessions.mcp = {
                metadata: {
                    liveStatus: {
                        at: now,
                        turnStartedAt: now - 61_000,
                        main: { startedAt: now - 61_000, tokens: 1_530_411 },
                        tool: { id: 't1', name: 'mcp__chrome_devtools__take_screenshot', startedAt: now - 5_000 },
                    },
                },
            };
            const renderer = row({ sessionId: 'mcp' });
            // A 36-character MCP name cannot squeeze the account, and it is
            // the ZONE that stops it now, not a cap on the segment. The left
            // zone gets half of what the centre leaves and the name folds
            // inside it; the account lives in the other zone entirely.
            expect(line(renderer)).not.toContain('mcp__chrome_devtools__take_screenshot');
            expect(line(renderer)).toContain('jamrizzi');
            const live = renderer.root.findAllByType('Pressable' as any)
                .find((node: any) => String(node.props.accessibilityLabel).startsWith('Main thread:'));
            const style = live.props.style({ pressed: false });
            expect(style.flexShrink).toBe(statusRowShrink.live);
            // No `maxWidth` anywhere on it. DROVE-223's `45%` was a share of
            // the WHOLE row that no layout function could see; the zone's
            // share is measured, and this segment carries no cap at all.
            expect(style.maxWidth).toBeUndefined();
            const account = renderer.root.findAllByType('Text' as any)
                .find((node: any) => node.props.children === 'jamrizzi');
            expect(account.props.style.flexShrink).toBe(statusRowShrink.account);
            // The account's own cap IS a measured number, off the right zone.
            expect(typeof account.props.style.maxWidth).toBe('number');
            expect(statusRowShrink.live).toBeLessThan(statusRowShrink.account);
        } finally {
            vi.useRealTimers();
        }
    });

    /**
     * DROVE-223's row, and DROVE-231's answer to it.
     *
     * Clay photographed `● wor… 4m 20s 51.6k ⛄6 ˄ · main 8% ˄`: the working
     * word cut to three letters on a row two thirds empty. 223 fixed the cap
     * that cut it. 231 removes the word: Clay asked for it to go and gave the
     * state to the dot, so there is no longer anything for a cap to cut.
     */
    it('never prints the working word at any width, and blinks blue instead', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            for (const width of [320, 375, 393]) {
                screen.width = width;
                const renderer = row({ sessionId: 'photographed' });
                expect(line(renderer), `width ${width}`).not.toContain('working');
                expect(line(renderer).join(' '), `width ${width}`).not.toContain('wor…');
                const dot = renderer.root.findByType('StatusDot' as any);
                expect(dot.props.color, `width ${width}`).toBe(statusDotColors.working);
                expect(dot.props.isPulsing, `width ${width}`).toBe(true);
                const live = renderer.root.findAllByType('Pressable' as any)
                    .find((node: any) => String(node.props.accessibilityLabel).startsWith('Main thread:'));
                // And still no cap over the live segment. The zone's share is
                // what holds it, measured rather than assumed to be 45%.
                expect(live.props.style({ pressed: false }).maxWidth, `width ${width}`).toBeUndefined();
            }
        } finally {
            screen.width = 390;
            vi.useRealTimers();
        }
    });

    it('gives up the clock and then the task badge, and never the tally', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            // The widest row there is: six workers, a task list, the account
            // and the ring. The give-way order says what goes, in what order,
            // and the tally Clay centred is last of everything.
            screen.width = 393;
            const wide = line(row({ sessionId: 'photographedWithTasks', contextUsage: context }));
            expect(wide).toContain('1/3 tasks');
            expect(wide).toContain('51.6k');
            expect(wide.join(' ')).not.toContain('4m 20s');

            screen.width = 320;
            const narrow = line(row({ sessionId: 'photographedWithTasks', contextUsage: context }));
            expect(narrow.join(' ')).not.toContain('1/3 tasks');
            expect(narrow).toContain('51.6k');
            expect(narrow).toContain('jamrizzi');
        } finally {
            screen.width = 390;
            vi.useRealTimers();
        }
    });

    it('folds the context percent onto its ring while the main thread works, and a tap unfolds it', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            // Idle with no account taking the width, the percent is on the
            // row as before (DROVE-138 folds it when there is one).
            const idle = resolveUsageStrip({
                usageLimits: { capturedAt: 1, windows: [{ id: 'seven_day', utilization: 77, resetsAt: sep5 }] },
                droverUsage: null,
                showRemaining: false,
                });
            expect(line(row({
                contextUsage: context,
                weekPercent: idle.weekPercent,
                usageBarGroups: idle.usageBarGroups,
            }))).toContain('46% context');
            // Working, the ring carries it alone: the live token count is the
            // cost readout at that moment, and the row has to fit.
            const renderer = row({ sessionId: 'busy', contextUsage: context });
            expect(line(renderer)).not.toContain('46% context');
            expect(renderer.root.findAllByType('Svg' as any)).toHaveLength(1);
            act(() => {
                segment(renderer, 'Context').props.onPress();
            });
            expect(line(renderer)).toContain('84.0k of 200.0k context, compacts near 184.0k');
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
            const working = segment(renderer, 'Main thread: working 1m 2s, 251.2k tokens across main and agents, 1 agent');
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
            act(() => {
                segment(renderer, 'Main thread: working 1m 2s, 251.2k tokens across main and agents, 1 agent').props.onPress();
            });
            expect([agents().props.open, usage().props.open]).toEqual([true, false]);
            act(() => {
                segment(renderer, 'Quota, jamrizzi 77%').props.onPress();
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
describe('the token tally on the strip (DROVE-184)', () => {
    /**
     * Clay: "where's my damn token counter showing tally of all tokens used
     * across main agent and all subagents". The row drew `main.tokens`, the
     * MAIN transcript alone, so a night of nine agents at 200k each read as
     * 51.6k.
     */
    it('draws main plus every subagent in the row\'s one token slot', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const text = line(row({ sessionId: 'tallied' })).join(' ');
            expect(text).toContain('1.9M');
            // The main-only number is no longer what the row says.
            expect(text).not.toContain('51.6k');
        } finally {
            vi.useRealTimers();
        }
    });

    it('adds no term to the line: same slot, at 320, 375 and 393', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            for (const width of [320, 375, 393]) {
                screen.width = width;
                const text = line(row({ sessionId: 'tallied' }));
                // The tally is the CENTRE zone now and last on the give-way
                // order, so it survives every width; nothing has crowded it
                // out and the strip has gained no term (DROVE-184).
                expect(text, `width ${width}`).toContain('1.9M');
                expect(text, `width ${width}`).toContain('9');
            }
        } finally {
            screen.width = 390;
            vi.useRealTimers();
        }
    });

    it('still shows the spend once the fan-out has outlived the turn', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const renderer = row({ sessionId: 'talliedAgentsOnly' });
            const text = line(renderer);
            // No clock and no working word, because the MAIN thread is idle
            // and the dot has to stay honest (DROVE-155). The number is there
            // anyway, which is the whole point: this is the state Clay was
            // looking at when he asked where it was.
            expect(text.join(' ')).toContain('1.8M');
            expect(text).not.toContain('working');
            expect(renderer.root.findByType('StatusDot' as any).props.color)
                .toBe(statusDotColors.connected);
        } finally {
            vi.useRealTimers();
        }
    });

    it('tells a screen reader the number is a total, not the main thread\'s', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const live = row({ sessionId: 'tallied' }).root.findAllByType('Pressable' as any)
                .find((node: any) => String(node.props.accessibilityLabel).startsWith('Main thread:'));
            expect(live.props.accessibilityLabel).toContain('1.9M tokens across main and agents');
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the main-only number on a CLI too old to publish a tally', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const text = line(row({ sessionId: 'photographed' })).join(' ');
            expect(text).toContain('4m 20s');
            expect(text).toContain('51.6k');
        } finally {
            vi.useRealTimers();
        }
    });
});

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
            expect(dot.props.color).toBe(statusDotColors.connected);
            expect(dot.props.isPulsing).toBe(false);
            // The agents still say how many they are, and nothing else.
            expect(line(renderer)).toEqual(['2', 'jamrizzi', '23%']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('is the connection colour on an idle session', () => {
        expect(row().root.findByType('StatusDot' as any).props.color)
            .toBe(statusDotColors.connected);
    });

    /**
     * DROVE-231's table, on the mounted row. `statusDotState.spec.ts` proves
     * the thresholds; this proves the strip actually paints them.
     */
    it('goes yellow the moment the session drops, and red once it has been gone', () => {
        vi.useFakeTimers();
        try {
            sessions.dropped = { metadata: { liveStatus: null }, presence: now, activeAt: now };
            vi.setSystemTime(now + 30_000);
            expect(row({
                sessionId: 'dropped',
                connectionStatus: { text: 'last seen 30s ago', dotColor: '#999', state: 'disconnected' },
            }).root.findByType('StatusDot' as any).props.color)
                .toBe(statusDotColors.recentlyDisconnected);
            vi.setSystemTime(now + 300_000);
            expect(row({
                sessionId: 'dropped',
                connectionStatus: { text: 'last seen 5m ago', dotColor: '#999', state: 'disconnected' },
            }).root.findByType('StatusDot' as any).props.color)
                .toBe(statusDotColors.disconnected);
        } finally {
            vi.useRealTimers();
        }
    });

    it('goes purple and blinks while the context is at the compaction point', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            // The main thread working, no tool under it, and the context at
            // the point the compaction pass fires. All three, or it is not
            // called compacting (statusDotState.ts).
            const dot = row({
                sessionId: 'photographed',
                contextUsage: { contextSize: 190_000, contextWindow: 200_000 },
            }).root.findByType('StatusDot' as any);
            expect(dot.props.color).toBe(statusDotColors.compacting);
            expect(dot.props.isPulsing).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stays blue, not purple, when a TOOL is what is running at the same context', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            sessions.toolingFull = {
                metadata: {
                    liveStatus: {
                        at: now,
                        turnStartedAt: now - 61_000,
                        main: { startedAt: now - 61_000, tokens: 251_200 },
                        tool: { id: 't1', name: 'Bash', startedAt: now - 5_000 },
                    },
                },
            };
            expect(row({
                sessionId: 'toolingFull',
                contextUsage: { contextSize: 190_000, contextWindow: 200_000 },
            }).root.findByType('StatusDot' as any).props.color)
                .toBe(statusDotColors.working);
        } finally {
            vi.useRealTimers();
        }
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
            expect(line(renderer)).toEqual(['1m 2s', '251.2k', 'jamrizzi', '23%']);
            // The CLI writes an explicit null the moment the turn ends.
            sessions.turning.metadata.liveStatus = null;
            act(() => {
                vi.advanceTimersByTime(1_000);
            });
            expect(line(renderer)).toEqual(['jamrizzi', '23%']);
            expect(renderer.root.findByType('StatusDot' as any).props.color)
                .toBe(statusDotColors.connected);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops trusting a snapshot the CLI stopped refreshing, instead of ticking on forever', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 200_000);
        try {
            const renderer = row({ sessionId: 'busy' });
            expect(line(renderer)).toEqual(['jamrizzi', '23%']);
            expect(renderer.root.findByType('StatusDot' as any).props.color)
                .toBe(statusDotColors.connected);
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
            segment(renderer, 'Quota, jamrizzi 77%').props.onPress();
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
        const strip = resolveUsageStrip({ usageLimits: null, droverUsage: null, showRemaining: false });
        const renderer = row({
            connectionStatus: undefined,
            weekPercent: strip.weekPercent,
            usageBarGroups: strip.usageBarGroups,
        });
        expect(renderer.toJSON()).toBeNull();
    });

    it('puts a remote session\'s week figure on the row with no context gauge (DROVE-194)', () => {
        // THE REGRESSION, and the spec that used to pin it the other way up.
        // A remote session's windows come from `agentState.usageLimits`, and
        // the week figure was withheld unless the context gauge was already
        // drawn. Since DROVE-138 the ACCOUNT is drawn inside the quota
        // segment, DROVE-138 also took the word `online` off the row and
        // DROVE-178 took the model off, so withholding the figure left the
        // strip with nothing in it but a 7pt dot. That was written down here
        // as the expected result, which is why three green suites shipped it.
        const strip = resolveUsageStrip({
            usageLimits: { capturedAt: 1, windows: [{ id: 'seven_day', utilization: 60, resetsAt: sep5 }] },
            droverUsage: null,
            showRemaining: false,
        });
        const renderer = row({
            weekPercent: strip.weekPercent,
            usageBarGroups: strip.usageBarGroups,
        });
        expect(line(renderer)).toEqual(['60% week']);
        expect(segment(renderer, 'Connected')).toBeTruthy();
    });

    it('names the account even before anything has measured a window', () => {
        // The other half of the same coupling: an account with no week
        // reading still says which account the session is spending.
        const renderer = row({ weekPercent: null });
        expect(line(renderer)).toEqual(['jamrizzi']);
    });
});

/**
 * The row Clay photographed on DROVE-194: composer in place, new colours, the
 * model back on the button row, and 34pt of black under it. It was not
 * off-screen and it was not clipped. It was in the strip, drawing nothing.
 */
describe('AgentInputStatusRow never draws an empty strip', () => {
    /** The three widths statusRowLayout pins: the narrow phone, Clay's, and the harness default. */
    const pinnedWidths = [320, 375, 393];
    sessions.oneTask = {
        metadata: { liveStatus: null },
        todos: [
            { content: 'Read the reducer', status: 'completed' },
            { content: 'Write the sheet', status: 'in_progress' },
            { content: 'Wire the wrist', status: 'pending' },
        ],
    };

    it('has the account and the quota on it at every pinned width, live session and all', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            for (const width of pinnedWidths) {
                screen.width = width;
                const renderer = row({ sessionId: 'busy' });
                const text = line(renderer);
                expect(text, `width ${width}`).toContain('jamrizzi');
                expect(text, `width ${width}`).toContain('23%');
                // The live segment is on it too, whichever way the tool name folded.
                expect(text.some((part) => part.includes('1m 2s')), `width ${width}`).toBe(true);
                // And it is visible, not a box with nothing painted in it.
                expect(renderer.root.findByType('AnimatedFade' as any).props.visible, `width ${width}`)
                    .toBe(true);
                // The dot is the main thread's blue while it works; what
                // matters here is that one is painted at all.
                expect(renderer.root.findByType('StatusDot' as any).props.color, `width ${width}`)
                    .toBeTruthy();
            }
        } finally {
            screen.width = 390;
            vi.useRealTimers();
        }
    });

    it('keeps every segment that has content, asked one segment at a time', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            const empty = { weekPercent: null, usageBarGroups: [] } as Partial<StatusRowProps>;
            // Each row below carries exactly ONE thing. None may come back null,
            // and none may come back as a strip with no text on it.
            const only: [string, Partial<StatusRowProps>, string][] = [
                ['the live turn', { ...empty, sessionId: 'busy' }, '1m 2s'],
                ['the task list', { ...empty, sessionId: 'oneTask' }, '1/3 tasks'],
                ['the account and quota', {}, 'jamrizzi'],
                ['the account alone', { weekPercent: null }, 'jamrizzi'],
                ['the context gauge', { ...empty, contextUsage: context }, '46% context'],
            ];
            for (const [what, props, expected] of only) {
                const renderer = row(props);
                expect(renderer.toJSON(), what).not.toBeNull();
                expect(line(renderer).join(' '), what).toContain(expected);
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('collapses only when the row really has nothing, dot included', () => {
        const renderer = row({
            connectionStatus: undefined,
            weekPercent: null,
            usageBarGroups: [],
            contextUsage: null,
        });
        expect(renderer.toJSON()).toBeNull();
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
        // DROVE-138 took `online` off the row (the dot's colour says it) and
        // put the model on, with the account heading the quota.
        expect(line(renderer)).toEqual(['1/3 tasks', 'jamrizzi', '23%']);

        const sheet = () => renderer.root.findByType('SessionTasksSheet' as any);
        expect(sheet().props.open).toBe(false);
        const segment = renderer.root.findAllByType('Pressable' as any)
            .find((node: any) => node.props.accessibilityLabel === '1 of 3 done');
        act(() => segment!.props.onPress());
        expect(sheet().props.open).toBe(true);
    });

    it('shows no segment at all for a session that never kept a list', () => {
        const renderer = row({ sessionId: 'idle' });
        expect(line(renderer)).toEqual(['jamrizzi', '23%']);
    });

    it('counts against the width, and the badge outlives the clock (DROVE-167, DROVE-231)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(now + 1_000);
        try {
            sessions.busyWithTasks = {
                ...sessions.busy,
                todos: [
                    { content: 'Read the reducer', status: 'completed' },
                    { content: 'Write the sheet', status: 'in_progress' },
                    { content: 'Wire the wrist', status: 'pending' },
                ],
            };
            // Wide enough for everything: the clock and the workers on the
            // left with the badge, the tally centred, the account right.
            for (const width of [430, 500]) {
                screen.width = width;
                expect(line(row({ sessionId: 'busyWithTasks' })), String(width))
                    .toEqual(['1m 2s', '1', '1/3 tasks', '251.2k', 'jamrizzi', '23%']);
            }
            // THE LEFT ZONE IS A HALF OF WHAT THE CENTRE LEAVES, not the whole
            // line, so the clock goes first on a phone. The badge stays: Clay
            // has asked for the task list by name three times and the badge is
            // the only tap that opens it (STATUS_ROW_GIVE_WAY).
            for (const width of [393, 375]) {
                screen.width = width;
                expect(line(row({ sessionId: 'busyWithTasks' })), String(width))
                    .toEqual(['1', '1/3 tasks', '251.2k', 'jamrizzi', '23%']);
            }
            // At 320 the badge goes too, and what is left is exactly the three
            // zones Clay named: the dot and the workers, the tally, the
            // account and its percentage.
            screen.width = 320;
            expect(line(row({ sessionId: 'busyWithTasks' })))
                .toEqual(['1', '251.2k', 'jamrizzi', '23%']);
        } finally {
            screen.width = 390;
            vi.useRealTimers();
        }
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
        // Ask for the quota by name rather than by index: DROVE-138 removed the
        // connection segment and added the model, so a position is not stable.
        const week = renderer.root.findAllByType('Pressable' as any)
            .find((n: any) => typeof n.props.accessibilityLabel === 'string'
                && n.props.accessibilityLabel.includes('%'));
        act(() => week!.props.onPress());
        expect(renderer.root.findByType('SessionTasksSheet' as any).props.open).toBe(false);
        expect(renderer.root.findByType('UsageAccountBarsSheet' as any).props.open).toBe(true);
    });
});

/**
 * The add row's target (DROVE-208).
 *
 * The sheet draws the row; only this component knows the session, so only this
 * component can say which machine. An account is a login on a machine and a
 * session runs on exactly one, so the answer is the session's machine and
 * there is nothing to ask. What is pinned here is that it is THAT machine and
 * not a guess, and that a session with no machine gets no row.
 */
describe('adding an account from the quota sheet (DROVE-208)', () => {
    const strip = () => paneStrip(true);

    it('targets the machine the session runs on, and names it', () => {
        pushed.length = 0;
        const bars = strip();
        const renderer = row({
            sessionId: 'onDrogon',
            weekPercent: bars.weekPercent,
            usageBarGroups: bars.usageBarGroups,
        });
        const add = renderer.root.findByType('UsageAccountBarsSheet' as any).props.addAccount;
        expect(add.machineName).toBe('drogon');
        act(() => add.onPress());
        expect(pushed).toEqual(['/settings/accounts?addMachineId=m-drogon']);
    });

    it('falls back to the machine id when the store has no name for it yet', () => {
        const bars = strip();
        const renderer = row({
            sessionId: 'onUnnamedMachine',
            weekPercent: bars.weekPercent,
            usageBarGroups: bars.usageBarGroups,
        });
        expect(renderer.root.findByType('UsageAccountBarsSheet' as any).props.addAccount.machineName)
            .toBe('m-unname');
    });

    it('offers no add row on a session with no machine stamped on it', () => {
        // Nothing true to put on it: an add row that cannot say where it is
        // adding is the flat pool DROVE-165 refused.
        const bars = strip();
        const renderer = row({
            sessionId: 'busy',
            weekPercent: bars.weekPercent,
            usageBarGroups: bars.usageBarGroups,
        });
        expect(renderer.root.findByType('UsageAccountBarsSheet' as any).props.addAccount).toBeNull();
    });

    it('offers no add row on a preview with no session at all', () => {
        const bars = strip();
        const renderer = row({
            sessionId: undefined,
            weekPercent: bars.weekPercent,
            usageBarGroups: bars.usageBarGroups,
        });
        expect(renderer.root.findByType('UsageAccountBarsSheet' as any).props.addAccount).toBeNull();
    });
});
